import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'

/** The unary value the fake child answers for /api/host.describe. */
export const FAKE_DESCRIBE_VALUE = {
  version: '0.0.0-test',
  cwd: '/tmp',
  attachedSessions: 0,
  home: '/tmp/home',
  canOpenPath: false,
}

export interface FakeChildServer {
  server: Server
  wss: WebSocketServer
  base: URL
  port: number
  /** Mux sockets in connection order (the harness drives frames through these). */
  sockets: WebSocket[]
  close(): Promise<void>
}

/**
 * Scripted child stand-in: echoes one unary method through the real envelope
 * contract and serves the mux downlink upgrade, close enough to the real
 * child surface to pin both relay halves against.
 */
export async function makeFakeChildServer(): Promise<FakeChildServer> {
  const sockets: WebSocket[] = []
  const server = createServer((req, res) => {
    if (req.url !== '/api/host.describe') {
      res.writeHead(404).end()
      return
    }
    const body: Buffer[] = []
    req.on('data', (chunk: Buffer) => { body.push(chunk) })
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(body).toString()) as { rpcId: string }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: FAKE_DESCRIBE_VALUE },
      }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/events.mux') {
      wss.handleUpgrade(req, socket, head, (ws) => { sockets.push(ws); wss.emit('connection', ws, req) })
      return
    }
    socket.destroy()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const port = (server.address() as AddressInfo).port
  return {
    server,
    wss,
    sockets,
    base: new URL(`http://127.0.0.1:${port}/`),
    port,
    close: async () => {
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
