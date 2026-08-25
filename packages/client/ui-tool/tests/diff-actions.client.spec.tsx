// @vitest-environment jsdom
// The 'tool.call.diff-actions' hole through the REAL machinery stack
// (SlotTestRuntime + ui-conversation/ui-tool apply, the same bench as the
// toolview-slot suite): a diff-bearing call mounts the action surface beside
// the shipped file-mutation row, the owner carries the narrowed hunks, a
// non-diff call never mounts it, no registration renders nothing, and unload
// removes the contribution while the row stays.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { ISession, SessionId, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTool, inject as injectTool } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { DiffActionOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { toolChatSnapshot } from './tool-details-render.client.tsx'

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
// The chat store persists under its declared key; clear between cases.
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

const toolResult = (seq: number, callId: string, name: string, args = '{"command":"make build","description":"Build"}'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: args },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})

/** A settled `edit` call whose result view is an applied diff card. */
const diffResult = (seq: number, callId: string): ToolResultNode => ({
  ...toolResult(seq, callId, 'edit', '{"file_path":"src/a.ts","old_string":"old","new_string":"new"}'),
  resultView: {
    card: 'diff',
    diffs: [{ path: 'src/a.ts', oldText: 'old\n', newText: 'new\n' }],
  },
})

/** Test-owned AppFrame role: declares and renders the resident conversation area. */
type AppRootProps = PropsRenderSlots<'conversation' | 'details'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('conversation', {})}</>
}

const LAYOUT_CHILDREN = {
  'conversation': { kind: 'single', scope: 'session-maybe' },
  'details': { kind: 'single', scope: 'session' },
} as const

/**
 * Real-stack bench: SlotTestRuntime with the session/layout doubles at the
 * service boundaries only, the package apply on its own fiber, and the test
 * AppFrame occupying 'root'.
 */
async function bench(nodes: ToolResultNode[]) {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', {
    api: { settings: {} },
    isLoopback: false,
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  })
  // ui-theme's Appearance row binds a durable scope through these two.
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S' },
    snapshot: { nodes, chat: toolChatSnapshot(nodes) },
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  return { runtime, slots: runtime.slots }
}

describe('diff-action hole through the real machinery', () => {
  it('mounts the action surface beside the shipped file-mutation row with narrowed hunks', async () => {
    const b = await bench([diffResult(3, 'c1')])
    const seen: { diffs: unknown; sessionId: unknown }[] = []
    b.slots.register({
      name: 'tool.call.diff-actions',
      inject: (sessionId: SessionId) => ({
        sessionId,
        capture: (diffs: unknown) => { seen.push({ diffs, sessionId }) },
      }),
    }, ({ diffs, capture }: DiffActionOwnerProps & { sessionId: SessionId; capture: (diffs: unknown) => void }) => {
      capture(diffs)
      return <div data-testid="diff-actions">{diffs.map(d => d.path).join(',')}</div>
    })
    const view = b.runtime.renderRoot()
    // The action surface rendered next to the shipped row, not instead of it.
    expect(view.getByTestId('diff-actions').textContent).toBe('src/a.ts')
    expect(view.getByText('Edit')).toBeTruthy()
    // The owner carried exactly the narrowed hunks and the session identity.
    expect(seen).toEqual([{ diffs: [{ path: 'src/a.ts', oldText: 'old\n', newText: 'new\n' }], sessionId: SID }])
    await b.runtime.dispose()
  })

  it('does not mount the surface for a call without a diff card', async () => {
    const b = await bench([toolResult(3, 'c1', 'bash')])
    let mounted = 0
    b.slots.register(
      { name: 'tool.call.diff-actions' },
      () => { mounted += 1; return <div data-testid="diff-actions" /> })
    const view = b.runtime.renderRoot()
    expect(view.queryByTestId('diff-actions')).toBeNull()
    expect(mounted).toBe(0)
    await b.runtime.dispose()
  })

  it('renders nothing when no entry is registered', async () => {
    const b = await bench([diffResult(3, 'c1')])
    const view = b.runtime.renderRoot()
    // The shipped row is intact; no action surface exists to render.
    expect(view.getByText('Edit')).toBeTruthy()
    expect(view.container.querySelector('[data-testid="diff-actions"]')).toBeNull()
    await b.runtime.dispose()
  })

  it('unload removes the contribution while the shipped row stays', async () => {
    const b = await bench([diffResult(3, 'c1')])
    const dispose = b.slots.register(
      { name: 'tool.call.diff-actions' },
      () => <div data-testid="diff-actions">act</div>)
    const view = b.runtime.renderRoot()
    expect(view.getByTestId('diff-actions')).toBeTruthy()
    dispose()
    await b.runtime.flush()
    expect(view.queryByTestId('diff-actions')).toBeNull()
    expect(view.getByText('Edit')).toBeTruthy()
    await b.runtime.dispose()
  })
})
