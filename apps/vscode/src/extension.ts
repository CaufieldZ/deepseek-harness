/**
 * Extension entry: binds the vscode surfaces (settings, secret storage,
 * status bar, commands) to the child lifecycle and the API client.
 */
import * as vscode from 'vscode'
import { ChildManager, type ChildFacts } from './child-manager.ts'
import { NodeApiClient } from './api/node-client.ts'
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

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('dsh')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  const store = new ApiKeyStore(context.secrets)

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
  context.subscriptions.push(setApiKeyCommand, importKeyCommand, restartCommand, statusBar, channel)

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
  statusBar = undefined
  channel = undefined
}
