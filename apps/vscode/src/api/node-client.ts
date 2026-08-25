/**
 * Node API carrier for the extension host: HTTP fetch upstream plus one `ws`
 * WebSocket per downstream event stream, mirroring the browser WebApiClient.
 * The child HTTP server answers network GETs to /api/events.* only with
 * Upgrade Required (the SSE path is in-process only), so the streams must ride
 * the WebSocket downlinks.
 */
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import WebSocket from 'ws'

/** The downlink pathnames (mirror of dsh-client-connection's api-path.ts). */
const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/** ws delivers text frames as strings or Buffers depending on the peer; normalize before parsing. */
function decodeMessageData(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every(part => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString('utf8')
  }
  return undefined
}

/**
 * Host-side API client for the spawned harness child. The base URL is read
 * per request from the provider so child restarts (a new OS-assigned port)
 * are picked up without rebuilding the client.
 */
export class NodeApiClient extends AbstractApiClient {
  constructor(private readonly baseUrlProvider: () => URL, timeoutMs?: number) {
    super(timeoutMs)
  }

  protected override resolveBase(): string {
    return this.baseUrlProvider().toString()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (data: unknown, isBinary: boolean): void => {
      if (isBinary) return
      const text = decodeMessageData(data)
      if (text === undefined) return
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(JSON.parse(text))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[dsh-vscode] dropping malformed WebSocket frame on ${path}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleError = (error: Error): void => {
      // ws reports transport failures here; 'close' may or may not follow, so
      // end the stream explicitly. Reconnect policy belongs to the consumer
      // above this client.
      console.error(`[dsh-vscode] WebSocket error on ${path}: ${error.message}`)
      enqueue({ kind: 'end' })
    }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.on('open', handleOpen)
    socket.on('message', handleMessage)
    socket.on('close', handleClose)
    socket.on('error', handleError)
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeListener('open', handleOpen)
      socket.removeListener('message', handleMessage)
      socket.removeListener('close', handleClose)
      socket.removeListener('error', handleError)
      handleAbort()
    }
  }
}
