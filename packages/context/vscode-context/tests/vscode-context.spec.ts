import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as vscodeContext from '@deepseek-ai/dsh-vscode-context'
import type { Config, VscodeFeed } from '@deepseek-ai/dsh-vscode-context'

const SIGNAL = new AbortController().signal

let root: string
let feedPath: string

/** One well-formed feed document. */
function feed(overrides: Partial<VscodeFeed> = {}): VscodeFeed {
  return {
    version: 1,
    updatedAt: 1_000,
    workspace: '/work',
    activeFile: {
      path: 'src/index.ts',
      languageId: 'typescript',
      cursor: { line: 42, character: 7 },
      selection: { startLine: 40, endLine: 50, text: 'const answer = 42\n' },
    },
    openFiles: ['src/index.ts', 'src/util.ts'],
    ...overrides,
  }
}

function writeFeed(value: unknown): void {
  writeFileSync(feedPath, JSON.stringify(value), 'utf8')
}

async function mount(config: Config = {}): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(vscodeContext, Object.assign({ feedPath }, config))
  return { ctx }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('vscode-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'vscode-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-vscode-context-'))
  feedPath = join(root, 'context.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('vscode-context injection', () => {
  it('injects the editor state on the first step of a turn', async () => {
    writeFeed(feed())
    const { ctx } = await mount()
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([
      'vscode context (turn 1):\n'
      + 'workspace /work\n'
      + 'active file src/index.ts, cursor 42:7, selection lines 40-50:\n'
      + 'const answer = 42\n'
      + 'open files (2): src/index.ts, src/util.ts',
    ])
    const event = session.events.at(-1)
    if (event?.type !== 'user/message') throw new Error('missing vscode context')
    expect(event.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'vscode-context',
      form: 'snapshot',
      sections: [{ name: 'vscode-context' }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('injects nothing when the feed file is absent', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('absent'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([])
  })

  it('injects nothing and warns when the feed is malformed', async () => {
    writeFeed({ version: 99, updatedAt: 1_000 })
    const { ctx } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = Session.create(SessionId('malformed'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('not a valid feed')
  })

  it('re-injects only when the editor state changed since the last injection', async () => {
    writeFeed(feed())
    const { ctx } = await mount()
    const session = Session.create(SessionId('changed'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Same state: suppressed.
    writeFeed(feed({ updatedAt: 2_000 }))
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(contextTexts(session)).toHaveLength(1)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Changed selection: re-injected.
    writeFeed(feed({
      updatedAt: 3_000,
      activeFile: {
        path: 'src/index.ts',
        languageId: 'typescript',
        cursor: { line: 50, character: 1 },
        selection: { startLine: 48, endLine: 52, text: 'export function main() {\n' },
      },
    }))
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)
    expect(contextTexts(session)).toHaveLength(2)
    expect(contextTexts(session)[1]).toContain('selection lines 48-52')
  })

  it('honors a positive refresh interval between injections', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    writeFeed(feed())
    const { ctx } = await mount({ refreshIntervalMs: 10_000 })
    const session = Session.create(SessionId('interval'))
    const agent = sessionAgent(session)

    openMessageTurn(session, 1)
    await fire(ctx, agent, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Changed state but inside the interval: suppressed.
    writeFeed(feed({ updatedAt: 2_000, workspace: '/work-2' }))
    vi.setSystemTime(5_000)
    openMessageTurn(session, 2)
    await fire(ctx, agent, 2, 1)
    expect(contextTexts(session)).toHaveLength(1)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Past the interval: re-injected.
    vi.setSystemTime(12_000)
    openMessageTurn(session, 3)
    await fire(ctx, agent, 3, 1)
    expect(contextTexts(session)).toHaveLength(2)
    expect(contextTexts(session)[1]).toContain('workspace /work-2')
  })
})

describe('parseFeed', () => {
  it('accepts the minimal feed and rejects wrong versions and malformed fields', () => {
    expect(vscodeContext.parseFeed({ version: 1, updatedAt: 1 })).toEqual({ version: 1, updatedAt: 1 })
    expect(vscodeContext.parseFeed(feed())).toMatchObject({ workspace: '/work' })
    expect(vscodeContext.parseFeed({ version: 2, updatedAt: 1 })).toBeUndefined()
    expect(vscodeContext.parseFeed({ version: 1 })).toBeUndefined()
    expect(vscodeContext.parseFeed({ version: 1, updatedAt: 1, openFiles: ['ok', 3] })).toBeUndefined()
    expect(vscodeContext.parseFeed({
      version: 1,
      updatedAt: 1,
      activeFile: { path: 'a.ts', cursor: { line: 0, character: 1 } },
    })).toBeUndefined()
    expect(vscodeContext.parseFeed({
      version: 1,
      updatedAt: 1,
      activeFile: { path: 'a.ts', selection: { startLine: 5, endLine: 2, text: 'x' } },
    })).toBeUndefined()
  })
})

describe('vscode-context configuration', () => {
  it('rejects a negative refresh interval at plugin load', async () => {
    await expect(mount({ refreshIntervalMs: -1 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })

  it('rejects a non-integer refresh interval at plugin load', async () => {
    await expect(mount({ refreshIntervalMs: 1.5 })).rejects.toThrow(
      /refreshIntervalMs must be a non-negative safe integer/,
    )
  })
})
