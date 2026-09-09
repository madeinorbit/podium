import { createHash } from 'node:crypto'
import { asUserId } from '@podium/model'
import type { PeerBuild } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'
import { wireMachineSocket } from './daemon-socket'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Minimal `ws` socket double: records sent frames, lets tests drive `message`/`close`. */
function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  const ws = {
    sent,
    readyState: 1,
    bufferedAmount: 0,
    terminated: false,
    send: (s: string) => sent.push(s),
    terminate: () => {
      ws.terminated = true
      ws.readyState = 3
    },
    ping: () => {},
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      ;(handlers[ev] ??= []).push(cb)
    },
    emit: async (ev: string, ...a: unknown[]) => {
      for (const handler of handlers[ev] ?? []) await handler(...a)
    },
  }
  return ws
}

const frame = (value: unknown): string => JSON.stringify(value)

const hello = (build: PeerBuild) =>
  frame({
    type: 'peerHello',
    v: 1,
    peerRole: 'machine',
    caps: [],
    build,
    credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
  })

/**
 * Only the `server` half survives the row projection unchanged — `agentExecution`
 * is recomputed against the live agent plane — so the sender's own label rides
 * there, and "whose report is on the row" is a direct read.
 */
const serviceReport = (reason: string) => ({
  server: {
    policy: 'enabled',
    state: 'available',
    reason,
    observedAt: '2026-09-09T00:00:00.000Z',
  },
  agentExecution: { policy: 'enabled', state: 'available', observedAt: '2026-09-09T00:00:00.000Z' },
})

const machineReport = (reason: string) =>
  frame({ type: 'machineReport', services: serviceReport(reason) })

const updateStatus = frame({
  type: 'updateStatus',
  grantId: 'grant-1',
  state: 'restarting',
  version: '0.5.0',
})

const OUTGOING: PeerBuild = { appVersion: '0.5.0', supervisorGeneration: 7 }
const SUCCESSOR: PeerBuild = { appVersion: '0.5.1', supervisorGeneration: 8 }

async function registryWithMachine() {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'box',
    hostname: 'box',
    tokenHash: sha256('tok'),
    ownerUserId: asUserId('user:sole'),
  })
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  return { store, registry }
}

const row = async (registry: SessionRegistry) => (await registry.modules.machines.listMachines())[0]

/** Whose machineReport the machine row is currently carrying. */
const reportedBy = async (registry: SessionRegistry): Promise<string | undefined> =>
  (await row(registry))?.services?.server.reason

/**
 * POD-3782. The attach fence (POD-3752) decides which incarnation may establish;
 * it says nothing about a socket that established while it WAS the newest and is
 * still open when its successor takes the slot. On a mixed fleet the outgoing
 * parent does not cede (POD-3765 is not in its build), so it keeps writing for
 * the length of the handover gate — and the report lands on the SUCCESSOR's row,
 * because the build stamped alongside it is read from the map, not the sender.
 */
describe('machine supervisor socket, after the handshake', () => {
  it('records a machineReport from the socket that holds the supervisor slot', async () => {
    const { registry } = await registryWithMachine()
    const ws = fakeWs()
    wireMachineSocket(ws as never, registry)
    await ws.emit('message', hello(SUCCESSOR))

    await ws.emit('message', machineReport('successor'))

    expect(await reportedBy(registry)).toBe('successor')
    expect(await row(registry)).toMatchObject({ appVersion: '0.5.1' })
  })

  it('refuses a machineReport from a supervisor socket that has lost the slot', async () => {
    const { registry } = await registryWithMachine()
    const outgoing = fakeWs()
    wireMachineSocket(outgoing as never, registry)
    await outgoing.emit('message', hello(OUTGOING))
    const successor = fakeWs()
    wireMachineSocket(successor as never, registry)
    await successor.emit('message', hello(SUCCESSOR))
    await successor.emit('message', machineReport('successor'))

    // The parent on its way out reports its own services. It no longer holds the
    // slot, so this must not be stamped onto the successor's build.
    await outgoing.emit('message', machineReport('outgoing'))

    expect(await reportedBy(registry)).toBe('successor')
    expect(await row(registry)).toMatchObject({ appVersion: '0.5.1' })
  })

  it('refuses an updateStatus from a supervisor socket that has lost the slot', async () => {
    const { registry } = await registryWithMachine()
    const onStatus = vi.spyOn(registry.modules.updates, 'onStatus').mockResolvedValue(undefined)
    const outgoing = fakeWs()
    wireMachineSocket(outgoing as never, registry)
    await outgoing.emit('message', hello(OUTGOING))
    const successor = fakeWs()
    wireMachineSocket(successor as never, registry)
    await successor.emit('message', hello(SUCCESSOR))

    // Execution proof for a grant the SUCCESSOR is running: never from this sender.
    await outgoing.emit('message', updateStatus)
    expect(onStatus).not.toHaveBeenCalled()

    await successor.emit('message', updateStatus)
    expect(onStatus).toHaveBeenCalledWith('m1', expect.objectContaining({ type: 'updateStatus' }))
  })

  /**
   * THE SLOT IS NOT YET TAKEN WHEN THE PEER IS TOLD IT MAY SPEAK. `helloOk` goes
   * out BEFORE `attachSupervisor` lands (deliberately — see the ordering note on
   * the daemon path), so a supervisor that answers promptly has its first frame
   * read while the map is still empty. Fencing that on "does this socket hold the
   * slot" without waiting for its own attach terminates the sender that is about
   * to become the holder, and the machine then falls back to nothing.
   */
  it('admits a machineReport that arrives before its own attach has landed', async () => {
    const { registry } = await registryWithMachine()
    const machines = registry.modules.machines
    const attachSupervisor = machines.attachSupervisor.bind(machines)
    let attachReached!: () => void
    const reached = new Promise<void>((resolve) => {
      attachReached = resolve
    })
    let releaseAttach!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseAttach = resolve
    })
    vi.spyOn(machines, 'attachSupervisor').mockImplementation(async (...args) => {
      attachReached()
      await gate
      return attachSupervisor(...args)
    })
    const ws = fakeWs()
    wireMachineSocket(ws as never, registry)

    const handshake = ws.emit('message', hello(SUCCESSOR))
    await reached
    // The peer already has its helloOk and answers, mid-attach.
    const report = ws.emit('message', machineReport('successor'))
    releaseAttach()
    await handshake
    await report

    expect(ws.terminated).toBe(false)
    expect(await reportedBy(registry)).toBe('successor')
  })

  /**
   * DO NOT REGRESS THE ABORT PATH (POD-3752). Once the newer socket closes the
   * map is empty and the predecessor has to be able to serve again — so the
   * refusal has to leave it dialling, not silently muted on a socket it still
   * believes in.
   */
  it('lets the predecessor serve again after an abandoned handover', async () => {
    const { registry } = await registryWithMachine()
    const outgoing = fakeWs()
    wireMachineSocket(outgoing as never, registry)
    await outgoing.emit('message', hello(OUTGOING))
    const successor = fakeWs()
    wireMachineSocket(successor as never, registry)
    await successor.emit('message', hello(SUCCESSOR))
    await outgoing.emit('message', machineReport('outgoing'))

    // The refused sender is closed rather than left half-attached, which is what
    // makes it redial: a drop would leave it reporting into a void for ever.
    expect(outgoing.terminated).toBe(true)
    // ...and that close still cannot evict the socket that holds the slot.
    await outgoing.emit('close')
    await successor.emit('message', machineReport('successor'))
    expect(await reportedBy(registry)).toBe('successor')

    // The successor aborts its handover and goes away.
    await successor.emit('close')

    // The predecessor redials on a fresh socket and serves this machine again.
    const resumed = fakeWs()
    wireMachineSocket(resumed as never, registry)
    await resumed.emit('message', hello(OUTGOING))
    await resumed.emit('message', machineReport('resumed'))

    expect(await reportedBy(registry)).toBe('resumed')
    expect(await row(registry)).toMatchObject({ appVersion: '0.5.0' })
  })
})
