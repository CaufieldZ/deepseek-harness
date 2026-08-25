/** Webview-side postMessage transport over the VS Code API. */
import type { MessageTransport } from './protocol.ts'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  setState(state: unknown): void
}

/**
 * Build the channel bound to the webview's acquireVsCodeApi message port.
 * Persists the host-injected session id as webview state so the window-reload
 * serializer restores this panel against the same session.
 */
export function createVscodeTransport(): MessageTransport {
  const api = acquireVsCodeApi()
  const sessionId = (globalThis as { __DSH_SESSION_ID__?: unknown }).__DSH_SESSION_ID__
  if (typeof sessionId === 'string' && sessionId !== '') api.setState({ sessionId })
  return {
    postMessage: (message) => { api.postMessage(message) },
    onMessage: (listener) => {
      const handler = (event: MessageEvent): void => { listener(event.data) }
      window.addEventListener('message', handler)
      return () => { window.removeEventListener('message', handler) }
    },
  }
}
