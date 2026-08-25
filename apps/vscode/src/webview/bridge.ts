/**
 * Webview API carrier: AbstractApiClient subclass whose doFetch rides a
 * postMessage channel to the extension-host relay, and whose mux/host streams
 * consume SSE-encoded chunks over the same channel. Protocol invariants
 * (rpcId minting, envelope parse, frame schemas, gap detection) stay in the
 * base class; only the physical transport is replaced — the same swap the
 * layering note reserves for an IPC carrier.
 */
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { HostToWebviewMessage, MessageTransport, WebviewToHostMessage } from './protocol.ts'

/** Fake authority so `new URL(path, base)` parses; the host relay rebuilds the URL against the child. */
const WEBVIEW_BASE = 'http://dsh.webview'

type Parser<F> = { parse(value: unknown): F }

/**
 * Webview-side API client. Unary calls send one request message and await the
 * paired response; the two downlink streams open a chunk channel the host
 * feeds with SSE-encoded frames.
 */
export class VscodeApiClient extends AbstractApiClient {
  private readonly pendingUnary = new Map<string, { resolve(response: Response): void; reject(error: Error): void }>()
  private readonly openStreams = new Map<string, { push(data: string): void; end(): void }>()

  constructor(private readonly transport: MessageTransport, timeoutMs?: number) {
    super(timeoutMs)
    this.transport.onMessage((message) => { this.handleMessage(message) })
  }

  protected override resolveBase(): string {
    return WEBVIEW_BASE
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const requestId = crypto.randomUUID()
    const method = init?.method ?? 'GET'
    const headers = toHeaderRecord(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : undefined
    const message: WebviewToHostMessage = {
      type: 'unary',
      requestId,
      path: input.pathname + input.search,
      init: { method, headers, ...(body === undefined ? {} : { body }) },
    }
    const response = new Promise<Response>((resolve, reject) => {
      this.pendingUnary.set(requestId, { resolve, reject })
      this.transport.postMessage(message)
    })
    const signal = init?.signal ?? undefined
    if (signal !== undefined) {
      const onAbort = (): void => { this.transport.postMessage({ type: 'unary-cancel', requestId }) }
      if (signal.aborted) onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      // Both branches clean up; then() never propagates a rejection like finally() would.
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      void response.then(cleanup, cleanup)
    }
    return response
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readChannel('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readChannel('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readChannel<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const streamId = crypto.randomUUID()
    type ChannelEvent = { kind: 'chunk'; data: string } | { kind: 'end' }
    const inbox: ChannelEvent[] = []
    let wake: (() => void) | undefined
    const enqueue = (event: ChannelEvent): void => {
      inbox.push(event)
      wake?.()
      wake = undefined
    }
    this.openStreams.set(streamId, {
      push: (data) => { enqueue({ kind: 'chunk', data }) },
      end: () => { enqueue({ kind: 'end' }) },
    })
    this.transport.postMessage({ type: 'stream-open', streamId, path })
    const handleAbort = (): void => { this.transport.postMessage({ type: 'stream-cancel', streamId }) }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    onOpen?.()
    try {
      let buffer = ''
      while (true) {
        while (inbox.length > 0) {
          const event = inbox.shift() as ChannelEvent
          if (event.kind === 'end') return
          buffer += event.data
          // Same framing loop as AbstractApiClient.readSse: '\n\n' boundaries,
          // `data: ` lines, envelope then frame-schema parse, malformed skip.
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('')
            if (data === '') continue
            let full: ServerRequest
            let frame: F
            try {
              full = serverRequestSchema.parse(JSON.parse(data))
              frame = frameSchema.parse(full.payload)
            } catch (error) {
              console.error(`[dsh-vscode] dropping malformed SSE frame on ${path}:`, error)
              continue
            }
            this.onEnvelope(full)
            yield { rpcId: full.rpcId, payload: frame }
          }
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      this.openStreams.delete(streamId)
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const typed = message as HostToWebviewMessage
    if (typed.type === 'unary-response') {
      const pending = this.pendingUnary.get(typed.requestId)
      if (pending === undefined) return
      this.pendingUnary.delete(typed.requestId)
      pending.resolve(new Response(typed.bodyText ?? null, { status: typed.status, headers: typed.headers }))
      return
    }
    if (typed.type === 'unary-error') {
      const pending = this.pendingUnary.get(typed.requestId)
      if (pending === undefined) return
      this.pendingUnary.delete(typed.requestId)
      pending.reject(new Error(`[dsh-vscode] unary relay failed: ${typed.error}`))
      return
    }
    if (typed.type === 'stream-chunk') {
      this.openStreams.get(typed.streamId)?.push(typed.data)
      return
    }
    // The remaining union member is 'stream-end'.
    this.openStreams.get(typed.streamId)?.end()
  }
}

/** Fold a Headers/HeaderInit value into a plain record for the wire. */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}
