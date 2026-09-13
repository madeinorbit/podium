/**
 * PDM-414 — THE PRODUCTION EDGE FROM A REFUSED QUEUE DISPATCH TO A SETTLED ROW.
 *
 * The machines tests exercise the discard CALLBACK and the approvals tests call
 * `onExecDiscarded` DIRECTLY. Both passed while the two halves were joined only
 * by a line in a composition root — delete that line and every one of them stayed
 * green. This file is the witness that binds them: a REAL `MachinesService` and a
 * REAL `ApprovalService`, joined exactly as `relay.ts` joins them, with the frame
 * parked and flushed through the actual queue rather than simulated.
 *
 * It also pins the thing the refusal text must NOT say. The epoch bumps on any
 * access-configuration change, which includes a grant ADDITION and an edit to an
 * unrelated grantee — neither of which takes anything from the caller. A message
 * asserting a handover or a lost right is false in those cases.
 */
import { asIssueId, asMachineId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { MachinesService, type MachinesDeps } from '../machines/service'
import { SessionStore } from '../../store'
import { ApprovalService } from './service'

const MACHINE = asMachineId('m1')
const OWNER = firstAdminMemberId()
const SESSION = asSessionId('s1')

/** A real queue and a real broker, wired the way the composition root wires them. */
async function wired() {
  const store = await SessionStore.open(':memory:')
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'ludovico',
    hostname: 'ludovico.local',
    tokenHash: 'token-hash',
    ownerUserId: OWNER,
  })
  const machines = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
  } satisfies MachinesDeps)
  await machines.ownersSeeded

  const approvals = new ApprovalService({
    // The same repository relay.ts passes (`this.store.approvals`).
    store: store.approvals,
    now: () => '2026-07-13T00:00:00.000Z',
    toMachine: (machineId, msg) => machines.toMachine(machineId, msg),
    hasDaemon: (machineId) => machines.hasDaemon(machineId),
    // THE EDGE UNDER TEST — the same one relay.ts passes.
    onDeliveryDiscarded: (sink) => machines.onDeliveryDiscarded(sink),
    clients: () => [],
    sessionOwner: async () => OWNER,
    mayDispatchTo: async () => true,
    sessionIssueId: () => asIssueId('iss_1'),
    issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
    machineName: async () => 'ludovico',
    logEvent: () => {},
    notifyIssue: async () => {},
  })
  return { store, machines, approvals }
}

/** Approve while the daemon is AWAY, so the exec frame parks in the real queue. */
async function parkedApproval(approvals: ApprovalService) {
  const { id } = await approvals.request({
    op: { kind: 'channel', target: 'dev' },
    sessionId: SESSION,
    machineId: MACHINE,
  })
  await approvals.approve(id, OWNER)
  return id
}

/** Let the registered sink's `void this.onExecDiscarded(...)` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const statusOf = async (approvals: ApprovalService, id: string) =>
  await approvals.get({ id }, { sessionId: SESSION, user: OWNER })

describe('a parked approval refused by the real queue', () => {
  it('reaches a terminal state through the wiring, after an OWNER CHANGE', async () => {
    const { store, machines, approvals } = await wired()
    const id = await parkedApproval(approvals)
    expect((await statusOf(approvals, id)).status).toBe('executing')

    await store.machines.setMachineOwner(MACHINE, asUserId('user:bob'))
    await machines.attach(MACHINE, () => {})
    machines.flushQueued(MACHINE)
    await settle()

    const w = await statusOf(approvals, id)
    expect(w.status).toBe('failed')
    expect(w.resultText).toMatch(/access configuration changed/i)
  })

  it('reaches a terminal state after a USE GRANT IS REVOKED', async () => {
    const { store, machines, approvals } = await wired()
    await store.grants.upsert({
      resourceKind: 'machine',
      resourceId: MACHINE,
      grantee: 'user:carol',
      verb: 'use',
      owner: OWNER,
      visibility: 'private',
      createdAt: '2026-07-13T00:00:00.000Z',
      actorKind: 'user',
      actorId: OWNER,
      onBehalfOf: null,
    })
    const id = await parkedApproval(approvals)

    expect(await store.grants.remove('machine', MACHINE, 'user:carol', 'use')).toBe(true)
    await machines.attach(MACHINE, () => {})
    machines.flushQueued(MACHINE)
    await settle()

    expect((await statusOf(approvals, id)).status).toBe('failed')
  })

  it('after a PURE GRANT ADDITION, settles WITHOUT claiming anyone lost access', async () => {
    // Nothing was taken from anybody here — a second person was ADDED. The
    // refusal is still correct (the server cannot confirm the old answer holds),
    // but a message blaming a handover or a lost right would be a plain lie.
    const { store, machines, approvals } = await wired()
    const id = await parkedApproval(approvals)

    await store.grants.upsert({
      resourceKind: 'machine',
      resourceId: MACHINE,
      grantee: 'user:dave',
      verb: 'use',
      owner: OWNER,
      visibility: 'private',
      createdAt: '2026-07-13T00:00:00.000Z',
      actorKind: 'user',
      actorId: OWNER,
      onBehalfOf: null,
    })
    await machines.attach(MACHINE, () => {})
    machines.flushQueued(MACHINE)
    await settle()

    const w = await statusOf(approvals, id)
    expect(w.status).toBe('failed')
    expect(w.resultText).not.toMatch(/changed hands/i)
    expect(w.resultText).not.toMatch(/no longer yours/i)
    expect(w.resultText).not.toMatch(/machine you (currently )?own/i)
  })

  it('an untouched machine still dispatches — the wiring does not settle what it should not', async () => {
    // THE OTHER DIRECTION. If every flush settled the row as refused, all three
    // tests above would pass while the broker never dispatched anything again.
    const { machines, approvals } = await wired()
    const id = await parkedApproval(approvals)

    const delivered: unknown[] = []
    await machines.attach(MACHINE, (m) => delivered.push(m))
    machines.flushQueued(MACHINE)
    await settle()

    expect(delivered).toHaveLength(1)
    expect((await statusOf(approvals, id)).status).toBe('executing')
  })
})
