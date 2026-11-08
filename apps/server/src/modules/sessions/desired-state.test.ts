/**
 * SESSION LIFECYCLE AS DESIRED STATE (ADR 12 D5 E1, POD-6356).
 *
 * Driven through the REAL composed server (`makeOracle`), over `sync.submit`,
 * the path the apps' outbox takes: `records.session.edit` writes what the
 * session should be, the lifecycle controller acts after the commit through
 * the daemon channel, and every assertion reads back the row and the frames
 * the daemon was sent.
 */

import { asMutationId, asUserId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { SyncSubmitReply } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import { confirmingRetirement } from '../../test-support/host-daemon'
import { appliedReply, envelope, rowsOf, submit } from '../sync-write/outbox-test-support'
import { disposeOracles, makeOracle, type Oracle, waitFor } from './oracle-support'

afterEach(() => disposeOracles())

const RESUME = { kind: 'claude-session', value: 'native-1' } as const

async function goLive(
  o: Oracle,
  sessionId: SessionId,
  phase: 'idle' | 'working' = 'idle',
): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
  await o.reg.gateway.routeDaemonFrame(machineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await o.reg.gateway.routeDaemonFrame(machineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: RESUME,
    confidence: 'exact',
  })
  await o.reg.gateway.routeDaemonFrame(machineId, {
    type: 'agentState',
    sessionId,
    state: { phase, since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

async function liveSession(o: Oracle, phase: 'idle' | 'working' = 'idle'): Promise<SessionId> {
  const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
  await goLive(o, sessionId, phase)
  return sessionId
}

const editEnvelope = (
  id: SessionId,
  patch: Record<string, unknown>,
  expectedRevision: number | undefined,
  m: string,
) =>
  envelope(
    'records.session.edit',
    { id, patch, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    m,
  )

/** Submit, then wait for the controller pass the commit started. */
async function editAndSettle(
  o: Oracle,
  id: SessionId,
  patch: Record<string, unknown>,
  expectedRevision: number | undefined,
  m: string,
): Promise<SyncSubmitReply> {
  const reply = await submit(o, editEnvelope(id, patch, expectedRevision, m))
  await o.reg.modules.sessionLifecycleController.reconcile(id)
  return reply
}

async function lifecycle(o: Oracle, id: SessionId) {
  const state = await o.reg.modules.sessions.desiredStateOf(id)
  if (!state) throw new Error(`no session ${id}`)
  return { status: state.status, ...state.lifecycle }
}

const retirements = (o: Oracle, id: SessionId) =>
  o.daemon.filter(
    (m) => m.type === 'runtimeLifecycleRequest' && (m as { sessionId?: string }).sessionId === id,
  )

const spawns = (o: Oracle, id: SessionId) =>
  o.daemon.filter((m) => m.type === 'spawn' && (m as { sessionId?: string }).sessionId === id)

function refusal(reply: SyncSubmitReply) {
  if (reply.outcome !== 'rejected') {
    throw new Error(`expected a refusal, got ${JSON.stringify(reply)}`)
  }
  return reply.refusal
}

/** The oracle's daemon again, as it attached it (answers retirements and repo ops). */
async function reattach(o: Oracle): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
  await o.reg.gateway.attachDaemon(
    machineId,
    confirmingRetirement(o.reg, machineId, (msg: ControlMessage) => {
      o.daemon.push(msg)
      if (msg.type === 'repoOpRequest') {
        void o.reg.gateway.routeDaemonFrame(machineId, {
          type: 'repoOpResult',
          requestId: msg.requestId,
          ok: true,
          output: '',
        })
      }
    }),
  )
}

describe('records.session.edit', () => {
  it('commits the desired state at once; the controller stops the session after the commit', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)

    const reply = appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-1'))

    expect(reply.result).toEqual({ revision: 2 })
    expect(await lifecycle(o, id)).toMatchObject({
      status: 'hibernated',
      desired: 'stopped',
      force: false,
      revision: 2,
      observedRevision: 2,
      failure: null,
    })
    expect(retirements(o, id)).toHaveLength(1)
    // The edit's change row carries its mutationId; the wire shows the intent.
    expect((await rowsOf(o, 'stop-1')).length).toBeGreaterThan(0)
    expect(await o.reg.modules.sessions.sessionById(id)).toMatchObject({
      desired: 'stopped',
      revision: 2,
      observedRevision: 2,
    })
  })

  it('a late stop is refused by its revision after a newer start, and changes nothing', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-1'))
    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 2, 'start-2'))
    await goLive(o, id)
    const before = retirements(o, id).length

    // Queued on a laptop against revision 1, arriving after the phone's start.
    const late = await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-late')

    expect(refusal(late).kind).toBe('conflict')
    expect(await lifecycle(o, id)).toMatchObject({
      status: 'live',
      desired: 'running',
      revision: 3,
      observedRevision: 3,
    })
    expect(retirements(o, id)).toHaveLength(before)
  })

  it('a replayed edit returns its recorded result and does nothing new', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-1'))
    const acted = retirements(o, id).length

    const again = appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-1'))

    expect(again.replayed).toBe(true)
    expect(again.result).toEqual({ revision: 2 })
    expect(await lifecycle(o, id)).toMatchObject({ revision: 2, observedRevision: 2 })
    expect(retirements(o, id)).toHaveLength(acted)
  })

  it('an edit for an offline machine stays pending and is made true when its daemon reconnects', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)

    appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-offline'))
    expect(await lifecycle(o, id)).toMatchObject({ revision: 2, observedRevision: 1 })
    expect(await o.store.sessions.lifecyclePending(o.reg.sessionStore.hostMachineId)).toEqual([id])

    await reattach(o)
    await waitFor(
      async () => (await lifecycle(o, id)).observedRevision === 2,
      'the reconnect to reconcile the pending stop',
    )
    expect(await lifecycle(o, id)).toMatchObject({ desired: 'stopped', failure: null })
    expect(await o.store.sessions.lifecyclePending(o.reg.sessionStore.hostMachineId)).toEqual([])
    expect(retirements(o, id).length).toBeGreaterThan(0)
  })

  it('a session that exits on its own is never restarted by any trigger', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 1, 'run-1'))
    expect(await lifecycle(o, id)).toMatchObject({
      desired: 'running',
      revision: 2,
      observedRevision: 2,
    })

    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: id,
      code: 0,
    })
    const spawned = spawns(o, id).length
    await o.reg.modules.sessionLifecycleController.reconcileMachine(
      o.reg.sessionStore.hostMachineId,
    )
    await o.reg.modules.sessionLifecycleController.reconcile(id)

    expect((await lifecycle(o, id)).status).toBe('exited')
    expect(spawns(o, id)).toHaveLength(spawned)
  })

  it('a refused action is acknowledged with its reason; the next edit clears it', async () => {
    const o = await makeOracle()
    const id = await liveSession(o, 'working')

    appliedReply(await editAndSettle(o, id, { desired: 'hibernated' }, 1, 'park-1'))

    expect(await lifecycle(o, id)).toMatchObject({
      status: 'live',
      desired: 'hibernated',
      revision: 2,
      observedRevision: 2,
      failure: { revision: 2, reason: 'agent is working — let it reach idle first' },
    })
    expect((await o.reg.modules.sessions.sessionById(id))?.lifecycleFailure).toEqual({
      revision: 2,
      reason: 'agent is working — let it reach idle first',
    })

    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 2, 'run-3'))
    expect(await lifecycle(o, id)).toMatchObject({
      revision: 3,
      observedRevision: 3,
      failure: null,
    })
  })

  it('force qualifies only the stop it is sent with', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'stopped', force: true }, 1, 'force-1'))
    expect(await lifecycle(o, id)).toMatchObject({ desired: 'stopped', force: true })

    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 2, 'run-2'))
    expect(await lifecycle(o, id)).toMatchObject({ desired: 'running', force: false })
  })

  it('refuses a patch naming a status field, a patch without a desired state, and a missing revision', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)

    expect(
      refusal(await submit(o, editEnvelope(id, { observedRevision: 9 }, 1, 'bad-1'))).kind,
    ).toBe('unauthorized')
    expect(refusal(await submit(o, editEnvelope(id, { force: true }, 1, 'bad-2'))).kind).toBe(
      'invalid',
    )
    expect(
      refusal(await submit(o, editEnvelope(id, { desired: 'stopped' }, undefined, 'bad-3'))).kind,
    ).toBe('invalid')
    expect(await lifecycle(o, id)).toMatchObject({
      revision: 1,
      observedRevision: 1,
      desired: null,
    })
  })

  it('an unknown session is refused exactly as one the caller may not command', async () => {
    const o = await makeOracle()
    const ghost = '00000000-0000-4000-8000-000000000000' as SessionId
    // Missing and invisible are one answer at the target check (ADR 3 D20).
    expect(
      refusal(await submit(o, editEnvelope(ghost, { desired: 'stopped' }, 1, 'ghost'))).kind,
    ).toBe('unauthorized')
  })
})

describe('a start is re-authorized when it is acted on', () => {
  /** The admin who made the edits loses `use` on the host: its custody moves
   *  to another member. The machine itself stays paired, so its daemon can
   *  attach again. */
  async function revokeWriterUse(o: Oracle): Promise<void> {
    const other = asUserId('mem_lifecycle_other')
    await o.store.users.create(
      {
        id: other,
        displayName: 'Other',
        role: 'member',
        createdAt: '2026-11-04T00:00:00.000Z',
        disabledAt: null,
      },
      'test-only',
    )
    const host = o.reg.sessionStore.hostMachineId
    await o.reg.modules.machines.transferMachineOwnership(host, other, firstAdminMemberId())
    const ownership = await ownershipSnapshotFromMachines(o.reg.modules.machines)
    expect(
      checkMachineUse(userCommandPrincipal(firstAdminMemberId(), 'admin'), host, ownership),
      'the fixture must actually take use away',
    ).toBeDefined()
  }

  it('a resume applied before the writer lost use does not start the agent on attach', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'hibernated' }, 1, 'park-1'))
    expect((await lifecycle(o, id)).status).toBe('hibernated')
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 2, 'resume-2'))
    expect(await lifecycle(o, id)).toMatchObject({ revision: 3, observedRevision: 2 })
    const spawnedBefore = spawns(o, id).length

    await revokeWriterUse(o)
    await reattach(o)
    await waitFor(
      async () => (await lifecycle(o, id)).observedRevision === 3,
      'the reconnect to answer the pending resume',
    )

    expect(await lifecycle(o, id)).toMatchObject({
      status: 'hibernated',
      desired: 'running',
      failure: { revision: 3, reason: 'no longer allowed to use this machine' },
    })
    expect(spawns(o, id)).toHaveLength(spawnedBefore)
  })

  it('a stop applied before the writer lost use still stops the agent on attach', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    appliedReply(await editAndSettle(o, id, { desired: 'stopped' }, 1, 'stop-1'))

    await revokeWriterUse(o)
    await reattach(o)
    await waitFor(
      async () => (await lifecycle(o, id)).observedRevision === 2,
      'the reconnect to act on the pending stop',
    )

    expect(await lifecycle(o, id)).toMatchObject({ desired: 'stopped', failure: null })
    expect(retirements(o, id).length).toBeGreaterThan(0)
  })
})

describe('records.session.remove (kill)', () => {
  it('deletes the session against its revision, with the remove change on the path', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)

    appliedReply(
      await submit(o, envelope('records.session.remove', { id, expectedRevision: 1 }, 'kill-1')),
    )

    expect(await o.reg.modules.sessions.desiredStateOf(id)).toBeUndefined()
    expect(await rowsOf(o, 'kill-1')).toContainEqual(
      expect.objectContaining({
        entity: 'session',
        op: 'remove',
        mutationId: asMutationId('kill-1'),
      }),
    )
  })

  it('a queued kill that arrives after a newer start is refused and the session survives', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)
    appliedReply(await editAndSettle(o, id, { desired: 'running' }, 1, 'run-1'))

    const late = await submit(
      o,
      envelope('records.session.remove', { id, expectedRevision: 1 }, 'kill-late'),
    )

    expect(refusal(late).kind).toBe('conflict')
    expect(await o.reg.modules.sessions.desiredStateOf(id)).toBeDefined()
  })
})

describe('the old lifecycle routes are adapters onto the path', () => {
  it('hibernate, resurrect and stop record the desired state and answer as before', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)

    expect(await o.call.sessions.hibernate({ sessionId: id })).toEqual({ ok: true })
    expect(await lifecycle(o, id)).toMatchObject({
      status: 'hibernated',
      desired: 'hibernated',
      revision: 2,
      observedRevision: 2,
    })

    expect((await o.call.sessions.resurrect({ sessionId: id })).ok).toBe(true)
    expect(await lifecycle(o, id)).toMatchObject({
      desired: 'running',
      revision: 3,
      observedRevision: 3,
    })
    await goLive(o, id)

    expect((await o.call.sessions.stop({ sessionId: id })).ok).toBe(true)
    expect(await lifecycle(o, id)).toMatchObject({
      desired: 'stopped',
      revision: 4,
      observedRevision: 4,
    })
  })

  it('a hibernate of a session that is not running keeps its pinned refusal', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'not running',
    })
  })

  it('kill removes the record through the path', async () => {
    const o = await makeOracle()
    const id = await liveSession(o)

    await expect(o.call.sessions.kill({ sessionId: id })).resolves.toBeUndefined()

    expect(await o.reg.modules.sessions.desiredStateOf(id)).toBeUndefined()
    const removes = (await o.store.sync.changesSince(0)).filter(
      (row) => row.entity === 'session' && row.op === 'remove' && row.entityId === id,
    )
    expect(removes).toHaveLength(1)
    expect(removes[0]?.mutationId).toMatch(/^mut_route_/)
  })
})
