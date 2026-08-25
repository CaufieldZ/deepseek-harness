/**
 * VSCode diff-action surface: the Apply/Reveal buttons registered into the
 * 'tool.call.diff-actions' hole ui-tool renders beside every diff-bearing
 * tool call, plus the plugin that mounts them with its own dictionary
 * namespace. Clicking posts host-local diff messages (present/apply/reveal)
 * through the transport global main.ts installed; they never reach the
 * harness child. React and the client primitives resolve through the module
 * loader's platform modules, so no second copy ships in the shell bundle.
 */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { DiffActionOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale, SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { DiffActionMessage, DiffHunkWire } from './protocol.ts'

/** Dictionary namespace of the shell's action copy. */
const NS = 'vscode'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    vscode: 'diffActions.apply' | 'diffActions.reveal'
  }
}

/** The shell's postMessage seam (main.ts); absent in a transport-less eval. */
interface TransportGlobal {
  postMessage(message: unknown): void
}

function transportGlobal(): TransportGlobal | undefined {
  return (globalThis as { __DSH_VSCODE_TRANSPORT__?: TransportGlobal }).__DSH_VSCODE_TRANSPORT__
}

/** Call ids that already registered their change in the host pending registry this page load. */
const presented = new Set<string>()

/** Assemble one diff message; cwd only joins when present (exact optional properties). */
function diffMessage(type: DiffActionMessage['type'], sessionId: SessionIdOf, cwd: string | undefined, hunks: DiffHunkWire[]): DiffActionMessage {
  return { type, sessionId, hunks, ...(cwd === undefined ? {} : { cwd }) }
}

/**
 * The host-local actions one diff-bearing call exposes: Apply writes the
 * change through the workspace API, Reveal opens the old→new preview, and the
 * mount itself registers the change as pending (the editor/title Accept/
 * Reject menu). Renders nothing without the transport seam (headless evals).
 * @param props - the diff-action owner share plus the framework seats.
 * @returns the action row, or null without a transport.
 */
function DiffActions(props: DiffActionOwnerProps & PropsLocale<typeof NS> & { sessionId: SessionIdOf }) {
  const { callId, cwd, diffs, sessionId, t } = props
  useEffect(() => {
    const transport = transportGlobal()
    if (transport === undefined || presented.has(callId)) return
    presented.add(callId)
    transport.postMessage(diffMessage('diff-present', sessionId, cwd, diffs))
  }, [callId, cwd, diffs, sessionId])
  if (transportGlobal() === undefined) return null
  const send = (type: DiffActionMessage['type']): void => {
    transportGlobal()?.postMessage(diffMessage(type, sessionId, cwd, diffs))
  }
  return (
    <div style={{ display: 'flex', gap: 8, margin: '6px 0 0 22px' }}>
      <Button size="sm" variant="primary" onClick={() => { send('diff-apply') }}>{t('diffActions.apply')}</Button>
      <Button size="sm" onClick={() => { send('diff-reveal') }}>{t('diffActions.reveal')}</Button>
    </div>
  )
}

/** The shell's own copy, complete per locale id. */
const zh = { 'diffActions.apply': '应用', 'diffActions.reveal': '查看' }
const en = { 'diffActions.apply': 'Apply', 'diffActions.reveal': 'Reveal' }

/** Register the action surface and its dictionaries; the shell mounts this plugin. */
export const name = 'dsh-vscode-diff-actions'
export const inject = ['slots', 'locale']

/**
 * Register the diff-action buttons into the ui-tool hole. `slots.inject`
 * waits for the declaration, so load order cannot race the tool package.
 * @param ctx - the shell's plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${name}: dictionaries`)
  ctx.slots.inject('tool.call.diff-actions', () => ctx.slots.register(
    { name: 'tool.call.diff-actions', locale: NS },
    DiffActions,
  ))
}
