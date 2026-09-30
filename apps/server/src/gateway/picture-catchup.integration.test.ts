/**
 * VIEWER CATCH-UP THROUGH A REAL SERVER (POD-4912, SPEC v4 B2 done-when).
 *
 * A real server, real `/client` websockets and the real session write chain;
 * the daemon is played through the gateway's own routing seams, so the order
 * of every frame is the test's to choose. That is what the N2 regression needs
 * (POD-3190 artifact 53, H1): after a server restart the reset picture that
 * follows a bind can be routed BEFORE the bind's durable write has applied the
 * session's geometry, because that write queues behind every earlier write of
 * the session. The viewer that reattached before the bind must still end up
 * with the picture — an idle agent prints nothing that would repaint it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type MachineId, type SessionId } from '@podium/model'
import {
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  CLIENT_WIRE_VERSION,
  decodeBinaryEnvelope,
  PtyOutputBinaryMetadata,
  type ServerMessage,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { noJanitorWorkerForTests } from '../janitor-host'
import { startServer } from '../server'
import { loginTestClient } from '../test-support/client-auth'
import { attachHostDaemon } from '../test-support/host-daemon'

const priorStateDir = process.env.PODIUM_STATE_DIR
const CLIENT_PASSWORD = 'picture-catchup-client-password'

type Handle = Awaited<ReturnType<typeof startServer>>

interface Viewer {
  ws: WebSocket
  /** Every PTY payload this viewer received, in order. */
  payloads: string[]
  json: ServerMessage[]
  text(): string
}

async function connectViewer(
  port: number,
  cookieHeader: string,
  sessionId: SessionId,
): Promise<Viewer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client?cap=sync.http.v1`, {
    headers: { Cookie: cookieHeader },
  })
  const payloads: string[] = []
  const json: ServerMessage[] = []
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const decoded = decodeBinaryEnvelope(new Uint8Array(raw as Buffer), PtyOutputBinaryMetadata)
      if (decoded.metadata.sessionId === sessionId)
        payloads.push(Buffer.from(decoded.payload).toString('latin1'))
      return
    }
    json.push(JSON.parse(raw.toString()) as ServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: [CAP_TERMINAL_OUTPUT_BINARY_V1, 'sync.http.v1'],
      wireVersion: CLIENT_WIRE_VERSION,
    }),
  )
  // The attach is routed once the hello has been answered.
  await until(() => json.some((m) => m.type === 'welcome'))
  ws.send(JSON.stringify({ type: 'attach', sessionId }))
  await until(
    () => json.some((m) => m.type === 'attached' && m.sessionId === sessionId),
    10_000,
    () =>
      `no attached; got ${JSON.stringify(json.map((m) => ('outcome' in m ? `${m.type}:${m.outcome}` : m.type)))}`,
  )
  return { ws, payloads, json, text: () => payloads.join('') }
}

async function until(
  pred: () => boolean,
  timeoutMs = 10_000,
  why: () => string = () => 'timed out waiting',
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(why())
    await new Promise((r) => setTimeout(r, 10))
  }
}

const picture = (sessionId: SessionId, text: string, cols: number, rows: number) => ({
  type: 'ptyPicture' as const,
  sessionId,
  reason: 'reset' as const,
  cols,
  rows,
  bytes: Buffer.from(text, 'latin1'),
})
const data = (sessionId: SessionId, text: string) => ({
  sessionId,
  sourceFrames: 1,
  bytes: Buffer.from(text, 'latin1'),
})

describe('viewer catch-up through a real server', () => {
  let stateDir: string
  let handle: Handle
  let machineId: MachineId
  let cookieHeader: string
  let originalPassword: string | undefined
  const toDaemon: ControlMessage[] = []

  const bind = (sessionId: SessionId, cols: number, rows: number) =>
    handle.registry.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'shell',
      cwd: '/repo',
      agentKind: 'shell',
      geometry: { cols, rows },
      pictures: true,
    })

  async function boot(): Promise<void> {
    handle = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    machineId = handle.registry.modules.machines.hostMachineId
    cookieHeader = (
      await loginTestClient({
        origin: `http://127.0.0.1:${handle.port}`,
        password: CLIENT_PASSWORD,
      })
    ).cookieHeader
    await attachHostDaemon(handle.registry, (msg: ControlMessage) => {
      toDaemon.push(msg)
    })
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-picture-catchup-'))
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    originalPassword = process.env.PODIUM_PASSWORD
    process.env.PODIUM_PASSWORD = CLIENT_PASSWORD
    await boot()
  })

  afterAll(async () => {
    await handle?.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (originalPassword === undefined) delete process.env.PODIUM_PASSWORD
    else process.env.PODIUM_PASSWORD = originalPassword
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('a cold attach gets exactly the picture then the tail, and no older byte', async () => {
    const { sessionId } = await handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      machineId,
    })
    const sid = asSessionId(sessionId)
    await bind(sid, 80, 24)
    handle.registry.gateway.routeDaemonOutput(machineId, data(sid, 'OLDER BYTES '))
    handle.registry.gateway.routeDaemonOutput(machineId, picture(sid, '\x1bc<SCREEN>', 80, 24))
    handle.registry.gateway.routeDaemonOutput(machineId, data(sid, 'tail'))
    const viewer = await connectViewer(handle.port, cookieHeader, sid)
    await until(() => viewer.text().includes('tail'))
    expect(viewer.text()).toBe('\x1bc<SCREEN>tail')
    expect(viewer.json.find((m) => m.type === 'attached')).toMatchObject({ resumed: true })
    viewer.ws.close()
  })

  it('a controller change leaves no viewer blank', async () => {
    const { sessionId } = await handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      machineId,
    })
    const sid = asSessionId(sessionId)
    await bind(sid, 80, 24)
    handle.registry.gateway.routeDaemonOutput(machineId, picture(sid, '\x1bc<P>', 80, 24))
    const a = await connectViewer(handle.port, cookieHeader, sid)
    const b = await connectViewer(handle.port, cookieHeader, sid)
    await until(() => a.text() === '\x1bc<P>' && b.text() === '\x1bc<P>')
    b.ws.send(JSON.stringify({ type: 'requestControl', sessionId: sid }))
    // The epoch changed: both are owed and served again, instead of a blank clear.
    await until(() => a.text() === '\x1bc<P>\x1bc<P>' && b.text() === '\x1bc<P>\x1bc<P>')
    a.ws.close()
    b.ws.close()
  })

  it("a spectator's redraw never reaches the daemon; it is served the picture again", async () => {
    const { sessionId } = await handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      machineId,
    })
    const sid = asSessionId(sessionId)
    await bind(sid, 80, 24)
    handle.registry.gateway.routeDaemonOutput(machineId, picture(sid, '\x1bc<P>', 80, 24))
    const controller = await connectViewer(handle.port, cookieHeader, sid)
    const spectator = await connectViewer(handle.port, cookieHeader, sid)
    await until(() => spectator.text() === '\x1bc<P>')
    const before = toDaemon.filter((m) => m.type === 'redraw' && m.sessionId === sid).length
    spectator.ws.send(JSON.stringify({ type: 'redrawRequest', sessionId: sid }))
    await until(() => spectator.text() === '\x1bc<P>\x1bc<P>')
    expect(toDaemon.filter((m) => m.type === 'redraw' && m.sessionId === sid)).toHaveLength(before)
    controller.ws.send(JSON.stringify({ type: 'redrawRequest', sessionId: sid }))
    await until(
      () => toDaemon.filter((m) => m.type === 'redraw' && m.sessionId === sid).length > before,
    )
    expect(toDaemon.filter((m) => m.type === 'redraw' && m.sessionId === sid).at(-1)).toEqual({
      type: 'redraw',
      sessionId: sid,
      hard: true,
    })
    controller.ws.close()
    spectator.ws.close()
  })

  it('N2: after a server restart an idle agent is not blank, even with its bind held in the write chain', async () => {
    const { sessionId } = await handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
      machineId,
    })
    const sid = asSessionId(sessionId)
    await bind(sid, 80, 24)
    handle.registry.gateway.routeDaemonOutput(machineId, picture(sid, '\x1bc<BEFORE>', 80, 24))
    await handle.registry.modules.sessions.repository.flushActivity()

    // The server restarts. Its sessions come back from the database with no
    // picture, no pictures flag and no viewers.
    await handle.close()
    toDaemon.length = 0
    await boot()
    const viewer = await connectViewer(handle.port, cookieHeader, sid)

    // The daemon rebinds at a new size (the pty was resized while the server
    // was down) and, right behind the bind on the same ordered link, the host's
    // reset picture arrives. The bind's durable write is held behind an earlier
    // write of this session, as a reattach storm holds it.
    const session = handle.registry.modules.sessions.sessions.get(sid)
    if (!session) throw new Error('session did not come back')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = handle.registry.modules.sessions.repository.persist(session, () => held)
    const bound = bind(sid, 100, 30)
    handle.registry.gateway.routeDaemonOutput(
      machineId,
      picture(sid, '\x1bc<IDLE AGENT SCREEN>', 100, 30),
    )
    await new Promise((r) => setTimeout(r, 50))
    // Not servable yet: the picture is 100x30 and the session still says 80x24.
    expect(viewer.text()).not.toContain('<IDLE AGENT SCREEN>')
    release()
    await blocker
    await bound
    // The bind's geometry lands, and that alone serves the owed viewer.
    await until(() => viewer.text().includes('<IDLE AGENT SCREEN>'))
    expect(viewer.text().endsWith('\x1bc<IDLE AGENT SCREEN>')).toBe(true)
    viewer.ws.close()
  })
})
