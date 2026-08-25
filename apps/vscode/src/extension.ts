/**
 * Extension entry: binds the vscode surfaces (settings, secret storage,
 * status bar, commands, session tree, panels) to the child lifecycle and the
 * API client.
 */
import * as vscode from 'vscode'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ChildManager, type ChildFacts } from './child-manager.ts'
import { NodeApiClient } from './api/node-client.ts'
import { registerSessionCommands } from './commands.ts'
import { buildFeed, VscodeContextFeed, type FeedEditor } from './context-feed.ts'
import {
  applyHunks, handleDiffAction, PendingDiffs, revertHunks, warnSkipped,
} from './diff-actions.ts'
import { SessionPanelManager } from './panels/session-panel.ts'
import {
  applyPreset, PERMISSION_PRESETS, PRESET_LABELS, presetOfEvent, toggledPreset,
  type PermissionClient, type PermissionPreset,
} from './permission-mode.ts'
import { SessionTreeProvider, type SessionTreeSource } from './views/session-tree.ts'
import {
  API_KEY_STORAGE_KEY,
  buildChildCommand,
  buildChildEnv,
  extractAcpApiKey,
  parseSettings,
} from './settings.ts'

/** Secret-storage accessor with the one fixed key this extension owns. */
class ApiKeyStore {
  constructor(private readonly storage: vscode.SecretStorage) {}

  get(): Thenable<string | undefined> {
    return this.storage.get(API_KEY_STORAGE_KEY)
  }

  set(key: string): Thenable<void> {
    return this.storage.store(API_KEY_STORAGE_KEY, key)
  }
}

let manager: ChildManager | undefined
let client: NodeApiClient | undefined
let statusBar: vscode.StatusBarItem | undefined
let modeBadge: vscode.StatusBarItem | undefined
let channel: vscode.OutputChannel | undefined
let apiKey: string | undefined
let describePending = false
let panels: SessionPanelManager | undefined
let tree: SessionTreeProvider | undefined
let feed: VscodeContextFeed | undefined
/** The latest known preset (initial setting, then the newest mux mode event). */
let modePreset: PermissionPreset = 'read-only'
let modeAbort: AbortController | undefined

/** The tree source reads the current client per call, so child restarts swap cleanly. */
function treeSource(): SessionTreeSource {
  const current = (): NodeApiClient => {
    if (client === undefined) throw new Error('dsh child is not ready')
    return client
  }
  return {
    listSessions: async () => {
      if (client === undefined) return []
      const response = await client.sessions.list({})
      return response.result.ok ? response.result.value.items : []
    },
    hostFrames: signal => current().events.host({}, signal),
    muxFrames: signal => current().events.mux({}, signal),
  }
}

/** The client face of the permission apply path (settings default + per-session command). */
function permissionClient(): PermissionClient {
  return {
    setDefaultPreset: async (preset) => {
      if (client === undefined) throw new Error('dsh child is not ready')
      const response = await client.settings.mutate({ ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: preset }] })
      if (!response.result.ok) throw new Error('the child rejected the permission default')
    },
    executeCommand: async (sessionId, line) => {
      if (client === undefined) throw new Error('dsh child is not ready')
      await client.rpcCall('commands/execute', { sessionId, line, images: [] })
    },
  }
}

/** Reflect the current preset on the status-bar badge. */
function renderModeBadge(): void {
  if (modeBadge === undefined) return
  const { icon, label } = PRESET_LABELS[modePreset]
  modeBadge.text = `${icon} dsh: ${label}`
  modeBadge.tooltip = 'dsh permission mode. Click to toggle Auto/Manual; "dsh: Set Permission Mode" offers Full Access.'
}

/** Follow the mux stream's mode events and keep the badge current. */
function startModeTracker(): void {
  modeAbort?.abort()
  if (client === undefined) return
  const controller = new AbortController()
  modeAbort = controller
  void (async () => {
    try {
      for await (const frame of client.events.mux({}, controller.signal)) {
        if (frame.payload.type !== 'session/event') continue
        const preset = presetOfEvent(frame.payload.event)
        if (preset === undefined) continue
        modePreset = preset
        renderModeBadge()
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        channel?.appendLine(`[dsh-vscode] mode tracker ended: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
}

/** Pin the new-session permission default once the child is ready. */
async function applyInitialPreset(): Promise<void> {
  try {
    await permissionClient().setDefaultPreset(modePreset)
  } catch (error) {
    channel?.appendLine(`[dsh-vscode] initial permission preset failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Build a fresh manager+client+feed set from the current settings and key, replacing any live one. */
function configure(): void {
  const settings = parseSettings(vscode.workspace.getConfiguration('dsh'))
  const split = buildChildCommand(settings)
  manager?.stop()
  feed?.dispose()
  // The vscode profile resolves hook configs from the launch cwd; the
  // workspace root keeps `.claude/settings.json` discovery CC-compatible.
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  manager = new ChildManager({
    command: split.command,
    args: split.args,
    env: buildChildEnv(settings, apiKey ?? ''),
    ...(workspaceCwd === undefined ? {} : { cwd: workspaceCwd }),
    spawnTimeoutMs: settings.spawnTimeoutMs,
    killGraceMs: 5_000,
    restartBackoffMinMs: 500,
    restartBackoffMaxMs: 10_000,
    onFacts: renderFacts,
    onStderrLine: line => channel?.appendLine(`[child] ${line}`),
  })
  client = new NodeApiClient(() => {
    const url = manager?.currentBaseUrl
    if (url === undefined) throw new Error('dsh child is not ready')
    return url
  })
  // The feed home must match the child's home exactly: the child resolves its
  // own default (~/.dsh) when `dsh.home` is empty, so read through the same
  // resolver with a blank environment rather than the extension host's env.
  feed = new VscodeContextFeed({ home: resolveDshHome(settings.home, {}) })
  feed.schedule(captureEditorFeed())
  // The badge starts from the initial-permission setting; the mux tracker and
  // the ready-time default pin refine it once the child answers.
  modePreset = settings.initialPreset
  renderModeBadge()
  manager.start()
}

/** Snapshot the live editor surface into one feed document. */
function captureEditorFeed(): ReturnType<typeof buildFeed> {
  const toFeedEditor = (editor: vscode.TextEditor | undefined): FeedEditor | undefined => {
    if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined
    return {
      path: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      cursor: { line: editor.selection.active.line + 1, character: editor.selection.active.character + 1 },
      selection: {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: editor.document.getText(editor.selection),
      },
    }
  }
  return buildFeed(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    toFeedEditor(vscode.window.activeTextEditor),
    vscode.window.visibleTextEditors.map(toFeedEditor).filter((editor): editor is FeedEditor => editor !== undefined),
  )
}

/** Render child facts into the status bar and request the host version once ready. */
function renderFacts(facts: ChildFacts): void {
  if (statusBar === undefined) return
  switch (facts.state) {
    case 'starting':
      statusBar.text = '$(sync~spin) dsh: starting…'
      statusBar.tooltip = 'dsh harness child is booting'
      break
    case 'restarting':
      statusBar.text = '$(sync~spin) dsh: restarting…'
      statusBar.tooltip = facts.lastError ?? 'dsh harness child crashed; retrying'
      break
    case 'ready': {
      statusBar.text = '$(pass) dsh'
      statusBar.tooltip = String(facts.baseUrl ?? '')
      tree?.start()
      void describeOnce()
      startModeTracker()
      void applyInitialPreset()
      break
    }
    case 'stopped':
      statusBar.text = '$(error) dsh stopped'
      statusBar.tooltip = facts.lastError ?? 'dsh harness child is stopped'
      break
  }
  statusBar.show()
}

/** Fetch host.describe once per ready generation for the version badge. */
async function describeOnce(): Promise<void> {
  if (describePending || client === undefined) return
  describePending = true
  try {
    const response = await client.host.describe({})
    if (response.result.ok && statusBar !== undefined) {
      statusBar.text = `$(pass) dsh ${response.result.value.version}`
    }
  } catch (error) {
    channel?.appendLine(`[dsh-vscode] host.describe failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    describePending = false
  }
}

/** Prompt for the DeepSeek API key and persist it; undefined when the user cancels. */
async function promptForApiKey(store: ApiKeyStore): Promise<string | undefined> {
  const choice = await vscode.window.showInformationMessage('dsh needs a DeepSeek API key', 'Set Key')
  if (choice !== 'Set Key') return undefined
  const key = await vscode.window.showInputBox({
    title: 'DeepSeek API Key',
    prompt: 'Stored in VS Code secret storage and passed to the harness child environment.',
    password: true,
    ignoreFocusOut: true,
  })
  if (key === undefined || key === '') return undefined
  await store.set(key)
  return key
}

/** Mirror the shortcut switches into when-clause context keys. */
function syncContextKeys(): void {
  const config = vscode.workspace.getConfiguration('dsh')
  void vscode.commands.executeCommand('setContext', 'dsh.enableNewConversationShortcut', config.get<boolean>('enableNewConversationShortcut', false))
  void vscode.commands.executeCommand('setContext', 'dsh.enableReopenClosedSessionShortcut', config.get<boolean>('enableReopenClosedSessionShortcut', true))
}

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('dsh')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  modeBadge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101)
  renderModeBadge()
  modeBadge.show()
  const store = new ApiKeyStore(context.secrets)
  syncContextKeys()
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) syncContextKeys()
  }))

  // Editor-state churn re-snapshots the IDE-context feed; the feed itself is
  // rebuilt per child generation in configure(), where the home is resolved.
  const scheduleEditorFeed = (): void => { feed?.schedule(captureEditorFeed()) }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => { scheduleEditorFeed() }),
    vscode.window.onDidChangeTextEditorSelection(() => { scheduleEditorFeed() }),
    vscode.window.onDidChangeVisibleTextEditors(() => { scheduleEditorFeed() }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { scheduleEditorFeed() }),
  )

  tree = new SessionTreeProvider(treeSource())
  const treeView = vscode.window.createTreeView('dsh.sessions', { treeDataProvider: tree })
  const pending = new PendingDiffs()
  // The editor/title Accept/Reject menu gates on whether the active file has
  // a pending change; recompute on every editor switch and registry mutation.
  const pendingContext = (): void => {
    const editor = vscode.window.activeTextEditor
    const active = editor !== undefined
      && editor.document.uri.scheme === 'file'
      && pending.has(editor.document.uri.fsPath)
    void vscode.commands.executeCommand('setContext', 'dsh.pendingDiff', active)
  }
  const pendingPath = (): string | undefined => {
    const editor = vscode.window.activeTextEditor
    return editor !== undefined && editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined
  }
  const acceptDiffCommand = vscode.commands.registerCommand('dsh.acceptDiff', async () => {
    const path = pendingPath()
    if (path === undefined) return
    const entry = pending.entry(path)
    if (entry === undefined) return
    const outcome = await applyHunks([entry.hunk], undefined)
    // A skipped file keeps its pending entry so the menu can retry it.
    for (const applied of outcome.applied) pending.clear(applied)
    pendingContext()
    warnSkipped(outcome)
  })
  const rejectDiffCommand = vscode.commands.registerCommand('dsh.rejectDiff', async () => {
    const path = pendingPath()
    if (path === undefined) return
    const entry = pending.entry(path)
    if (entry === undefined) return
    const outcome = await revertHunks([entry.hunk], undefined)
    for (const applied of outcome.applied) pending.clear(applied)
    pendingContext()
    warnSkipped(outcome)
  })
  panels = new SessionPanelManager({ childBaseUrl: () => {
    const url = manager?.currentBaseUrl
    if (url === undefined) throw new Error('dsh child is not ready')
    return url
  }, extensionUri: context.extensionUri, diffActions: {
    handle: message => handleDiffAction(message, { pending, onChanged: pendingContext }),
  } })

  const setApiKeyCommand = vscode.commands.registerCommand('dsh.setApiKey', async () => {
    const key = await promptForApiKey(store)
    if (key === undefined) return
    apiKey = key
    configure()
  })
  const importKeyCommand = vscode.commands.registerCommand('dsh.importApiKeyFromSettings', async () => {
    const acpAgents = vscode.workspace.getConfiguration('acp').get('agents')
    const key = extractAcpApiKey(acpAgents)
    if (key === undefined) {
      void vscode.window.showWarningMessage('No DEEPSEEK_API_KEY found in acp.agents settings')
      return
    }
    await store.set(key)
    apiKey = key
    configure()
    void vscode.window.showInformationMessage('dsh: DeepSeek API key imported into secret storage')
  })
  const restartCommand = vscode.commands.registerCommand('dsh.restartChild', () => {
    configure()
  })
  const toggleAutomodeCommand = vscode.commands.registerCommand('dsh.toggleAutomode', async () => {
    const target = toggledPreset(modePreset)
    try {
      await applyPreset(permissionClient(), panels?.sessionIds() ?? [], target)
      modePreset = target
      renderModeBadge()
    } catch (error) {
      void vscode.window.showWarningMessage(`dsh: could not switch the permission mode: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const setPermissionModeCommand = vscode.commands.registerCommand('dsh.setPermissionMode', async () => {
    const picked = await vscode.window.showQuickPick(
      PERMISSION_PRESETS.map(preset => ({
        label: PRESET_LABELS[preset].label,
        detail: preset,
        ...(preset === 'danger-full-access' ? { description: 'no approval prompts' } : {}),
      })),
      { title: 'dsh: Permission Mode', placeHolder: 'Manual / Auto / Full Access' },
    )
    if (picked === undefined) return
    const preset = picked.detail
    try {
      await applyPreset(permissionClient(), panels?.sessionIds() ?? [], preset)
      modePreset = preset
      renderModeBadge()
    } catch (error) {
      void vscode.window.showWarningMessage(`dsh: could not set the permission mode: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const stopSessionCommand = vscode.commands.registerCommand('dsh.stopSession', async () => {
    const sessionId = panels?.currentSessionId()
    if (sessionId === undefined || client === undefined) return
    const response = await client.sessions.cancel({ sessionId: sessionId as SessionId })
    if (!response.result.ok) void vscode.window.showWarningMessage('dsh: could not stop the session')
  })
  registerSessionCommands(context, {
    client: () => client,
    panels: () => panels,
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  })
  context.subscriptions.push(
    setApiKeyCommand,
    importKeyCommand,
    restartCommand,
    acceptDiffCommand,
    rejectDiffCommand,
    toggleAutomodeCommand,
    setPermissionModeCommand,
    stopSessionCommand,
    treeView,
    tree,
    statusBar,
    modeBadge,
    channel,
    vscode.window.registerWebviewPanelSerializer('dsh.session', panels),
    vscode.window.onDidChangeActiveTextEditor(() => { pendingContext() }),
    { dispose: () => { panels?.dispose() } },
  )

  void (async () => {
    apiKey = await store.get()
    if (apiKey === undefined || apiKey === '') {
      const key = await promptForApiKey(store)
      apiKey = key
      if (apiKey === undefined || apiKey === '') {
        statusBar.text = '$(key) dsh: set API key'
        statusBar.tooltip = 'Run "dsh: Set DeepSeek API Key" to start the harness child'
        statusBar.show()
        return
      }
    }
    configure()
  })()
}

export function deactivate(): void {
  modeAbort?.abort()
  modeAbort = undefined
  manager?.stop()
  manager = undefined
  client = undefined
  feed?.dispose()
  feed = undefined
  panels = undefined
  tree = undefined
  statusBar = undefined
  modeBadge = undefined
  channel = undefined
}
