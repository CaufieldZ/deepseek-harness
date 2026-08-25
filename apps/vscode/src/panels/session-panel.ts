/**
 * One WebviewPanel per session: hosts the assembled client application with
 * the per-panel manifest and the HostBridge relay. Serializable state carries
 * the session id so window reload restores every panel; the closed-session
 * stack backs the reopen-closed-session command.
 */
import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'
import { HostBridge, type DiffActionsHandler } from '../bridge/host-bridge.ts'
import { composeGraph, loadCuratedBundles, queueFacadeText, type CuratedBundle } from '../manifest.ts'
import { buildPanelHtml } from './html.ts'

/** Bound of the recently-closed stack (Cmd+Shift+T walks it newest-first). */
const CLOSED_STACK_LIMIT = 20

export interface SessionPanelDeps {
  childBaseUrl: () => URL
  extensionUri: vscode.Uri
  /** Host-local diff-action executor every panel's bridge routes diff messages to. */
  diffActions: DiffActionsHandler
}

/** Panels + relays + the closed-session stack, with the reload serializer. */
export class SessionPanelManager implements vscode.WebviewPanelSerializer {
  private readonly panels = new Map<string, vscode.WebviewPanel>()
  private readonly bridges = new Map<string, HostBridge>()
  private readonly closedStack: string[] = []
  private bundles: readonly CuratedBundle[] | undefined
  private lastOpened: string | undefined

  constructor(private readonly deps: SessionPanelDeps) {}

  /** The open panel session ids, in open order (permission switches target them all). */
  sessionIds(): readonly string[] {
    return [...this.panels.keys()]
  }

  /** The most recently opened session id, the target of session-scoped host commands. */
  currentSessionId(): string | undefined {
    return this.lastOpened
  }

  /** Open (or reveal) the panel for one session. */
  open(sessionId: string): void {
    const existing = this.panels.get(sessionId)
    if (existing !== undefined) {
      existing.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel('dsh.session', 'dsh', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.localResourceRoots(),
    })
    this.panels.set(sessionId, panel)
    this.lastOpened = sessionId
    this.render(panel, sessionId)
    panel.onDidDispose(() => {
      this.bridges.get(sessionId)?.dispose()
      this.bridges.delete(sessionId)
      this.panels.delete(sessionId)
      this.closedStack.unshift(sessionId)
      if (this.closedStack.length > CLOSED_STACK_LIMIT) this.closedStack.pop()
    })
  }

  /** Reopen the most recently closed session, if any. */
  reopenClosed(): string | undefined {
    const sessionId = this.closedStack.shift()
    if (sessionId !== undefined) this.open(sessionId)
    return sessionId
  }

  /** Remove a session from the closed stack once reopened elsewhere. */
  forgetClosed(sessionId: string): void {
    const index = this.closedStack.indexOf(sessionId)
    if (index >= 0) this.closedStack.splice(index, 1)
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose()
    for (const bridge of this.bridges.values()) bridge.dispose()
    this.panels.clear()
    this.bridges.clear()
  }

  deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const sessionId = (state as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return Promise.resolve()
    // The restored panel keeps default webview options: re-apply the script
    // and resource grants before rendering, or the page boots without scripts.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.localResourceRoots(),
    }
    this.panels.set(sessionId, panel)
    this.render(panel, sessionId)
    panel.onDidDispose(() => {
      this.bridges.get(sessionId)?.dispose()
      this.bridges.delete(sessionId)
      this.panels.delete(sessionId)
    })
    return Promise.resolve()
  }

  private render(panel: vscode.WebviewPanel, sessionId: string): void {
    const bundles = this.loadBundles()
    const urlOf = (bundle: CuratedBundle): string => panel.webview.asWebviewUri(vscode.Uri.file(bundle.bundlePath)).toString()
    const graph = composeGraph(bundles, urlOf)
    const nonce = crypto.randomUUID()
    const assetsBase = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, 'webview-dist')).toString() + '/'
    const appHtml = readFileSync(vscode.Uri.joinPath(this.deps.extensionUri, 'webview-dist', 'index.html').fsPath, 'utf8')
    panel.webview.html = buildPanelHtml({
      appHtml,
      cspSource: panel.webview.cspSource,
      nonce,
      facadeScript: queueFacadeText(graph),
      bootJson: JSON.stringify(graph),
      sessionId,
      bundleSrcs: bundles.map(urlOf),
      assetsBase,
    })
    const bridge = new HostBridge({
      childBaseUrl: this.deps.childBaseUrl,
      diffActions: this.deps.diffActions,
      channel: {
        postMessage: (message) => { void panel.webview.postMessage(message) },
        onMessage: (listener) => {
          const subscription = panel.webview.onDidReceiveMessage((message) => { listener(message) })
          return () => { subscription.dispose() }
        },
      },
    })
    bridge.start()
    this.bridges.get(sessionId)?.dispose()
    this.bridges.set(sessionId, bridge)
    panel.title = 'dsh'
  }

  private localResourceRoots(): vscode.Uri[] {
    return [
      this.deps.extensionUri,
      // Dev-mode root: curated bundles live under the monorepo's packages/.
      vscode.Uri.joinPath(this.deps.extensionUri, '..', '..', '..'),
    ]
  }

  private loadBundles(): readonly CuratedBundle[] {
    this.bundles ??= loadCuratedBundles(vscode.Uri.joinPath(this.deps.extensionUri, 'webview-dist', 'shell-client.js').fsPath)
    return this.bundles
  }
}
