import { fileURLToPath } from 'node:url'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { directPtyDurableForTests } from '@podium/process/durable'
import { CAP_SYNC_HTTP_V1, CLIENT_WIRE_VERSION, encode, parseServerMessage } from '@podium/protocol'
import { saveConfig } from '@podium/runtime/config'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { afterAll, describe, it } from 'vitest'
import WebSocket from 'ws'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { startServer } from '../../apps/server/src/test-support/enrolled-server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

/** THIS HOST's machine id (POD-318) — read from `<stateDir>/machine.id`, the same
 *  file the server and the split-mode daemon read. There is no `'local'` constant
 *  any more; a machine id is minted material.
 *
 *  A FUNCTION, not a module-level constant: these harnesses point PODIUM_STATE_DIR
 *  at an isolated directory AFTER the imports run, and a constant would have read
 *  (and minted into) the real state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

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
  new URL('../../packages/pty/test/fixtures/fixture-tui.mjs', import.meta.url),
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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('e2e: daemon -> server -> client', () => {
  it('streams real fixture output to a client, round-trips input, and bumps epoch on takeover', async () => {
    saveConfig({ mode: 'all-in-one' })
    const srv = await startServer()
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    const clients: WebSocket[] = []
    try {
      const machineId = asMachineId(hostMachineId())
      await srv.registry.modules.machines.changeAssignment(
        machineId,
        { server: true, agentExecution: true },
        'relay-fixture',
      )
      await srv.registry.sessionStore.machines.setMachineOwner(
        machineId,
        await firstAdminMemberId(srv.registry.sessionStore),
      )
      // Start the assigned daemon before creating the session.
      daemon = await startDaemon({
        serverUrl: `ws://localhost:${srv.port}`,
        machineToken: srv.machineToken,
        machineId: hostMachineId(),
        hooks: { port: 0 },
        agentRelay: { port: 0 },
        backend: 'none',
        durable: directPtyDurableForTests(),
        launch: () => ({
          cmd: process.execPath,
          args: [FIXTURE],
          cwd: '/tmp',
        }),
      })
      // Create a session after the daemon is connected — the server will immediately
      // send a spawn control message that the daemon picks up.
      const { sessionId } = await srv.registry.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/tmp',
        title: 'e2e-test',
      })
      const connectClient = async () => {
        const client = await openWs(
          `ws://localhost:${srv.port}/client?v=${CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`,
        )
        clients.push(client)
        const collected = collect(client)
        client.send(
          encode({
            type: 'hello',
            clientId: '',
            wireVersion: CLIENT_WIRE_VERSION,
            caps: [CAP_SYNC_HTTP_V1],
            viewport: { cols: 80, rows: 24, dpr: 1 },
          }),
        )
        return { client, collected }
      }
      const { client, collected: c } = await connectClient()
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
      const { client: client2, collected: c2 } = await connectClient()
      try {
        client2.send(encode({ type: 'attach', sessionId }))
        client2.send(encode({ type: 'viewState', visible: [sessionId], focused: sessionId }))
        client2.send(encode({ type: 'resize', sessionId, cols: 100, rows: 30 }))
        client2.send(encode({ type: 'requestControl', sessionId }))
        const getSess = async () =>
          (await srv.registry.modules.sessions.listSessions()).find(
            (s) => s.sessionId === sessionId,
          )
        await waitFor(async () => ((await getSess())?.epoch ?? 0) >= 1)
        // The takeover forwards client2's box; the server's copy moves when the
        // daemon reports the size the pty now has (POD-4771), not on the claim.
        await waitFor(async () => {
          const session = await getSess()
          return session?.geometry.cols === 100 && session?.geometry.rows === 30
        })
        await waitFor(() => c2.text.includes('cols=100 rows=30'))
      } finally {
        client2.close()
      }
    } finally {
      for (const client of clients) client.close()
      await daemon?.close({ reapSessions: true })
      await srv.close()
    }
  }, 20_000)
})
