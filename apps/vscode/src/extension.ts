/**
 * Extension entry: binds the vscode surfaces (settings, secret storage,
 * status bar, commands, session tree, panels) to the child lifecycle and the
 * API client.
 */
import * as vscode from 'vscode'
import { ChildManager, type ChildFacts } from './child-manager.ts'
import { NodeApiClient } from './api/node-client.ts'
import { registerSessionCommands } from './commands.ts'
import { SessionPanelManager } from './panels/session-panel.ts'
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
let channel: vscode.OutputChannel | undefined
let apiKey: string | undefined
let describePending = false
let panels: SessionPanelManager | undefined
let tree: SessionTreeProvider | undefined

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

/** Build a fresh manager+client pair from the current settings and key, replacing any live one. */
function configure(): void {
  const settings = parseSettings(vscode.workspace.getConfiguration('dsh'))
  const split = buildChildCommand(settings)
  manager?.stop()
  manager = new ChildManager({
    command: split.command,
    args: split.args,
    env: buildChildEnv(settings, apiKey ?? ''),
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
  manager.start()
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
  const store = new ApiKeyStore(context.secrets)
  syncContextKeys()
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) syncContextKeys()
  }))

  tree = new SessionTreeProvider(treeSource())
  const treeView = vscode.window.createTreeView('dsh.sessions', { treeDataProvider: tree })
  panels = new SessionPanelManager({ childBaseUrl: () => {
    const url = manager?.currentBaseUrl
    if (url === undefined) throw new Error('dsh child is not ready')
    return url
  }, extensionUri: context.extensionUri })

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
  registerSessionCommands(context, {
    client: () => client,
    panels: () => panels,
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  })
  context.subscriptions.push(
    setApiKeyCommand,
    importKeyCommand,
    restartCommand,
    treeView,
    tree,
    statusBar,
    channel,
    vscode.window.registerWebviewPanelSerializer('dsh.session', panels),
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
  manager?.stop()
  manager = undefined
  client = undefined
  panels = undefined
  tree = undefined
  statusBar = undefined
  channel = undefined
}
