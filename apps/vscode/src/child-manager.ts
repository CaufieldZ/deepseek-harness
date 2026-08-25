/**
 * Owns the harness child process: spawn, the ready-line parse, crash backoff,
 * and the SIGTERM→SIGKILL teardown ladder. vscode-free so the lifecycle is
 * unit-testable with an injected spawner.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

/** The lifecycle states a status surface renders. */
export type ChildState = 'stopped' | 'starting' | 'ready' | 'restarting'

/** The facts a listener needs to render child state. */
export interface ChildFacts {
  state: ChildState
  /** The parsed child base URL (present once ready). */
  baseUrl?: URL
  /** The last start failure, if any. */
  lastError?: string
}

/** Spawn function shape so tests can inject a scripted process. */
export type Spawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string },
) => ChildProcess

export interface ChildManagerOptions {
  command: string
  args: string[]
  env: Record<string, string>
  /** Working directory the child launches in; the profile's hook config resolves from it. */
  cwd?: string
  spawner?: Spawner
  /** Milliseconds to wait for the ready line before killing the child. */
  spawnTimeoutMs: number
  /** Milliseconds between SIGTERM and SIGKILL during teardown. */
  killGraceMs: number
  /** Backoff bounds for crash restarts. */
  restartBackoffMinMs: number
  restartBackoffMaxMs: number
  onFacts(facts: ChildFacts): void
  onStderrLine(line: string): void
}

/** The exact stdout prefix the web app prints on ready (optionally followed by a LAN suffix). */
const READY_PREFIX = 'dsh web: '

/** Loopback hostnames the child may bind; anything else is a misconfigured LAN server and fails loud. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true
  return /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/**
 * Extract the child base URL from a stdout line; undefined when the line is
 * not the ready announcement. Throws when the announced URL is not loopback.
 */
export function parseWebUrlLine(line: string): URL | undefined {
  if (!line.startsWith(READY_PREFIX)) return undefined
  const token = line.slice(READY_PREFIX.length).trim().split(/\s+/)[0]
  if (token === undefined) return undefined
  let url: URL
  try {
    url = new URL(token)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`dsh child announced a non-loopback URL (${url.href}); refusing to trust it`)
  }
  return url
}

/**
 * The harness child lifecycle. One child at a time: a crash restarts with
 * exponential backoff, a spawn-level failure (missing executable) is fatal
 * and does not retry, and stop() tears down with the kill ladder.
 */
export class ChildManager {
  private child: ChildProcess | undefined
  private baseUrl: URL | undefined
  private lastError: string | undefined
  private stopRequested = false
  private restartAfterStop = false
  private readyTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private restartAttempts = 0
  private stdoutTail = ''
  private readonly spawner: Spawner

  constructor(private readonly options: ChildManagerOptions) {
    this.spawner = options.spawner ?? ((command, args, opts) => nodeSpawn(command, args, { env: opts.env, cwd: opts.cwd }))
  }

  /** The current base URL; undefined before the ready line. */
  get currentBaseUrl(): URL | undefined {
    return this.baseUrl
  }

  /** Start the child when idle; a no-op while one is alive or a stop is pending. */
  start(): void {
    if (this.child !== undefined || this.stopRequested) return
    this.stopRequested = false
    this.setState('starting')
    this.spawnChild()
  }

  /** Tear the current child down and start a fresh one once it has exited. */
  restart(): void {
    if (this.child === undefined) {
      this.start()
      return
    }
    this.restartAfterStop = true
    this.killLadder()
  }

  /** Stop the child (kill ladder) and suppress restarts. */
  stop(): void {
    this.stopRequested = true
    this.clearRestartTimer()
    if (this.child === undefined) {
      this.setState('stopped')
      return
    }
    this.killLadder()
  }

  private spawnChild(): void {
    let child: ChildProcess
    try {
      child = this.spawner(
        this.options.command,
        this.options.args,
        {
          env: this.options.env,
          ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        },
      )
    } catch (error) {
      this.failFatal(error)
      return
    }
    this.child = child
    this.stdoutTail = ''
    this.readyTimer = setTimeout(() => { this.killForTimeout() }, this.options.spawnTimeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { this.onStdout(String(chunk)) })
    child.stderr?.on('data', (chunk: Buffer) => { this.onStderr(String(chunk)) })
    child.on('error', (error) => { this.onSpawnError(error) })
    child.on('exit', (code, signal) => { this.onExit(code, signal) })
  }

  private onStdout(data: string): void {
    this.stdoutTail += data
    const lines = this.stdoutTail.split(/\r?\n/)
    this.stdoutTail = lines.pop() ?? ''
    for (const line of lines) {
      let url: URL | undefined
      try {
        url = parseWebUrlLine(line)
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.stop()
        return
      }
      if (url !== undefined) this.onReady(url)
    }
  }

  private onReady(url: URL): void {
    this.clearReadyTimer()
    this.baseUrl = url
    this.lastError = undefined
    this.restartAttempts = 0
    this.setState('ready')
  }

  private onStderr(data: string): void {
    for (const line of data.split(/\r?\n/)) {
      if (line !== '') this.options.onStderrLine(line)
    }
  }

  private onSpawnError(error: Error): void {
    this.failFatal(error)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined
    this.clearReadyTimer()
    this.clearKillTimer()
    if (this.restartAfterStop) {
      this.restartAfterStop = false
      this.stopRequested = false
      this.start()
      return
    }
    if (this.stopRequested) {
      this.stopRequested = false
      this.baseUrl = undefined
      this.setState('stopped')
      return
    }
    const reason = signal !== null ? `killed by ${signal}` : `exited with code ${String(code)}`
    this.lastError = this.lastError ?? reason
    this.setState('restarting')
    const delay = Math.min(this.options.restartBackoffMinMs * 2 ** this.restartAttempts, this.options.restartBackoffMaxMs)
    this.restartAttempts += 1
    this.restartTimer = setTimeout(() => { this.start() }, delay)
  }

  /** Spawn-level failures (missing executable, EACCES) never retry: a retry loop cannot fix them. */
  private failFatal(error: unknown): void {
    this.child = undefined
    this.clearReadyTimer()
    this.clearKillTimer()
    this.baseUrl = undefined
    this.lastError = error instanceof Error ? error.message : String(error)
    this.setState('stopped')
  }

  private killForTimeout(): void {
    this.lastError = `no ready line within ${String(this.options.spawnTimeoutMs)}ms`
    this.killLadder()
  }

  private killLadder(): void {
    const child = this.child
    if (child === undefined) return
    this.clearKillTimer()
    child.kill('SIGTERM')
    this.killTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null) child.kill('SIGKILL')
    }, this.options.killGraceMs)
  }

  private setState(state: ChildState): void {
    const facts: ChildFacts = { state }
    if (this.baseUrl !== undefined) facts.baseUrl = this.baseUrl
    if (this.lastError !== undefined) facts.lastError = this.lastError
    this.options.onFacts(facts)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    this.readyTimer = undefined
  }

  private clearKillTimer(): void {
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    this.killTimer = undefined
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }
}
