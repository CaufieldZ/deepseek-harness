/**
 * Activity-bar session tree: lists the child's sessions through the host
 * client and stays live from the host/mux downlinks (add/remove/status frames
 * and title projections), reconnecting when the child restarts on a new port.
 */
import * as vscode from 'vscode'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
// Types-only: pulls the `title` projection key's declaration merge into scope.
import type {} from '@deepseek-ai/dsh-session-title/types'

/** Narrow client surface the tree renders from; extension.ts adapts NodeApiClient. */
export interface SessionTreeSource {
  listSessions(): Promise<SessionSummary[]>
  hostFrames(signal: AbortSignal): AsyncIterable<unknown>
  muxFrames(signal: AbortSignal): AsyncIterable<unknown>
}

/** Debounce window for tree refreshes after downlink frame storms. */
const REFRESH_DEBOUNCE_MS = 200

/** Reconnect delay after a downlink stream dies (child restart). */
const RECONNECT_DELAY_MS = 1_000

function titleOf(summary: SessionSummary): string {
  const projections: Partial<SessionProjectionMap> | undefined = summary.projections?.values
  const title = projections?.title
  if (title !== null && title !== undefined && title !== '') return title
  return summary.blank ? 'New session' : 'Session'
}

function relativeTime(updatedAt: number): string {
  const ageMs = Date.now() - updatedAt
  if (ageMs < 60_000) return 'just now'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  return `${String(Math.floor(hours / 24))}d ago`
}

/** Activity-bar provider for the harness sessions. */
export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event
  private refreshTimer: NodeJS.Timeout | undefined
  private started = false
  private disposedFlag = false
  private resolveDisposed: () => void = () => {}
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve })
  private sessions: SessionSummary[] = []

  constructor(private readonly source: SessionTreeSource) {}

  /** Begin the downlink pumps; call once the child is ready. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.pumpDownlinks()
    this.scheduleRefresh()
  }

  dispose(): void {
    this.disposedFlag = true
    this.resolveDisposed()
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    this.sessions = await this.source.listSessions()
    const sorted = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    return sorted.map(summary => this.toItem(summary))
  }

  private toItem(summary: SessionSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(titleOf(summary), vscode.TreeItemCollapsibleState.None)
    item.id = summary.sessionId
    item.description = relativeTime(summary.updatedAt)
    item.tooltip = summary.cwd ?? summary.sessionId
    item.contextValue = 'dsh.session'
    if (summary.running) item.iconPath = new vscode.ThemeIcon('sync~spin')
    item.command = { command: 'dsh.openSession', title: 'Open session', arguments: [summary.sessionId] }
    return item
  }

  /** Both downlinks drive a debounced refresh; each stream reconnects on death. */
  private async pumpDownlinks(): Promise<void> {
    await Promise.all([
      this.pump(signal => this.source.hostFrames(signal)),
      this.pump(signal => this.source.muxFrames(signal)),
    ])
  }

  private async pump(open: (signal: AbortSignal) => AsyncIterable<unknown>): Promise<void> {
    while (!this.disposedFlag) {
      const controller = new AbortController()
      void this.disposed.then(() => { controller.abort() })
      try {
        for await (const _frame of open(controller.signal)) {
          this.scheduleRefresh()
        }
      } catch {
        // Stream death (child restart or transport error); reconnect below.
      }
      // The reconnect delay races disposal: a dispose during iteration exits
      // here instead of sleeping one delay before the loop condition catches it.
      const disposed = await Promise.race([
        this.disposed.then(() => true),
        new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, RECONNECT_DELAY_MS) }),
      ])
      if (disposed) return
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.onDidChangeEmitter.fire()
    }, REFRESH_DEBOUNCE_MS)
  }
}
