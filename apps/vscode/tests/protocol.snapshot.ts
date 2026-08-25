/**
 * Keyless protocol snapshot: spawns the real built harness child under plain
 * Node with a throwaway DSH_HOME and drives the host surface — host.describe,
 * session.list/create, and the mux downlink — through the production
 * NodeApiClient. No model calls, so replay needs no fixtures; the normalized
 * observation record pins the wire behavior of the child the carrier relies
 * on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { NodeApiClient } from '../src/api/node-client.ts'
import { ChildManager, type ChildFacts } from '../src/child-manager.ts'

const CLI_BIN = fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g

/** Wait for the child to reach a terminal fact state or fail the scenario. */
function waitForState(facts: ChildFacts[], poll: () => ChildFacts | undefined, target: ChildFacts['state']): Promise<ChildFacts> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const last = poll()
      if (last === undefined) return
      if (last.state === target) {
        clearInterval(timer)
        resolve(last)
        return
      }
      if ((last.state === 'stopped' || last.state === 'restarting') && Date.now() - started > 90_000) {
        clearInterval(timer)
        reject(new Error(`child failed before ${target}: ${last.lastError ?? 'unknown'}`))
      }
    }, 200)
    void facts
  })
}

/** Normalize volatile values out of an observation line. */
function normalize(line: unknown): unknown {
  return JSON.parse(JSON.stringify(line).replaceAll(UUID_PATTERN, '{{uuid}}')) as unknown
}

describe('vscode protocol snapshot', () => {
  it('drives the built child over the host surface and the mux downlink', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-vscode-snapshot-'))
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-vscode-snapshot-ws-'))
    const facts: ChildFacts[] = []
    const manager = new ChildManager({
      command: 'node',
      args: [CLI_BIN, '--profile', 'web', '--no-open', '--port', '0'],
      env: { ...scrubbedParentEnv(), DSH_HOME: dshHome },
      spawnTimeoutMs: 90_000,
      killGraceMs: 5_000,
      restartBackoffMinMs: 500,
      restartBackoffMaxMs: 10_000,
      onFacts: f => facts.push(f),
      onStderrLine: () => {},
    })
    try {
      manager.start()
      await waitForState(facts, () => facts.at(-1), 'ready')
      const client = new NodeApiClient(() => {
        const url = manager.currentBaseUrl
        if (url === undefined) throw new Error('child not ready')
        return url
      })

      const describe = await client.host.describe({})
      expect(describe.result.ok).toBe(true)
      if (!describe.result.ok) throw new Error('describe failed')
      const hostFacts = {
        version: describe.result.value.version,
        canOpenPath: describe.result.value.canOpenPath,
        attachedSessions: describe.result.value.attachedSessions,
      }

      const listBefore = await client.sessions.list({})
      expect(listBefore.result.ok).toBe(true)

      // The host stream announces lifecycle facts; session.create must surface
      // host/session-added (fresh sessions have no attached Agent, so the mux
      // stream correctly emits nothing for them).
      const hostFrameTypes: string[] = []
      const sessionAdded = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('host/session-added never arrived')) }, 30_000)
        void (async () => {
          for await (const frame of client.events.host({}, new AbortController().signal)) {
            hostFrameTypes.push(frame.payload.type)
            if (frame.payload.type === 'host/session-added') {
              clearTimeout(timer)
              resolve(frame.payload.sessionId)
              return
            }
          }
        })()
      })

      const created = await client.sessions.create({ cwd: workspace })
      expect(created.result.ok).toBe(true)
      if (!created.result.ok) throw new Error('create failed')
      const addedSessionId = await sessionAdded
      expect(addedSessionId).toBe(created.result.value.sessionId)

      const listAfter = await client.sessions.list({})
      expect(listAfter.result.ok).toBe(true)

      // Bounded mux window: the stream opens cleanly; no attached sessions today.
      const muxFrameTypes: string[] = []
      const muxController = new AbortController()
      const muxDone = (async () => {
        for await (const frame of client.events.mux({}, muxController.signal)) {
          muxFrameTypes.push(frame.payload.type)
        }
      })()
      await new Promise((resolve) => { setTimeout(resolve, 2_000) })
      muxController.abort()
      await muxDone

      const observations = {
        host: hostFacts,
        sessionsBeforeCreate: (listBefore.result.ok ? listBefore.result.value.items.length : -1),
        createdSessionId: created.result.value.sessionId,
        sessionsAfterCreate: (listAfter.result.ok ? listAfter.result.value.items.length : -1),
        hostFrameTypes,
        muxFrameTypes,
      }
      expect(normalize(observations)).toMatchInlineSnapshot(`
        {
          "createdSessionId": "session-{{uuid}}",
          "host": {
            "attachedSessions": 0,
            "canOpenPath": true,
            "version": "0.0.1",
          },
          "hostFrameTypes": [
            "host/remote-event",
            "host/remote-event",
            "host/session-added",
          ],
          "muxFrameTypes": [
            "session/subscribed",
          ],
          "sessionsAfterCreate": 1,
          "sessionsBeforeCreate": 0,
        }
      `)
    } finally {
      manager.stop()
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      rmSync(dshHome, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 180_000)
})
