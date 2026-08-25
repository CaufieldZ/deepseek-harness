import { beforeEach, describe, expect, it } from 'vitest'
import { VscodeApiClient } from '../src/webview/bridge.ts'
import type { HostToWebviewMessage, MessageTransport, WebviewToHostMessage } from '../src/webview/protocol.ts'

/** A scripted transport: records posts and lets the test inject host replies. */
interface FakeTransport extends MessageTransport {
  posted: WebviewToHostMessage[]
  deliver(message: HostToWebviewMessage): void
}

function makeFakeTransport(): FakeTransport {
  const listeners = new Set<(message: unknown) => void>()
  const posted: WebviewToHostMessage[] = []
  return {
    posted,
    postMessage: (message) => { posted.push(message as WebviewToHostMessage) },
    onMessage: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    deliver: (message) => { for (const listener of listeners) listener(message) },
  }
}

const DESCRIBE_VALUE = { version: '0.0.0-test', cwd: '/tmp', attachedSessions: 0, home: '/tmp/home', canOpenPath: false }

/** Answer a posted unary with a server-response echoing its envelope rpcId. */
function echoResponse(transport: FakeTransport, value: object, rpcId?: string): void {
  const posted = transport.posted.find(message => message.type === 'unary') as Extract<WebviewToHostMessage, { type: 'unary' }>
  const envelope = JSON.parse(posted.init.body ?? '{}') as { rpcId: string }
  transport.deliver({
    type: 'unary-response',
    requestId: posted.requestId,
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify({ type: 'server-response', rpcId: rpcId ?? envelope.rpcId, result: { ok: true, value } }),
  })
}

describe('VscodeApiClient', () => {
  let transport: FakeTransport
  let client: VscodeApiClient
  beforeEach(() => {
    transport = makeFakeTransport()
    client = new VscodeApiClient(transport)
  })

  it('sends one unary message per call and parses the echoed response', async () => {
    const pending = client.host.describe({})
    const posted = transport.posted.find(message => message.type === 'unary') as Extract<WebviewToHostMessage, { type: 'unary' }>
    expect(posted.path).toBe('/api/host.describe')
    echoResponse(transport, DESCRIBE_VALUE)
    const response = await pending
    expect(response.result.ok).toBe(true)
    if (response.result.ok) expect(response.result.value.version).toBe('0.0.0-test')
  })

  it('rejects a response echoing a foreign rpcId', async () => {
    const pending = client.host.describe({})
    echoResponse(transport, DESCRIBE_VALUE, 'foreign')
    await expect(pending).rejects.toThrow(/rpcId mismatch/)
  })

  it('surfaces relay failures as errors', async () => {
    const pending = client.host.describe({})
    const caught = pending.catch((error: unknown) => error as Error)
    const posted = transport.posted.find(message => message.type === 'unary') as Extract<WebviewToHostMessage, { type: 'unary' }>
    transport.deliver({ type: 'unary-error', requestId: posted.requestId, error: 'child unreachable' })
    await expect(caught).resolves.toMatchObject({ message: expect.stringContaining('unary relay failed: child unreachable') as string })
  })

  it('posts a cancel when the caller aborts an in-flight unary', async () => {
    const controller = new AbortController()
    const pending = client.host.describe({}, controller.signal)
    const caught = pending.catch((error: unknown) => error as Error)
    const posted = transport.posted.find(message => message.type === 'unary') as Extract<WebviewToHostMessage, { type: 'unary' }>
    controller.abort()
    // The relay answers aborts with unary-error; the fake host must do the same.
    transport.deliver({ type: 'unary-error', requestId: posted.requestId, error: 'aborted' })
    await expect(caught).resolves.toMatchObject({ message: expect.stringContaining('aborted') as string })
    expect(transport.posted.some(message => message.type === 'unary-cancel')).toBe(true)
  })

  it('yields valid stream frames, skips malformed ones, and ends on stream-end', async () => {
    const sessionId = crypto.randomUUID()
    const frames: Array<{ type: string }> = []
    const iterate = (async () => {
      for await (const frame of client.events.mux({}, new AbortController().signal)) {
        frames.push(frame.payload)
      }
    })()
    const posted = transport.posted.find(message => message.type === 'stream-open') as Extract<WebviewToHostMessage, { type: 'stream-open' }>
    expect(posted.path).toBe('/api/events.mux')
    const frame = JSON.stringify({ type: 'server-request', rpcId: crypto.randomUUID(), method: 'session/event', payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } })
    transport.deliver({ type: 'stream-chunk', streamId: posted.streamId, data: `data: ${frame}\n\n` })
    transport.deliver({ type: 'stream-chunk', streamId: posted.streamId, data: 'data: {not-json\n\n' })
    transport.deliver({ type: 'stream-end', streamId: posted.streamId })
    await iterate
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ type: 'session/subscribed', sessionId, lastSeq: 0 })
  })

  it('posts a stream-cancel when the signal aborts', async () => {
    const controller = new AbortController()
    const iterate = (async () => {
      for await (const frame of client.events.mux({}, controller.signal)) void frame
    })()
    controller.abort()
    const posted = transport.posted.find(message => message.type === 'stream-open') as Extract<WebviewToHostMessage, { type: 'stream-open' }>
    transport.deliver({ type: 'stream-end', streamId: posted.streamId })
    await iterate
    expect(transport.posted.some(message => message.type === 'stream-cancel')).toBe(true)
  })
})
