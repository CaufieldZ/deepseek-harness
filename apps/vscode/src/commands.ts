/**
 * Session command surface: new session (Cmd+N, setting-gated), open session,
 * and reopen the most recently closed session (Cmd+Shift+T). Sessions are
 * created with the workspace root as cwd so workspace instructions and hooks
 * resolve against the user's project.
 */
import * as vscode from 'vscode'
import type { NodeApiClient } from './api/node-client.ts'
import type { SessionPanelManager } from './panels/session-panel.ts'

export interface SessionCommandsDeps {
  client(): NodeApiClient | undefined
  panels(): SessionPanelManager | undefined
  workspaceRoot(): string | undefined
}

/** Register the session commands; returns the disposables for the context. */
export function registerSessionCommands(context: vscode.ExtensionContext, deps: SessionCommandsDeps): void {
  const newSession = vscode.commands.registerCommand('dsh.newSession', async () => {
    const client = deps.client()
    if (client === undefined) {
      void vscode.window.showWarningMessage('dsh: the harness child is not ready')
      return
    }
    const root = deps.workspaceRoot()
    const created = await client.sessions.create(root === undefined ? {} : { cwd: root })
    if (!created.result.ok) {
      void vscode.window.showErrorMessage('dsh: could not create a session')
      return
    }
    deps.panels()?.forgetClosed(created.result.value.sessionId)
    deps.panels()?.open(created.result.value.sessionId)
  })
  const openSession = vscode.commands.registerCommand('dsh.openSession', (sessionId: string) => {
    if (typeof sessionId !== 'string') return
    deps.panels()?.forgetClosed(sessionId)
    deps.panels()?.open(sessionId)
  })
  const reopenClosed = vscode.commands.registerCommand('dsh.reopenClosedSession', () => {
    const reopened = deps.panels()?.reopenClosed()
    if (reopened === undefined) void vscode.window.showInformationMessage('dsh: no closed session to reopen')
  })
  context.subscriptions.push(newSession, openSession, reopenClosed)
}
