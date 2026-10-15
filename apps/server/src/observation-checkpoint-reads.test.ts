/**
 * OLD/NEW COMPARISON FOR THE OBSERVATION CHECKPOINT MAP [POD-6159, design §7 step 3.2].
 *
 * Before the in-memory lease book (`SessionObservationLeases`) is deleted, this
 * walks a session through every path that writes a lease — new, resumed,
 * rebooted, torn down, killed, purged — and after each step asks the old copy and the
 * database the same question. Where they agree, switching the readers to the
 * database changes no answer. Where they disagree, the case is named here and
 * the database answer is the right one.
 */
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import type { ObservationLeaseRecord } from './store/types'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const at = (second: number) => `2026-07-18T12:00:${String(second).padStart(2, '0')}.000Z`
const idle: AgentRuntimeState = { phase: 'idle', since: at(10), workingMsTotal: 0, nativeSubagentCount: 0 }

const book = (reg: SessionRegistry) =>
  (reg.modules.sessions as unknown as {
    observationLeases: { get(sessionId: SessionId): ObservationLeaseRecord | undefined }
  }).observationLeases

/** The map's answer and the database's answer for one session. */
async function answers(reg: SessionRegistry, store: SessionStore, sessionId: SessionId) {
  return {
    map: book(reg).get(sessionId) ?? null,
    database: await store.observationCheckpoints.get(sessionId),
  }
}

async function expectSameAnswer(reg: SessionRegistry, store: SessionStore, sessionId: SessionId) {
  const { map, database } = await answers(reg, store, sessionId)
  expect(map).toEqual(database)
}

const snapshot = (sessionId: SessionId, generation: number, providerSessionId: string): AgentObservation => ({
  podiumSessionId: sessionId,
  provider: 'codex',
  providerSessionId,
  bindingVersion: 1,
  providerTurnId: null,
  providerPromptId: null,
  observerGeneration: generation,
  providerCursor: { segmentId: 'rollout-1', components: { file: 10 } },
  providerAt: at(10),
  receivedAt: at(11),
  sourceEventKind: 'rollout_fold',
  transitionKind: 'snapshot',
  provenance: 'bootstrap',
  inputOrigin: 'provider',
  turnEpoch: 0,
  priorPhase: 'unknown',
  nextPhase: 'idle',
  transitionId: `snapshot-${generation}`,
  state: idle,
})

async function boundSession(reg: SessionRegistry, cwd: string): Promise<SessionId> {
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'codex',
    cwd,
    agentKind: 'codex',
    geometry: { cols: 80, rows: 24 },
  } as never)
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'codex-thread', value: 'thread-1' },
    confidence: 'exact',
  })
  return sessionId
}

describe('observation checkpoint map against the database', () => {
  it('gives the same lease for new, resumed, rebooted and torn-down sessions', async () => {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg)

    // New session: the spawn fence, then the bind, then the first snapshot.
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/proj' })
    await expectSameAnswer(reg, store, sessionId)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex',
      cwd: '/proj',
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
    } as never)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
      confidence: 'exact',
    })
    await expectSameAnswer(reg, store, sessionId)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentObservation',
      observation: snapshot(sessionId, 1, 'thread-1'),
    })
    expect((await store.observationCheckpoints.get(sessionId))?.checkpoint).not.toBeNull()
    await expectSameAnswer(reg, store, sessionId)

    // Resumed onto a new provider thread: the exact rebind.
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentObservationRebind',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 1,
      bindingVersion: 1,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-1',
    })
    expect((await store.observationCheckpoints.get(sessionId))?.providerSessionId).toBe('thread-2')
    await expectSameAnswer(reg, store, sessionId)

    // Torn down: hibernation keeps the row and its lease.
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toMatchObject({ ok: true })
    await expectSameAnswer(reg, store, sessionId)

    // Rebooted: the next server reads its book from the same rows.
    await reg.dispose()
    const restarted = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(restarted)
    await expectSameAnswer(restarted, store, sessionId)

    await restarted.dispose()
    await store.close()
  })

  it('names the two cases where the map and the database disagree', async () => {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg)

    // A writer outside this process advances the fence: the map keeps the old
    // generation until this process next writes or reads it through the store.
    const foreign = await boundSession(reg, '/foreign')
    await store.observationCheckpoints.advanceGeneration(foreign, 'codex', null)
    const advanced = await answers(reg, store, foreign)
    expect(advanced.map?.observationGeneration).toBe(1)
    expect(advanced.database?.observationGeneration).toBe(2)

    // Killed: a kill tombstones the row and keeps its lease, so both agree.
    // The hard purge that follows removes the lease; the map never shrinks.
    const killed = await boundSession(reg, '/killed')
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentObservation',
      observation: snapshot(killed, 1, 'thread-1'),
    })
    await expectSameAnswer(reg, store, killed)
    await reg.modules.sessions.killSession({ sessionId: killed })
    await expectSameAnswer(reg, store, killed)
    await store.sessions.purgeSession(killed)
    const purged = await answers(reg, store, killed)
    expect(purged.map).not.toBeNull()
    expect(purged.database).toBeNull()

    await reg.dispose()
    await store.close()
  })
})
