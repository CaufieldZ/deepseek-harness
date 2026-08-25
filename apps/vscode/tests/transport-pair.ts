import type { MessageTransport } from '../webview/src/protocol.ts'

/**
 * Two transports wired back-to-back so the webview client and the host
 * bridge can talk in-process: posting on either side delivers to the other
 * side's listeners.
 */
export function makeTransportPair(): { webview: MessageTransport; host: MessageTransport } {
  const webviewListeners = new Set<(message: unknown) => void>()
  const hostListeners = new Set<(message: unknown) => void>()
  const webview: MessageTransport = {
    postMessage: (message) => { for (const listener of hostListeners) listener(message) },
    onMessage: (listener) => {
      webviewListeners.add(listener)
      return () => { webviewListeners.delete(listener) }
    },
  }
  const host: MessageTransport = {
    postMessage: (message) => { for (const listener of webviewListeners) listener(message) },
    onMessage: (listener) => {
      hostListeners.add(listener)
      return () => { hostListeners.delete(listener) }
    },
  }
  return { webview, host }
}
