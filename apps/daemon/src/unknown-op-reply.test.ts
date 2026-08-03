/**
 * POD-1464 — the daemon ANSWERS a repo op its build does not know, over a real socket.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT ONE. The pure helper is easy to test and
 * proves nothing on its own: with the call site deleted from handleControlMessage's catch
 * the helper's own tests stay green while the daemon goes back to answering nothing. The
 * defect being fixed IS the wiring, so the test has to drive a real daemon over a real ws
 * connection and wait for a frame to come back.
 *
 * Observed before the fix on vmi3407763: a bundleFetch op against a 0.1.2-edge.1 daemon
 * produced no reply at all, the server timed out after 35s, and the operator saw only
 * "agent relay timed out" — a stale daemon reading exactly like an unreachable machine.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { startDaemon } from './daemon'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('unknown repo op is answered, not dropped (POD-1464)', () => {
  let dir: string
  let httpServer: Server
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-unknownop-'))
    process.env.PODIUM_STATE_DIR = dir
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    await new Promise<void>((r) => httpServer.listen(0, () => r()))
    port = (httpServer.address() as { port: number }).port
  })
  afterEach(async () => {
    // Restored, not deleted: the hermetic guard runs as a GLOBAL afterEach
    // (test-hermetic-vitest-hooks.ts) and requires it set on the way out too.
    process.env.PODIUM_STATE_DIR = priorStateDir
    for (const c of wss.clients) c.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    httpServer.closeAllConnections?.()
    await new Promise<void>((r) => httpServer.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('replies with a named unsupported-op error instead of leaving the caller to time out', async () => {
    let socket: WebSocket | undefined
    const replies: Record<string, unknown>[] = []
    wss.on('connection', (ws) => {
      socket = ws
      // Complete the handshake the way the rewrite's dialer requires: the ACK first,
      // and it must parse as a `PeerHelloReply`. Sending an application frame before
      // that ack is the named `traffic-before-ack` protocol error, so an ill-formed
      // reply here would fail the connection long before the op under test is read.
      // Same rig as the passing connectivity-state.test.ts.
      ws.once('message', () => {
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: WIRE_VERSION,
          caps: [],
          issuedToken: 'tok-1',
          assignedId: 'm-1',
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
      })
      ws.on('message', (raw) => {
        try {
          replies.push(JSON.parse(raw.toString()) as Record<string, unknown>)
        } catch {}
      })
    })
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      identityDir: dir,
      tmux: false as const,
      hooks: { port: 0, settingsDir: join(dir, 'hooks') },
      agentRelay: { port: 0 },
      discovery: { background: false as const, cachePath: ':memory:' },
      metrics: { background: false as const },
      pairCode: 'CODE-1',
    })
    try {
      // An op this build genuinely does not have. Nothing about the frame is malformed
      // except the one enum value, which is exactly the version-skew shape.
      socket?.send(
        JSON.stringify({
          type: 'repoOpRequest',
          requestId: 'ro-unknown-1',
          op: 'someOpFromTheFuture',
          cwd: '/tmp',
        }),
      )
      // A REPLY MUST ARRIVE. Before the fix nothing came back and this waits out its
      // timeout — which is the user-visible defect reproduced in miniature.
      const result = await new Promise<Record<string, unknown> | undefined>((resolve) => {
        const deadline = Date.now() + 8000
        const tick = setInterval(() => {
          const hit = replies.find((m) => m.requestId === 'ro-unknown-1')
          if (hit || Date.now() > deadline) {
            clearInterval(tick)
            resolve(hit)
          }
        }, 50)
      })
      expect(result, 'daemon sent NO reply — the caller would sit until its timeout').toBeDefined()
      expect(result).toMatchObject({ type: 'repoOpResult', requestId: 'ro-unknown-1', ok: false })
      const output = String(result?.output ?? '')
      expect(output).toContain("'someOpFromTheFuture'")
      expect(output).toMatch(/update the daemon/i)
    } finally {
      await daemon.close()
    }
  }, 30_000)
})
