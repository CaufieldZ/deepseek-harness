import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTreeProvider, type SessionTreeSource } from '../src/views/session-tree.ts'

// Minimal vscode surface for the provider: TreeItem fields, one event emitter.
vi.mock('vscode', () => {
  class TreeItem {
    id: string | undefined
    description: string | undefined
    tooltip: string | undefined
    iconPath: unknown
    command: unknown
    contextValue: string | undefined
    constructor(readonly label: string | undefined, readonly collapsibleState?: number) {}
  }
  class ThemeIcon {
    constructor(readonly id: string) {}
  }
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>()
    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener)
      return { dispose: () => { this.listeners.delete(listener) } }
    }
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value)
    }
  }
  return { TreeItem, ThemeIcon, EventEmitter, TreeItemCollapsibleState: { None: 0 } }
})

import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import * as vscode from 'vscode'

interface FakeSource extends SessionTreeSource {
  summaries: SessionSummary[]
  hostFeed: (() => void)[] | undefined
}

/** Fabricate a branded session id for fixture summaries. */
function sid(id: string): SessionSummary['sessionId'] {
  return id as SessionSummary['sessionId']
}

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: sid('session-1'),
    updatedAt: 1_000,
    running: false,
    blank: true,
    ...overrides,
  }
}

function makeFakeSource(summaries: SessionSummary[]): FakeSource {
  const state: FakeSource = {
    summaries,
    hostFeed: undefined,
    listSessions: async () => state.summaries,
    hostFrames: async function * hostFrames() {
      // The provider reconnects on stream end; a closed empty generator
      // makes pumps back off forever — tests drive refresh via schedule only.
      yield* []
      await new Promise<never>(() => {})
    },
    muxFrames: async function * muxFrames() {
      yield* []
      await new Promise<never>(() => {})
    },
  }
  return state
}

describe('SessionTreeProvider', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('maps summaries to items sorted by recency, with titles and running icons', async () => {
    const source = makeFakeSource([
      summary({ sessionId: sid('older'), updatedAt: 1_000, blank: false }),
      summary({
        sessionId: sid('titled'),
        updatedAt: 3_000,
        blank: false,
        running: true,
        cwd: '/work',
        projections: { asOfSeq: 1, values: { title: 'Fix the parser' } },
      }),
    ])
    const provider = new SessionTreeProvider(source)
    const items = await provider.getChildren()
    expect(items.map(item => item.label)).toEqual(['Fix the parser', 'Session'])
    expect(items[0]?.iconPath).toBeInstanceOf(vscode.ThemeIcon)
    expect(items[0]?.tooltip).toBe('/work')
    expect(items[0]?.command).toEqual({ command: 'dsh.openSession', title: 'Open session', arguments: ['titled'] })
    expect(items[1]?.iconPath).toBeUndefined()
  })

  it('labels untitled blank sessions as New session and rejects null titles', async () => {
    const source = makeFakeSource([
      summary({ sessionId: sid('blank'), blank: true }),
      summary({ sessionId: sid('null-title'), blank: false, projections: { asOfSeq: 0, values: { title: null } } }),
    ])
    const provider = new SessionTreeProvider(source)
    const items = await provider.getChildren()
    expect(items.map(item => item.label)).toEqual(['New session', 'Session'])
  })

  it('refreshes debounced after a downlink frame', async () => {
    const source = makeFakeSource([summary({ sessionId: sid('one') })])
    const provider = new SessionTreeProvider(source)
    const listener = vi.fn()
    const subscription = provider.onDidChangeTreeData(listener)
    provider.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).not.toHaveBeenCalled()
    // A frame on either downlink schedules one debounced refresh.
    vi.advanceTimersByTime(200)
    expect(listener).toHaveBeenCalledTimes(1)
    subscription.dispose()
    provider.dispose()
  })
})
