import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { NodeApiClient } from '../src/api/node-client.ts'

/**
 * Scripted child stand-in: an HTTP server answering one unary method and a ws
 * WebSocketServer on the mux downlink path, mirroring the real child surface
 * closely enough to pin the client's envelope handling.
 */
interface Harness {
  server: Server
  wss: WebSocketServer
  base: URL
  client: NodeApiClient
  /** When set, unary calls answer HTTP 500. */
  failUnary: boolean
  /** When set, unary responses echo a foreign rpcId. */
  corruptRpcId: boolean
}

async function makeHarness(): Promise<Harness> {
  const server = createServer((req, res) => {
    if (req.url !== '/api/host.describe') {
      res.writeHead(404).end()
      return
    }
    if (harness.failUnary) {
      res.writeHead(500).end()
      return
    }
    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => body.push(chunk))
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(body).toString()) as { rpcId: string }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: harness.corruptRpcId ? 'foreign-rpc-id' : request.rpcId,
        result: {
          ok: true,
          value: {
            version: '0.0.0-test',
            cwd: '/tmp',
            attachedSessions: 0,
            home: '/tmp/home',
            canOpenPath: false,
          },
        },
      }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/events.mux') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
      return
    }
    socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const harness: Harness = {
    server,
    wss,
    base: new URL(`http://127.0.0.1:${port}/`),
    client: new NodeApiClient(() => harness.base),
    failUnary: false,
    corruptRpcId: false,
  }
  return harness
}

const SUBSCRIBED_FRAME = (sessionId: string): object => ({
  type: 'server-request',
  rpcId: crypto.randomUUID(),
  method: 'session/event',
  payload: { type: 'session/subscribed', sessionId, lastSeq: 0 },
})

describe('NodeApiClient', () => {
  let harness: Harness
  beforeEach(async () => { harness = await makeHarness() })
  afterEach(async () => {
    await new Promise<void>((resolve) => { harness.wss.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { harness.server.close(() => { resolve() }) })
  })

  it('round-trips a unary call through the envelope contract', async () => {
    const response = await harness.client.host.describe({})
    expect(response.result.ok).toBe(true)
    if (response.result.ok) expect(response.result.value.version).toBe('0.0.0-test')
  })

  it('rejects a response that echoes a foreign rpcId', async () => {
    harness.corruptRpcId = true
    await expect(harness.client.host.describe({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('surfaces transport failures as errors', async () => {
    harness.failUnary = true
    await expect(harness.client.host.describe({})).rejects.toThrow(/HTTP 500/)
  })

  it('yields valid mux frames, skips malformed messages, and ends on close', async () => {
    const sessionId = crypto.randomUUID()
    let opened = false
    const frames: Array<{ type: string }> = []
    harness.wss.on('connection', (socket) => {
      socket.send(JSON.stringify(SUBSCRIBED_FRAME(sessionId)))
      socket.send('{not-json')
      socket.send(JSON.stringify({ type: 'server-request', rpcId: crypto.randomUUID(), method: 'session/event', payload: { not: 'a frame' } }))
      socket.send(JSON.stringify(SUBSCRIBED_FRAME(crypto.randomUUID())))
      socket.close()
    })
    for await (const frame of harness.client.events.mux({}, new AbortController().signal, () => { opened = true })) {
      frames.push(frame.payload)
    }
    expect(opened).toBe(true)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ type: 'session/subscribed', sessionId, lastSeq: 0 })
  })

  it('closes the downlink socket when the signal aborts', async () => {
    const serverClosed = new Promise<void>((resolve) => { harness.wss.once('connection', (socket) => {
      socket.on('close', () => { resolve() })
    }) })
    const controller = new AbortController()
    let opened = false
    const iterator = harness.client.events.mux({}, controller.signal, () => { opened = true })[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => { expect(opened).toBe(true) })
    controller.abort()
    await expect(next).resolves.toEqual({ done: true, value: undefined })
    await serverClosed
  })
})
