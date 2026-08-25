/**
 * Webview entry: installs the postMessage carrier (API client + gateway rpc
 * fetch) and boots the assembled client application. The host injects the
 * module-loader facade, __DSH_BOOT__, and the bundle scripts before this
 * module runs.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { VscodeApiClient } from './bridge.ts'
import { createVscodeTransport } from './vscode-transport.ts'

const transport = createVscodeTransport()
const apiClient = new VscodeApiClient(transport)
;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = {
  createApiClient: () => apiClient,
  fetch: (input: URL, init: RequestInit) => apiClient.relayFetch(input, init),
}

const el = document.getElementById('root')
if (el === null) throw new Error('dsh webview: missing #root')

/** The boot kernel, exported so the assembled snapshot lane can dispose it. */
export const appEntry = new AppWebEntry(el)
void appEntry.run()
