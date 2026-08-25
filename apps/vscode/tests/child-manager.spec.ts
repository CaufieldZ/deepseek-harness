import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildManager, isLoopbackHostname, parseWebUrlLine, type ChildFacts, type Spawner } from '../src/child-manager.ts'

/** A scripted child: PassThrough streams plus manual exit/error triggers. */
interface FakeChild extends ChildProcess {
  stdout: PassThrough
  stderr: PassThrough
  kills: string[]
  exit(code: number | null, signal?: NodeJS.Signals | null): void
  fail(error: Error): void
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter()
  const fake = emitter as unknown as FakeChild
  fake.stdout = new PassThrough()
  fake.stderr = new PassThrough()
  // The kill ladder checks `exitCode === null`; a live fake always reads null.
  Object.defineProperty(fake, 'exitCode', { value: null })
  fake.kills = []
  fake.kill = (signal?: NodeJS.Signals) => {
    fake.kills.push(signal ?? 'SIGTERM')
    return true
  }
  fake.exit = (code, signal) => { emitter.emit('exit', code, signal ?? null) }
  fake.fail = (error) => { emitter.emit('error', error) }
  return fake
}

interface Harness {
  children: FakeChild[]
  facts: ChildFacts[]
  stderr: string[]
  manager: ChildManager
  spawner: Spawner
}

const READY_LINE = 'dsh web: http://127.0.0.1:37391\n'

function makeHarness(overrides: Partial<ConstructorParameters<typeof ChildManager>[0]> = {}): Harness {
  const harness: Harness = {
    children: [],
    facts: [],
    stderr: [],
    manager: undefined as unknown as ChildManager,
    spawner: vi.fn(() => {
      const child = makeFakeChild()
      harness.children.push(child)
      return child
    }),
  }
  harness.manager = new ChildManager({
    command: 'dsh',
    args: ['--profile', 'web', '--no-open', '--port', '0'],
    env: { DEEPSEEK_API_KEY: 'sk-test' },
    spawnTimeoutMs: 5_000,
    killGraceMs: 1_000,
    restartBackoffMinMs: 500,
    restartBackoffMaxMs: 10_000,
    ...overrides,
    onFacts: facts => harness.facts.push(facts),
    onStderrLine: line => harness.stderr.push(line),
    spawner: harness.spawner,
  })
  return harness
}

/** Boot to ready, then drop the recorded facts so assertions start from the interesting transition. */
function bootReady(harness: Harness): FakeChild {
  harness.manager.start()
  const child = harness.children[0] as FakeChild
  child.stdout.write(READY_LINE)
  return child
}

describe('parseWebUrlLine', () => {
  it('extracts the URL from the plain ready line', () => {
    expect(parseWebUrlLine(READY_LINE.trim())?.port).toBe('37391')
  })

  it('ignores the LAN suffix announcement', () => {
    const line = 'dsh web: http://127.0.0.1:37391 (LAN: http://192.168.1.5:37391)'
    expect(parseWebUrlLine(line)?.hostname).toBe('127.0.0.1')
  })

  it('returns undefined for unrelated stdout lines', () => {
    expect(parseWebUrlLine('[web-app] something else')).toBeUndefined()
    expect(parseWebUrlLine('dsh web: opening the default browser')).toBeUndefined()
  })

  it('rejects a non-loopback announcement', () => {
    expect(() => parseWebUrlLine('dsh web: http://192.168.1.5:37391')).toThrow(/non-loopback/)
  })
})

describe('isLoopbackHostname', () => {
  it('accepts loopback spellings and rejects routable hosts', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.8.8')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('192.168.1.5')).toBe(false)
    expect(isLoopbackHostname('127.0.0.1.evil.com')).toBe(false)
  })
})

describe('ChildManager', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('spawns with the configured command, args, and env, then reports ready', () => {
    const harness = makeHarness()
    bootReady(harness)
    expect(harness.spawner).toHaveBeenCalledWith('dsh', ['--profile', 'web', '--no-open', '--port', '0'], { env: { DEEPSEEK_API_KEY: 'sk-test' } })
    const last = harness.facts.at(-1)
    expect(last?.state).toBe('ready')
    expect(last?.baseUrl?.port).toBe('37391')
    expect(harness.manager.currentBaseUrl?.port).toBe('37391')
  })

  it('restarts a crashed child with exponential backoff', () => {
    const harness = makeHarness()
    bootReady(harness)
    const first = harness.children[0] as FakeChild
    first.exit(1)
    expect(harness.facts.at(-1)?.state).toBe('restarting')
    vi.advanceTimersByTime(500)
    expect(harness.children).toHaveLength(2)
    ;(harness.children[1] as FakeChild).exit(1)
    vi.advanceTimersByTime(500)
    expect(harness.children).toHaveLength(2)
    vi.advanceTimersByTime(500)
    expect(harness.children).toHaveLength(3)
  })

  it('kills a child that never announces ready and retries', () => {
    const harness = makeHarness()
    bootReady(harness) // establishes ready, then the second spawn stays silent
    ;(harness.children[0] as FakeChild).exit(1)
    vi.advanceTimersByTime(500)
    const silent = harness.children[1] as FakeChild
    vi.advanceTimersByTime(5_000)
    expect(silent.kills).toContain('SIGTERM')
    silent.exit(143)
    expect(harness.facts.at(-1)?.state).toBe('restarting')
    expect(harness.facts.at(-1)?.lastError).toContain('no ready line')
  })

  it('tears down with the SIGTERM→SIGKILL ladder and clears the base URL', () => {
    const harness = makeHarness()
    const child = bootReady(harness)
    harness.manager.stop()
    expect(child.kills).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(1_000)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.exit(143)
    const last = harness.facts.at(-1)
    expect(last?.state).toBe('stopped')
    expect(last?.baseUrl).toBeUndefined()
    expect(harness.manager.currentBaseUrl).toBeUndefined()
  })

  it('does not restart after a requested stop', () => {
    const harness = makeHarness()
    const child = bootReady(harness)
    harness.manager.stop()
    child.exit(143)
    vi.advanceTimersByTime(60_000)
    expect(harness.children).toHaveLength(1)
  })

  it('treats a spawn-level error as fatal and does not retry', () => {
    const harness = makeHarness()
    harness.manager.start()
    ;(harness.children[0] as FakeChild).fail(new Error('spawn dsh ENOENT'))
    expect(harness.facts.at(-1)?.state).toBe('stopped')
    expect(harness.facts.at(-1)?.lastError).toContain('ENOENT')
    vi.advanceTimersByTime(60_000)
    expect(harness.children).toHaveLength(1)
  })

  it('stops when the child announces a non-loopback URL', () => {
    const harness = makeHarness()
    harness.manager.start()
    const child = harness.children[0] as FakeChild
    child.stdout.write('dsh web: http://192.168.1.5:37391\n')
    expect(child.kills).toContain('SIGTERM')
    child.exit(143)
    expect(harness.facts.at(-1)?.state).toBe('stopped')
    expect(harness.facts.at(-1)?.lastError).toContain('non-loopback')
  })

  it('forwards stderr lines to the listener', () => {
    const harness = makeHarness()
    bootReady(harness)
    ;(harness.children[0] as FakeChild).stderr.write('line one\nline two\n')
    expect(harness.stderr).toEqual(['line one', 'line two'])
  })

  it('ignores duplicate starts while a child is alive', () => {
    const harness = makeHarness()
    bootReady(harness)
    harness.manager.start()
    harness.manager.start()
    expect(harness.children).toHaveLength(1)
  })
})
