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
    server.registry.modules.updates.setTarget('stable', {
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

  async function connect(build?: PeerBuild): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/daemon`)
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'daemonSecret', secret: server.bootstrapToken },
      caps: build ? ['update.delivery.feed'] : [],
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

  it('accepts an old daemon hello and leaves its build unreported', async () => {
    const ws = await connect()
    const row = server.registry.modules.machines.listMachines()[0]
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
    const row = server.registry.modules.machines.listMachines()[0]
    expect(row).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
      versionState: 'current',
    })
    expect(row?.supervised).toBeUndefined()
    await close(ws)
  })

  /**
   * POD-2508, through the REAL composition root. Supervision now describes
   * process ownership only: the external payload remains an ordinary fleet
   * install and must stay deliverable after its report crosses the live relay.
   */
  it('keeps a desktop-supervised daemon deliverable in the planner projection', async () => {
    const ws = await connect({
      appVersion: '0.4.1',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      supervised: true,
    })
    const listed = server.registry.modules.machines.listMachines()[0]
    expect(listed).toMatchObject({ supervised: true })

    const planned = server.registry.modules.updates.fleet()[0]
    expect(planned?.supervised).toBe(true)
    expect(machineCanTakeDelivery(planned as WaveMachine, ['feed'])).toBe(true)
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
    const listed = server.registry.modules.machines.listMachines()[0]
    expect(listed).toBeDefined()
    server.registry.modules.machines.recordInventory(asMachineId(listed?.id ?? ''), {
      os: 'darwin',
      arch: 'arm64',
      agents: [],
      tools: [],
    })

    const planned = server.registry.modules.updates.fleet()[0]
    expect(planned?.platform).toBe('darwin-aarch64')
    expect(machineCanTakeTargetPlatform(planned as WaveMachine, ['linux-x86_64'])).toBe(false)
    await close(ws)
  })
})
