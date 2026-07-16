import { fileURLToPath } from 'node:url'
import { encode, parseServerMessage } from '@podium/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Without this isolation the test server writes session rows into the REAL
// ~/.podium/podium.db and the daemon parks a REAL durable abduco master that
// outlives the test run — every `vitest run` leaked a fixture agent and ghost
// "/tmp" sessions into the developer's live podium. Must run before
// startServer()/startDaemon() read the env.
const ISOLATION_PORT = 9921
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function collect(ws: WebSocket) {
  let text = ''
  const seen: ReturnType<typeof parseServerMessage>[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw.toString())
    } catch {
      return
    }
    seen.push(msg)
    if (msg.type === 'outputFrame') text += Buffer.from(msg.data, 'base64').toString('utf8')
  })
  return {
    get text() {
      return text
    },
    get seen() {
      return seen
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('e2e: daemon -> server -> client', () => {
  it('streams real fixture output to a client, round-trips input, and bumps epoch on takeover', async () => {
    const srv = await startServer()
    // Start daemon first so it is attached before we create the session.
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      bootstrapToken: srv.bootstrapToken,
      machineId: LOCAL_MACHINE_ID,
      hooks: { port: 0 },
      agentRelay: { port: 0 },
      launch: () => ({
        cmd: process.execPath,
        args: [FIXTURE],
        cwd: '/tmp',
      }),
    })
    // Create a session after the daemon is connected — the server will immediately
    // send a spawn control message that the daemon picks up.
    const { sessionId } = srv.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/tmp',
      title: 'e2e-test',
    })
    const client = await openWs(`ws://localhost:${srv.port}/client`)
    const c = collect(client)
    try {
      // Attach to the session so the server routes frames to this client.
      client.send(encode({ type: 'attach', sessionId }))
      // Force a fresh repaint so the just-connected client sees current output.
      client.send(encode({ type: 'redrawRequest', sessionId }))
      // 1) live fixture output reaches the client through the full chain
      await waitFor(() => c.text.includes('cols=80 rows=24'))

      // 2) input typed at the client round-trips to the agent and back
      client.send(
        encode({ type: 'input', sessionId, data: Buffer.from('a', 'utf8').toString('base64') }),
      )
      await waitFor(() => c.text.includes('last-input=61'))

      // 3) takeover bumps epoch and resizes the agent. Control must move BETWEEN
      // clients: the first attacher is auto-promoted to controller and re-claiming
      // is a no-op (0d145414), so a SECOND client performs the takeover. Geometry
      // snaps only for clients that declared the session visible via viewState
      // (f332c655), so client2 sends that first.
      const client2 = await openWs(`ws://localhost:${srv.port}/client`)
      const c2 = collect(client2)
      try {
        client2.send(encode({ type: 'attach', sessionId }))
        client2.send(encode({ type: 'viewState', visible: [sessionId], focused: sessionId }))
        client2.send(encode({ type: 'resize', sessionId, cols: 100, rows: 30 }))
        client2.send(encode({ type: 'requestControl', sessionId }))
        const getSess = () =>
          srv.registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
        await waitFor(() => (getSess()?.epoch ?? 0) >= 1)
        expect(getSess()?.geometry).toEqual({ cols: 100, rows: 30 })
        await waitFor(() => c2.text.includes('cols=100 rows=30'))
      } finally {
        client2.close()
      }
    } finally {
      client.close()
      await daemon.close()
      await srv.close()
    }
  }, 20_000)
})
