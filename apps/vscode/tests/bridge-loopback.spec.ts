import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostBridge } from '../src/bridge/host-bridge.ts'
import { VscodeApiClient } from '../webview/src/bridge.ts'
import { FAKE_DESCRIBE_VALUE, makeFakeChildServer, type FakeChildServer } from './fake-child-server.ts'
import { makeTransportPair } from './transport-pair.ts'

/**
 * Carrier fidelity: the whole chain — VscodeApiClient over a message pair to
 * HostBridge over real HTTP/ws to the scripted child — must preserve the
 * envelope contract (rpcId echo, value parse, frame schemas) exactly as the
 * browser carrier would.
 */
describe('webview-to-child carrier chain', () => {
  let child: FakeChildServer
  let client: VscodeApiClient
  let bridge: HostBridge
  beforeEach(async () => {
    child = await makeFakeChildServer()
    const pair = makeTransportPair()
    client = new VscodeApiClient(pair.webview)
    bridge = new HostBridge({ childBaseUrl: () => child.base, channel: pair.host, diffActions: { handle: () => {} } })
    bridge.start()
  })
  afterEach(async () => {
    bridge.dispose()
    await child.close()
  })

  it('round-trips a unary call through the relay', async () => {
    const response = await client.host.describe({})
    expect(response.result.ok).toBe(true)
    if (response.result.ok) expect(response.result.value).toEqual(FAKE_DESCRIBE_VALUE)
  })

  it('rejects a foreign rpcId echo through the relay', async () => {
    // The scripted child always echoes the real rpcId, so corrupt at the wire:
    // replace the handler to answer a fixed wrong id.
    child.server.removeAllListeners('request')
    child.server.on('request', (req, res) => {
      const body: Buffer[] = []
      req.on('data', (chunk: Buffer) => { body.push(chunk) })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: 'foreign',
          result: { ok: true, value: FAKE_DESCRIBE_VALUE },
        }))
      })
    })
    await expect(client.host.describe({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('streams mux frames through the relay with malformed-frame skipping', async () => {
    const sessionId = crypto.randomUUID()
    const frames: Array<{ type: string }> = []
    const iterate = (async () => {
      for await (const frame of client.events.mux({}, new AbortController().signal)) {
        frames.push(frame.payload)
      }
    })()
    await vi.waitFor(() => { expect(child.sockets).toHaveLength(1) })
    const socket = child.sockets[0] as NonNullable<(typeof child.sockets)[number]>
    const frame = JSON.stringify({ type: 'server-request', rpcId: crypto.randomUUID(), method: 'session/event', payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } })
    socket.send(frame)
    socket.send('{broken')
    socket.close()
    await iterate
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ type: 'session/subscribed', sessionId, lastSeq: 0 })
  })

  it('propagates an abort through the relay to the child', async () => {
    const controller = new AbortController()
    // Hang the response and wait for the request to arrive before aborting,
    // so the cancel deterministically reaches an in-flight request.
    child.server.removeAllListeners('request')
    let resolveAborted: () => void = () => {}
    const aborted = new Promise<void>((resolve) => { resolveAborted = resolve })
    let resolveReceived: () => void = () => {}
    const received = new Promise<void>((resolve) => { resolveReceived = resolve })
    child.server.on('request', (req) => {
      req.on('aborted', () => { resolveAborted() })
      resolveReceived()
    })
    const pending = client.host.describe({}, controller.signal)
    const caught = pending.catch((error: unknown) => error as Error)
    await received
    controller.abort()
    await expect(caught).resolves.toMatchObject({ message: expect.stringContaining('aborted') as string })
    await aborted
  })
})
