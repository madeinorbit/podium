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

/**
 * PDM-410 — THE WINDOW BETWEEN THE DECISION AND THE PARK.
 *
 * PDM-401's guard compares the epoch stamped AT PARK against the epoch read at
 * flush. That interval is not the one that matters. `ApprovalService.approve`
 * authorizes the dispatch in `assertMayDispatch` and then crosses FIVE await
 * points before it reaches `toMachine` -- the pending->executing transition, the
 * audit log, the optional server-op execution, and two more in its result arms.
 * An authority change committing in there bumps the epoch BEFORE the park, so
 * the frame is stamped with the POST-bump value, MATCHES at flush, and is
 * delivered carrying an authorization that stopped being true.
 *
 * THAT CHRONOLOGY IS NOT HYPOTHETICAL AND WAS CHECKED BEFORE ANYTHING WAS BUILT,
 * because the brief that preceded it had the order backwards once already: the
 * awaits are read directly out of `approve`, and the opposite order -- a park
 * BEFORE the bump -- is the safe one PDM-401 already covers.
 *
 * THE FIX is to stamp what the DECISION saw. `assertMayDispatch` reads the epoch
 * BEFORE it asks the authority question, not after: a change committing during
 * the question itself could otherwise be captured as the frame's own baseline,
 * which is the same miss one layer down. Reading first can only stamp a value
 * that is too old, and too old is refused.
 *
 * SEPARATE FROM PDM-411, which asks whether the bump is guaranteed to have
 * landed at all. These tests assume it lands perfectly and on time.
 */
describe('an approval whose authority moved between its decision and its park', () => {
  /**
   * The same wiring PLUS the two members relay.ts passes for PDM-410 — the
   * decision-time read and the stamp-carrying `toMachine`. `duringDecision` runs
   * INSIDE `mayDispatchTo`, which is the only place a test can put a commit that
   * is provably after the decision-time read and before the park.
   */
  async function wiredWithDecisionStamp() {
    let duringDecision: (() => Promise<void>) | undefined
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
      store: store.approvals,
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: (machineId, msg, authorityEpochAtDecision) =>
        machines.toMachine(machineId, msg, authorityEpochAtDecision),
      authorityEpoch: (machineId) => machines.authorityEpoch(machineId),
      hasDaemon: (machineId) => machines.hasDaemon(machineId),
      onDeliveryDiscarded: (sink) => machines.onDeliveryDiscarded(sink),
      clients: () => [],
      sessionOwner: async () => OWNER,
      // The decision still says YES -- it read the pre-change world, which is
      // exactly the race. A check that answered NO would make the frame never
      // exist and prove nothing about the queue.
      mayDispatchTo: async () => {
        await duringDecision?.()
        return true
      },
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: async () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async () => {},
    })
    /**
     * Arm the in-window commit. Set AFTER `request()` and before `approve()`,
     * because `request` ALSO asks `mayDispatchTo` -- a hook armed from the start
     * fires on that earlier call instead, and a second identical owner write is
     * not a change and does not bump. The first version of this test did exactly
     * that and passed for the wrong reason on the grant arm while failing on the
     * owner arm; the asymmetry is what exposed it.
     */
    const setDuringDecision = (hook: () => Promise<void>) => {
      duringDecision = hook
    }
    return { store, machines, approvals, setDuringDecision }
  }

  /** Request now; approve later, so the window can be armed in between. */
  async function requested(approvals: ApprovalService) {
    const { id } = await approvals.request({
      op: { kind: 'channel', target: 'dev' },
      sessionId: SESSION,
      machineId: MACHINE,
    })
    return id
  }

  it('is REFUSED at flush, even though it parked AFTER the epoch had already moved', async () => {
    const { store, machines, approvals, setDuringDecision } = await wiredWithDecisionStamp()
    const id = await requested(approvals)
    const beforeDecision = machines.authorityEpoch(MACHINE)
    setDuringDecision(async () => {
      // T1: the handover commits, and the epoch subscription bumps, while the
      // decision is still being taken. The park at T2 is therefore POST-bump.
      await store.machines.setMachineOwner(MACHINE, asUserId('user:bob'))
    })
    await approvals.approve(id, OWNER)

    // THE PREMISE, ASSERTED RATHER THAN ASSUMED. Without this the test could
    // pass because nothing moved at all, which is the safe case PDM-401 already
    // covers and not the one under test: the epoch really did move inside the
    // window, so a park-time stamp WOULD have matched at flush.
    expect(machines.authorityEpoch(MACHINE)).toBe(beforeDecision + 1)

    const delivered: unknown[] = []
    await machines.attach(MACHINE, (m) => delivered.push(m))
    machines.flushQueued(MACHINE)
    await settle()

    expect(delivered).toEqual([])
    expect((await statusOf(approvals, id)).status).toBe('failed')
  })

  it('a REVOKED SHARE in the same window is refused too, not just a handover', async () => {
    // The grants half of the epoch reaches the same window, and a fix that only
    // carried the stamp for owner moves would leave this one delivered.
    const { store, machines, approvals, setDuringDecision } = await wiredWithDecisionStamp()
    const id = await requested(approvals)
    const beforeDecision = machines.authorityEpoch(MACHINE)
    setDuringDecision(async () => {
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
    })
    await approvals.approve(id, OWNER)
    expect(machines.authorityEpoch(MACHINE)).toBe(beforeDecision + 1)

    const delivered: unknown[] = []
    await machines.attach(MACHINE, (m) => delivered.push(m))
    machines.flushQueued(MACHINE)
    await settle()

    expect(delivered).toEqual([])
    expect((await statusOf(approvals, id)).status).toBe('failed')
  })

  it('with NOTHING moving in the window, the decision-time stamp still delivers', async () => {
    // THE COST DIRECTION. A stamp taken at the wrong moment -- or a fix that
    // simply always refused -- would pass both tests above and silently stop the
    // broker ever dispatching to an offline machine again.
    const { machines, approvals } = await wiredWithDecisionStamp()

    const id = await requested(approvals)
    await approvals.approve(id, OWNER)
    const delivered: unknown[] = []
    await machines.attach(MACHINE, (m) => delivered.push(m))
    machines.flushQueued(MACHINE)
    await settle()

    expect(delivered).toHaveLength(1)
    expect((await statusOf(approvals, id)).status).toBe('executing')
  })

  it('a broker with NO decision-time port keeps the older, narrower guarantee', async () => {
    // The port is optional so the forty-odd internal `toMachine` callers need no
    // edit. That optionality must mean "stamp at park, as before" and not
    // "stamp with undefined and match everything": the frame below parks BEFORE
    // its authority moves, which is the case the old guard does cover, and it
    // must still be refused.
    const { store, machines, approvals } = await wired()
    const id = await parkedApproval(approvals)

    await store.machines.setMachineOwner(MACHINE, asUserId('user:bob'))
    const delivered: unknown[] = []
    await machines.attach(MACHINE, (m) => delivered.push(m))
    machines.flushQueued(MACHINE)
    await settle()

    expect(delivered).toEqual([])
    expect((await statusOf(approvals, id)).status).toBe('failed')
  })
})
