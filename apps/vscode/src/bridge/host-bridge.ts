/**
 * Extension-host relay for one webview panel: unary messages go to the child
 * over Node fetch (no Origin header, so the /api trust fence passes), and
 * stream messages open a ws downlink to the child, re-encoding each frame in
 * the SSE wire encoding the webview's readSse-style parser consumes
 * (`data: <json>\n\n`). The relay only ever targets the child base URL, so
 * webview-supplied paths cannot reach anything beyond the loopback child.
 *
 * This file owns the host half of the postMessage wire; the webview half
 * (webview/src/protocol.ts) mirrors these literals, and the loopback test
 * pins the two halves together.
 */
import WebSocket from 'ws'
import { decodeWsText } from '../api/ws-data.ts'

/** Minimal postMessage-shaped channel so the relay stays testable without vscode types. */
export interface MessageTransport {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
}

/** Webview→host messages (host half of the wire). */
export type WebviewToHostMessage = RelayMessage | DiffActionMessage

/** The child-relay messages; diff actions stay in the extension host. */
type RelayMessage =
  | {
    type: 'unary'
    requestId: string
    path: string
    init: { method: string; headers: Record<string, string>; body?: string }
  }
  | { type: 'unary-cancel'; requestId: string }
  | { type: 'stream-open'; streamId: string; path: string }
  | { type: 'stream-cancel'; streamId: string }

/** Host→webview messages (host half of the wire). */
export type HostToWebviewMessage =
  | { type: 'unary-response'; requestId: string; status: number; headers: Record<string, string>; bodyText?: string }
  | { type: 'unary-error'; requestId: string; error: string }
  | { type: 'stream-chunk'; streamId: string; data: string }
  | { type: 'stream-end'; streamId: string }

/** One narrowed change hunk crossing the wire to a host-local diff action. */
export interface DiffHunkWire {
  path: string
  oldText: string | null
  newText: string
}

/**
 * A webview diff-action request. These stay in the extension host — the relay
 * never forwards them to the child: `diff-present` registers the change in the
 * pending registry (editor/title Accept/Reject), `diff-apply` applies it
 * through the workspace API, and `diff-reveal` opens the old→new preview.
 */
export interface DiffActionMessage {
  type: 'diff-present' | 'diff-apply' | 'diff-reveal'
  /** The session whose turn carries the diff. */
  sessionId: string
  /** Session workspace root for resolving relative hunk paths. */
  cwd?: string
  hunks: DiffHunkWire[]
}

/** Envelope check for a child-relay message. */
function isRelayMessage(message: unknown): message is RelayMessage {
  if (typeof message !== 'object' || message === null) return false
  const type = (message as { type?: unknown }).type
  return type === 'unary' || type === 'unary-cancel' || type === 'stream-open' || type === 'stream-cancel'
}

/**
 * Narrow a wire diff-action request field by field; any malformed member
 * drops the message (the relay treats it as an unknown envelope).
 * @param message - the parsed inbound value.
 * @returns the validated message, or undefined when it is not a diff action.
 */
function narrowDiffAction(message: unknown): DiffActionMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const candidate = message as Record<string, unknown>
  if (candidate.type !== 'diff-present' && candidate.type !== 'diff-apply' && candidate.type !== 'diff-reveal') return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
  const cwd = candidate.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) return undefined
  const hunks = candidate.hunks
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined
  const narrowed: DiffHunkWire[] = []
  for (const hunk of hunks) {
    if (typeof hunk !== 'object' || hunk === null) return undefined
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string' || path === '') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    if (typeof newText !== 'string') return undefined
    narrowed.push({ path, oldText, newText })
  }
  return { type: candidate.type, sessionId: candidate.sessionId, hunks: narrowed, ...(cwd === undefined ? {} : { cwd }) }
}

/** Host-local diff-action executor, injected by the extension entry. */
export interface DiffActionsHandler {
  /** Handle one narrowed diff-action request; failures surface in the host UI, not the relay. */
  handle(message: DiffActionMessage): Promise<void> | void
}

export interface HostBridgeOptions {
  childBaseUrl: () => URL
  channel: MessageTransport
  /** Host-local diff actions; the bridge routes diff messages here instead of the child. */
  diffActions: DiffActionsHandler
}

/** Per-panel message relay between the webview and the harness child. */
export class HostBridge {
  private readonly unaryControllers = new Map<string, AbortController>()
  private readonly streamSockets = new Map<string, WebSocket>()
  private detach: (() => void) | undefined

  constructor(private readonly options: HostBridgeOptions) {}

  /** Attach to the channel; the returned disposer detaches and aborts every in-flight operation. */
  start(): () => void {
    this.detach = this.options.channel.onMessage((message) => { void this.handleMessage(message) })
    return () => { this.dispose() }
  }

  dispose(): void {
    this.detach?.()
    this.detach = undefined
    for (const controller of this.unaryControllers.values()) controller.abort()
    this.unaryControllers.clear()
    // Entries stay registered until their close event lands so endStream can
    // post the terminal stream-end message; ws guarantees a close event.
    for (const socket of this.streamSockets.values()) socket.close()
  }

  private async handleMessage(message: unknown): Promise<void> {
    const diff = narrowDiffAction(message)
    if (diff !== undefined) {
      await this.options.diffActions.handle(diff)
      return
    }
    if (!isRelayMessage(message)) return
    if (message.type === 'unary') {
      await this.handleUnary(message)
      return
    }
    if (message.type === 'unary-cancel') {
      this.unaryControllers.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'stream-open') {
      this.handleStreamOpen(message)
      return
    }
    // The remaining union member is 'stream-cancel'.
    this.streamSockets.get(message.streamId)?.close()
  }

  private async handleUnary(message: Extract<WebviewToHostMessage, { type: 'unary' }>): Promise<void> {
    const controller = new AbortController()
    this.unaryControllers.set(message.requestId, controller)
    try {
      const url = new URL(message.path, this.options.childBaseUrl())
      const response = await fetch(url, {
        method: message.init.method,
        headers: message.init.headers,
        ...(message.init.body === undefined ? {} : { body: message.init.body }),
        signal: controller.signal,
      })
      const reply: HostToWebviewMessage = {
        type: 'unary-response',
        requestId: message.requestId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText: await response.text(),
      }
      this.options.channel.postMessage(reply)
    } catch (error) {
      const reply: HostToWebviewMessage = {
        type: 'unary-error',
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      }
      this.options.channel.postMessage(reply)
    } finally {
      this.unaryControllers.delete(message.requestId)
    }
  }

  private handleStreamOpen(message: Extract<WebviewToHostMessage, { type: 'stream-open' }>): void {
    const url = new URL(message.path, this.options.childBaseUrl())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.streamSockets.set(message.streamId, socket)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const text = decodeWsText(data)
      if (text === undefined) return
      const chunk: HostToWebviewMessage = { type: 'stream-chunk', streamId: message.streamId, data: `data: ${text}\n\n` }
      this.options.channel.postMessage(chunk)
    })
    socket.on('close', () => { this.endStream(message.streamId) })
    socket.on('error', () => { this.endStream(message.streamId) })
  }

  private endStream(streamId: string): void {
    if (!this.streamSockets.has(streamId)) return
    this.streamSockets.delete(streamId)
    this.options.channel.postMessage({ type: 'stream-end', streamId })
  }
}
