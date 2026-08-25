/**
 * Message-port protocol between the webview carrier (VscodeApiClient) and the
 * extension-host relay (HostBridge). Webview→host carries one unary request
 * per rpc call and one stream channel per mux/host downlink; host→webview
 * answers with a response, or stream chunks in the SSE wire encoding the
 * client's existing readSse-style parser consumes (`data: <json>\n\n`).
 */

/** Minimal postMessage-shaped channel so both halves stay testable without DOM or vscode types. */
export interface MessageTransport {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
}

/** Webview→host messages. */
export type WebviewToHostMessage =
  | {
    type: 'unary'
    requestId: string
    path: string
    init: { method: string; headers: Record<string, string>; body?: string }
  }
  | { type: 'unary-cancel'; requestId: string }
  | { type: 'stream-open'; streamId: string; path: string }
  | { type: 'stream-cancel'; streamId: string }

/** Host→webview messages. */
export type HostToWebviewMessage =
  | { type: 'unary-response'; requestId: string; status: number; headers: Record<string, string>; bodyText?: string }
  | { type: 'unary-error'; requestId: string; error: string }
  | { type: 'stream-chunk'; streamId: string; data: string }
  | { type: 'stream-end'; streamId: string }
