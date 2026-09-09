import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { createHandshakeDialer, type PeerBuild } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { noJanitorWorkerForTests } from '../janitor-host'
import {
  machineCanTakeDelivery,
  machineCanTakeTargetPlatform,
  type WaveMachine,
} from '../modules/updates/wave'
import { startServer } from '../server'

const priorStateDir = process.env.PODIUM_STATE_DIR
const priorAppVersion = process.env.PODIUM_APP_VERSION

describe('machine build report over a live daemon socket', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-build-report-'))
    process.env.PODIUM_STATE_DIR = stateDir
    process.env.PODIUM_APP_VERSION = '0.4.2'
    server = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    await server.registry.modules.updates.setTarget('stable', {
      version: '0.4.2',
      critical: false,
      artifacts: {},
    } as never)
  })

  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorAppVersion === undefined) delete process.env.PODIUM_APP_VERSION
    else process.env.PODIUM_APP_VERSION = priorAppVersion
  })

  async function connect(
    build?: PeerBuild,
    options: { endpoint?: 'daemon' | 'machine'; caps?: string[] } = {},
  ): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${options.endpoint ?? 'daemon'}`)
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'daemonSecret', secret: server.bootstrapToken },
      caps: options.caps ?? (build ? ['update.delivery.feed'] : []),
      ...(build === undefined ? {} : { build }),
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify(dialer.hello())))
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const step = dialer.receive(raw.toString())
        if (step.action === 'established') resolve()
        else if (step.action !== 'deliver') reject(new Error(`handshake ${step.action}`))
      })
    })
    return ws
  }

  async function close(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    })
  }

  /**
   * Resolve once the SERVER has observed a connection change — not once this
   * client has.
   *
   * The two are different moments and the gap is real: `close()` above resolves
   * on the client's own close event, which the client emits as soon as it has
   * the peer's closing frame, while the server's handler is async and still has
   * `detachSupervisor` and its store write ahead of it. Measured here, the row
   * fell back ~7ms after the client called the socket closed, so an assertion
   * placed directly after `close()` reads the pre-fallback row every time —
   * deterministically, not flakily, which is why this looked like a broken
   * fallback rather than a test running ahead of one.
   *
   * The bus event is the signal rather than a sleep because it is emitted at
   * exactly the transition being waited for and nowhere else: `attachDaemon`
   * emits `machine.connected` after the daemon is in the registry, and the
   * supervisor close handler emits `machine.disconnected` only when
   * `detachSupervisor` returned true — after the legacy build has been written
   * and the machine cache invalidated. A timer would only be a guess about how
   * long that takes on the day it runs.
   */
  function serverObserves(event: 'machine.connected' | 'machine.disconnected'): Promise<void> {
    return new Promise<void>((resolve) => {
      const dispose = server.registry.bus.on(event, () => {
        dispose()
        resolve()
      })
    })
  }

  it('accepts an old daemon hello and leaves its build unreported', async () => {
    const ws = await connect()
    const row = (await server.registry.modules.machines.listMachines())[0]
    expect(row).toMatchObject({
      appVersion: null,
      installKind: null,
      deliveryCaps: [],
      versionState: 'unreported',
    })
    await close(ws)
  })

  it('records a new daemon build report after the real handshake', async () => {
    const ws = await connect({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
    })
    const row = (await server.registry.modules.machines.listMachines())[0]
    expect(row).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
      versionState: 'current',
    })
    await close(ws)
  })

  it('prefers a supervisor and suppresses an old daemon reconnect until fallback', async () => {
    const supervisor = await connect(
      {
        appVersion: '0.5.0',
        wireSchemaDigest: 'new',
        installKind: 'installed',
      },
      { endpoint: 'machine', caps: ['update.delivery.feed'] },
    )
    supervisor.send(
      JSON.stringify({
        type: 'machineReport',
        services: {
          server: {
            policy: 'enabled',
            state: 'available',
            observedAt: '2026-08-26T12:00:00.000Z',
          },
          agentExecution: {
            policy: 'enabled',
            state: 'available',
            observedAt: '2026-08-26T12:00:00.000Z',
          },
        },
      }),
    )
    // The daemon attach lands AFTER the handshake reply this client waited for,
    // and the fallback below only runs while a daemon is registered — so wait for
    // the attach the server actually made, not for a turn of the event loop.
    const legacyAttached = serverObserves('machine.connected')
    const legacy = await connect({
      appVersion: '0.4.1',
      wireSchemaDigest: 'old',
      installKind: 'installed',
    })
    await legacyAttached

    expect((await server.registry.modules.machines.listMachines())[0]).toMatchObject({
      online: true,
      presenceSource: 'supervisor',
      appVersion: '0.5.0',
      wireSchemaDigest: 'new',
      deliveryCaps: ['update.delivery.feed'],
    })

    const supervisorDetached = serverObserves('machine.disconnected')
    await close(supervisor)
    await supervisorDetached
    expect((await server.registry.modules.machines.listMachines())[0]).toMatchObject({
      online: true,
      presenceSource: 'legacy-daemon',
      appVersion: '0.4.1',
      wireSchemaDigest: 'old',
    })
    await close(legacy)
  })

  it('projects a Desktop-owned supervisor with no caps as online but undeliverable', async () => {
    const ws = await connect(
      {
        appVersion: '0.4.1',
        wireSchemaDigest: 'abc',
        installKind: 'installed',
      },
      { endpoint: 'machine', caps: [] },
    )
    ws.send(
      JSON.stringify({
        type: 'machineReport',
        services: {
          server: {
            policy: 'disabled',
            state: 'stopped',
            observedAt: '2026-08-26T12:00:00.000Z',
          },
          agentExecution: {
            policy: 'enabled',
            state: 'stopped',
            reason: 'agent execution plane is disconnected',
            observedAt: '2026-08-26T12:00:00.000Z',
          },
          crashOwner: 'desktop',
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const listed = (await server.registry.modules.machines.listMachines())[0]
    expect(listed).toMatchObject({
      online: true,
      presenceSource: 'supervisor',
      deliveryCaps: [],
      services: { crashOwner: 'desktop' },
    })

    const planned = (await server.registry.modules.updates.fleet())[0]
    expect(planned).toMatchObject({
      online: true,
      presenceSource: 'supervisor',
      deliveryUnavailableReason: 'managed by Desktop updater',
    })
    expect(machineCanTakeDelivery(planned as WaveMachine, ['feed'])).toBe(false)
    await close(ws)
  })

  it('keeps legacy supervised build metadata as compatibility-only input', async () => {
    const ws = await connect({
      appVersion: '0.4.1',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      supervised: true,
    })
    const listed = (await server.registry.modules.machines.listMachines())[0]
    expect(listed).toMatchObject({
      presenceSource: 'legacy-daemon',
      deliveryCaps: ['update.delivery.feed'],
    })
    await close(ws)
  })
  /**
   * THE WIRING THE WHOLE POD-2783 GATE HANGS ON, through the REAL composition
   * root.
   *
   * Every refusal added for this issue is a pure predicate over
   * `WaveMachine.platform`, and every one of them answers "yes, eligible" when
   * that field is absent — deliberately, so a machine that has not said what it
   * is stays visible. Which means a composition root that forgets to derive the
   * field turns the entire gate off and every unit test above it still passes.
   * This is the assertion that cannot be satisfied by the module alone.
   */
  it('derives a machine platform from its reported inventory for the planner', async () => {
    const ws = await connect({
      appVersion: '0.4.1',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
    })
    const listed = (await server.registry.modules.machines.listMachines())[0]
    expect(listed).toBeDefined()
    await server.registry.modules.machines.recordInventory(asMachineId(listed?.id ?? ''), {
      os: 'darwin',
      arch: 'arm64',
      agents: [],
      tools: [],
    })

    const planned = (await server.registry.modules.updates.fleet())[0]
    expect(planned?.platform).toBe('darwin-aarch64')
    expect(machineCanTakeTargetPlatform(planned as WaveMachine, ['linux-x86_64'])).toBe(false)
    await close(ws)
  })
})
