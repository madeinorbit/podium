import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directPtyDurableForTests } from '@podium/process/durable'
import { type PeerHelloReply, DAEMON_WIRE_VERSION } from '@podium/protocol'
import { type DaemonMessage, parseDaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import { startDaemon } from './daemon'
import { NO_DURABLE_BACKEND_DIAGNOSTIC, noDurableBackendDiagnostic } from './durable-backend'
import { DiscoveryWorkerClient, type WorkerLike } from './worker-client'

/**
 * POD-4617. A daemon with no podium-host BOOTS — the machine stays visible and
 * its inventory and credentials keep working — but refuses every spawn. The
 * person who only ever sees the app must be told why nothing starts, so the
 * condition travels as a machine diagnostic on connect, not only a log line.
 */
describe('daemon boot with no durable backend', () => {
  const cleanup: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  function idleWorkerClient(): DiscoveryWorkerClient {
    return new DiscoveryWorkerClient({
      spawn: (): WorkerLike => ({ postMessage() {}, on() {}, terminate() {} }),
    })
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
          const ok: PeerHelloReply = { type: 'peerHelloOk', v: DAEMON_WIRE_VERSION, caps: [], name: 'test' }
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

  async function boot(serverUrl: string, withDurable: boolean): Promise<void> {
    const settingsDir = mkdtempSync(join(tmpdir(), 'podium-no-host-boot-'))
    const daemon = await startDaemon({
      serverUrl,
      machineToken: 'test',
      hooks: { port: 0, settingsDir },
      agentRelay: { port: 0 },
      backend: 'none',
      ...(withDurable ? { durable: directPtyDurableForTests() } : {}),
      discovery: { background: false, cachePath: ':memory:' },
      workerClient: idleWorkerClient(),
    })
    cleanup.push(() => rmSync(settingsDir, { recursive: true, force: true }))
    cleanup.push(() => daemon.close())
  }

  const diagnostics = (received: DaemonMessage[]) =>
    received.filter(
      (m): m is Extract<DaemonMessage, { type: 'machineDiagnostic' }> => m.type === 'machineDiagnostic',
    )

  it('boots, connects, and tells the app this machine cannot start sessions', async () => {
    const server = await fakeServer()
    await boot(server.url, false)
    await waitFor(() => diagnostics(server.received).length > 0)
    const [diagnostic] = diagnostics(server.received)
    expect(diagnostic).toEqual({ type: 'machineDiagnostic', ...noDurableBackendDiagnostic() })
    expect(diagnostic?.code).toBe(NO_DURABLE_BACKEND_DIAGNOSTIC)
    expect(diagnostic?.body).toContain('podium-host')
    expect(diagnostic?.description).toContain('podium-host')
  })

  it('says nothing when the daemon holds a durable process', async () => {
    const server = await fakeServer()
    await boot(server.url, true)
    await waitFor(() => server.received.length > 0)
    await new Promise((r) => setTimeout(r, 100))
    expect(diagnostics(server.received)).toEqual([])
  })
})
