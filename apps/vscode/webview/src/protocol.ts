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
  | DiffActionMessage

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

/** Host→webview messages. */
export type HostToWebviewMessage =
  | { type: 'unary-response'; requestId: string; status: number; headers: Record<string, string>; bodyText?: string }
  | { type: 'unary-error'; requestId: string; error: string }
  | { type: 'stream-chunk'; streamId: string; data: string }
  | { type: 'stream-end'; streamId: string }
