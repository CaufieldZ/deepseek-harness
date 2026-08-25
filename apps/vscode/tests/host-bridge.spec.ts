import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostBridge, type HostToWebviewMessage, type MessageTransport, type WebviewToHostMessage } from '../src/bridge/host-bridge.ts'
import { FAKE_DESCRIBE_VALUE, makeFakeChildServer, type FakeChildServer } from './fake-child-server.ts'

/** Channel bound to the bridge: injections reach the bridge listener, posts are captured. */
interface BridgeChannel {
  captured: HostToWebviewMessage[]
  inject(message: WebviewToHostMessage): void
}

function makeBridgeChannel(): { channel: MessageTransport; state: BridgeChannel } {
  const captured: HostToWebviewMessage[] = []
  let listener: ((message: unknown) => void) | undefined
  const state: BridgeChannel = {
    captured,
    inject: (message) => { listener?.(message) },
  }
  return {
    state,
    channel: {
      postMessage: (message) => { captured.push(message as HostToWebviewMessage) },
      onMessage: (l) => {
        listener = l
        return () => { listener = undefined }
      },
    },
  }
}

const ENVELOPE = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'host.describe', payload: {} })

describe('HostBridge', () => {
  let child: FakeChildServer
  let state: BridgeChannel
  let bridge: HostBridge
  beforeEach(async () => {
    child = await makeFakeChildServer()
    const channel = makeBridgeChannel()
    state = channel.state
    bridge = new HostBridge({ childBaseUrl: () => child.base, channel: channel.channel })
    bridge.start()
  })
  afterEach(async () => {
    bridge.dispose()
    await child.close()
  })

  it('relays a unary message to the child and posts the response', async () => {
    state.inject({ type: 'unary', requestId: 'r1', path: '/api/host.describe', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: ENVELOPE } })
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'unary-response')).toBe(true) })
    const response = state.captured.find(message => message.type === 'unary-response') as Extract<HostToWebviewMessage, { type: 'unary-response' }>
    expect(response.status).toBe(200)
    expect(response.requestId).toBe('r1')
    const body = JSON.parse(response.bodyText ?? '{}') as { result: { ok: boolean; value: typeof FAKE_DESCRIBE_VALUE } }
    expect(body.result.value.version).toBe('0.0.0-test')
  })

  it('passes through non-2xx statuses for the client to reject', async () => {
    state.inject({ type: 'unary', requestId: 'r2', path: '/api/unknown.method', init: { method: 'POST', headers: {}, body: ENVELOPE } })
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'unary-response')).toBe(true) })
    const response = state.captured.find(message => message.type === 'unary-response') as Extract<HostToWebviewMessage, { type: 'unary-response' }>
    expect(response.status).toBe(404)
  })

  it('aborts an in-flight unary on cancel', async () => {
    state.inject({ type: 'unary', requestId: 'r3', path: '/api/host.describe', init: { method: 'POST', headers: {}, body: ENVELOPE } })
    state.inject({ type: 'unary-cancel', requestId: 'r3' })
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'unary-error')).toBe(true) })
    const error = state.captured.find(message => message.type === 'unary-error') as Extract<HostToWebviewMessage, { type: 'unary-error' }>
    expect(error.requestId).toBe('r3')
    expect(error.error).toContain('aborted')
  })

  it('relays stream frames as SSE chunks and ends on socket close', async () => {
    state.inject({ type: 'stream-open', streamId: 's1', path: '/api/events.mux' })
    await vi.waitFor(() => { expect(child.sockets).toHaveLength(1) })
    const socket = child.sockets[0] as NonNullable<(typeof child.sockets)[number]>
    socket.send(JSON.stringify({ type: 'server-request', rpcId: 'rpc-x', method: 'session/event', payload: { type: 'session/subscribed', sessionId: 'sess-x', lastSeq: 0 } }))
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'stream-chunk')).toBe(true) })
    const chunk = state.captured.find(message => message.type === 'stream-chunk') as Extract<HostToWebviewMessage, { type: 'stream-chunk' }>
    expect(chunk.streamId).toBe('s1')
    expect(chunk.data.startsWith('data: ')).toBe(true)
    expect(chunk.data.endsWith('\n\n')).toBe(true)
    expect(JSON.parse(chunk.data.slice(6).trim())).toMatchObject({ type: 'server-request', rpcId: 'rpc-x' })
    socket.close()
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'stream-end')).toBe(true) })
  })

  it('closes the downlink socket on stream-cancel', async () => {
    state.inject({ type: 'stream-open', streamId: 's2', path: '/api/events.mux' })
    await vi.waitFor(() => { expect(child.sockets).toHaveLength(1) })
    const closed = new Promise<void>((resolve) => { (child.sockets[0] as NonNullable<(typeof child.sockets)[number]>).on('close', () => { resolve() }) })
    state.inject({ type: 'stream-cancel', streamId: 's2' })
    await closed
  })

  it('dispose aborts in-flight unary calls and closes sockets', async () => {
    // Hang the response so the unary is still in flight when dispose aborts it.
    child.server.removeAllListeners('request')
    const received = new Promise<void>((resolve) => { child.server.on('request', () => { resolve() }) })
    state.inject({ type: 'unary', requestId: 'r4', path: '/api/host.describe', init: { method: 'POST', headers: {}, body: ENVELOPE } })
    await received
    state.inject({ type: 'stream-open', streamId: 's3', path: '/api/events.mux' })
    await vi.waitFor(() => { expect(child.sockets).toHaveLength(1) })
    bridge.dispose()
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'unary-error')).toBe(true) })
    await vi.waitFor(() => { expect(state.captured.some(message => message.type === 'stream-end')).toBe(true) })
  })
})
