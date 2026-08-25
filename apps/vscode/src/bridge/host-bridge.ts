/**
 * Extension-host relay for one webview panel: unary messages go to the child
 * over Node fetch (no Origin header, so the /api trust fence passes), and
 * stream messages open a ws downlink to the child, re-encoding each frame in
 * the SSE wire encoding the webview's readSse-style parser consumes
 * (`data: <json>\n\n`). The relay only ever targets the child base URL, so
 * webview-supplied paths cannot reach anything beyond the loopback child.
 */
import WebSocket from 'ws'
import { decodeWsText } from '../api/ws-data.ts'
import { isWebviewToHostMessage, type HostToWebviewMessage, type MessageTransport, type WebviewToHostMessage } from '../webview/protocol.ts'

export interface HostBridgeOptions {
  childBaseUrl: () => URL
  channel: MessageTransport
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
    if (!isWebviewToHostMessage(message)) return
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
