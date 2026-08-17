import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { type DaemonMessage, parseDaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { type DaemonHandle, startDaemon } from './daemon'
import { DiscoveryWorkerClient, type WorkerLike } from './worker-client'

/**
 * POD-1229. Run a second Podium instance on one machine and its daemon's hook
 * ingest finds :45777 already held. That bind error used to reject out of
 * `createDaemonHostRuntime`, so `startDaemon` never returned, no server
 * connection was ever made, and the ONLY thing anyone saw was the machine
 * reading offline — its folders unbrowsable, no agent placeable, and nothing
 * anywhere naming a port.
 *
 * What this file pins: the daemon comes up anyway, and the conflict arrives as
 * an addressed machine diagnostic rather than as silence.
 */
describe('daemon boot with a taken hook port', () => {
  const cleanup: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  /** A worker that never spawns a thread: this file exercises boot, not discovery. */
  function idleWorkerClient(): DiscoveryWorkerClient {
    return new DiscoveryWorkerClient({
      spawn: (): WorkerLike => ({
        postMessage() {},
        on() {},
        terminate() {},
      }),
    })
  }

  async function holdPort(): Promise<number> {
    const squatter: Server = createServer(() => {})
    const port = await new Promise<number>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => resolve((squatter.address() as { port: number }).port))
    })
    cleanup.push(() => new Promise<void>((r) => squatter.close(() => r())))
    return port
  }

  async function fakeServer(): Promise<{ url: string; received: DaemonMessage[] }> {
    const received: DaemonMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws: WS) => {
      let authed = false
      ws.on('message', (raw) => {
        if (!authed) {
          authed = true
          const ok: PeerHelloReply = {
            type: 'peerHelloOk',
            v: WIRE_VERSION,
            caps: [],
            name: 'test',
          }
          ws.send(JSON.stringify(ok))
          return
        }
        received.push(parseDaemonMessage(raw.toString()))
      })
    })
    cleanup.push(async () => {
      for (const client of wss.clients) client.terminate()
      await Promise.race([
        new Promise<void>((r) => wss.close(() => r())),
        new Promise<void>((r) => setTimeout(r, 100)),
      ])
    })
    return { url: `ws://localhost:${(wss.address() as { port: number }).port}`, received }
  }

  async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  async function bootDaemon(opts: {
    serverUrl: string
    hookPort: number
    relayPort: number
  }): Promise<DaemonHandle> {
    const settingsDir = mkdtempSync(join(tmpdir(), 'podium-portconflict-'))
    const daemon = await startDaemon({
      serverUrl: opts.serverUrl,
      bootstrapToken: 'test',
      hooks: { port: opts.hookPort, settingsDir },
      agentRelay: { port: opts.relayPort },
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      workerClient: idleWorkerClient(),
    })
    cleanup.push(() => {
      rmSync(settingsDir, { recursive: true, force: true })
    })
    cleanup.push(() => daemon.close())
    return daemon
  }

  it('comes up on another port and reports the conflict to the server', async () => {
    const takenHookPort = await holdPort()
    const server = await fakeServer()

    const daemon = await bootDaemon({
      serverUrl: server.url,
      hookPort: takenHookPort,
      relayPort: 0,
    })

    // The point of the fix: a daemon at all.
    expect(daemon.hookPort).toBeGreaterThan(0)
    expect(daemon.hookPort).not.toBe(takenHookPort)

    await waitFor(() => server.received.some((m) => m.type === 'machineDiagnostic'))
    const diagnostic = server.received.find(
      (m): m is Extract<DaemonMessage, { type: 'machineDiagnostic' }> =>
        m.type === 'machineDiagnostic',
    )
    expect(diagnostic?.code).toBe('hook-ingest-port-conflict')
    expect(diagnostic?.title).toContain(String(takenHookPort))
    expect(diagnostic?.body).toContain(String(daemon.hookPort))
    expect(diagnostic?.body).toContain('PODIUM_HOOK_PORT')
    expect(diagnostic?.description).toBeTruthy()
  })

  it('reports the agent relay port separately', async () => {
    const takenRelayPort = await holdPort()
    const server = await fakeServer()

    const daemon = await bootDaemon({
      serverUrl: server.url,
      hookPort: 0,
      relayPort: takenRelayPort,
    })

    expect(daemon.agentRelayPort).not.toBe(takenRelayPort)
    await waitFor(() => server.received.some((m) => m.type === 'machineDiagnostic'))
    const codes = server.received
      .filter((m) => m.type === 'machineDiagnostic')
      .map((m) => (m as Extract<DaemonMessage, { type: 'machineDiagnostic' }>).code)
    expect(codes).toContain('agent-relay-port-conflict')
    expect(codes).not.toContain('hook-ingest-port-conflict')
  })

  it('says nothing when both ports are free', async () => {
    const server = await fakeServer()
    await bootDaemon({ serverUrl: server.url, hookPort: 0, relayPort: 0 })
    // Give the connect handler the same window the assertions above use.
    await waitFor(() => server.received.length > 0)
    await new Promise((r) => setTimeout(r, 100))
    expect(server.received.filter((m) => m.type === 'machineDiagnostic')).toEqual([])
  })
})
