/**
 * Webview shell plugin (client bundle in the closure-factory format): mounts
 * the diff-action surface and focuses the session named by the host-injected
 * __DSH_SESSION_ID__ global once the session list contains it. The runtime
 * throws for unknown ids, so the open waits for the list; panels without the
 * global boot into the ordinary session list.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyDiffActions, inject as injectDiffActions, name as diffActionsName } from './diff-actions.tsx'

interface SessionListSnapshot {
  phase: string
  byId: Record<string, unknown>
}

interface SessionsFace {
  list: { subscribe(listener: (state: SessionListSnapshot) => void): () => void }
  open(id: string): void
}

export const name = 'dsh-vscode-shell'
export const inject = ['sessions', 'slots', 'locale']

export function apply(ctx: Context): void {
  ctx.plugin({ name: diffActionsName, inject: injectDiffActions, apply: applyDiffActions })
  const sessions = ctx.sessions as unknown as SessionsFace
  const target = (globalThis as { __DSH_SESSION_ID__?: unknown }).__DSH_SESSION_ID__
  if (typeof target !== 'string' || target === '') return
  const unsubscribe = sessions.list.subscribe((state) => {
    if (state.phase !== 'ready' || state.byId[target] === undefined) return
    // Unsubscribe before open: open() mutates the list store synchronously,
    // and a still-subscribed listener would re-enter here on that update.
    unsubscribe()
    sessions.open(target)
  })
}
