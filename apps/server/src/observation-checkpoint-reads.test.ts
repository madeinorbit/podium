/**
 * OBSERVATION CHECKPOINTS ARE READ FROM THE DATABASE [POD-6159].
 *
 * The server used to keep every lease in an in-memory book, loaded at boot and
 * never shrunk. Before it was deleted, this file compared the book with the
 * database over the same fixtures (the parent commit, "Compare the observation
 * checkpoint map with the database"): they agreed for new, resumed, torn-down,
 * killed and rebooted sessions, and disagreed only after a write outside this
 * process or a hard purge, where the book was stale. The fixtures stay here as
 * a regression test of what the readers now see.
 */
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const at = (second: number) => `2026-07-18T12:00:${String(second).padStart(2, '0')}.000Z`
const idle: AgentRuntimeState = { phase: 'idle', since: at(10), workingMsTotal: 0, nativeSubagentCount: 0 }

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

const sessionOf = async (reg: SessionRegistry, sessionId: SessionId) =>
  (await reg.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)

describe('observation checkpoint reads', () => {
  it('follows a session through new, resumed, torn-down and rebooted', async () => {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg)

    // New: the spawn fence, then the first snapshot.
    const sessionId = await boundSession(reg, '/proj')
    expect(await store.observationCheckpoints.get(sessionId)).toMatchObject({
      observationGeneration: 1,
      bindingVersion: 1,
      checkpoint: null,
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentObservation',
      observation: snapshot(sessionId, 1, 'thread-1'),
    })
    expect((await store.observationCheckpoints.get(sessionId))?.checkpoint).toMatchObject({
      providerSessionId: 'thread-1',
    })

    // Resumed onto a new provider thread: the rebind reads the lease it fences.
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
    const rebound = await store.observationCheckpoints.get(sessionId)
    expect(rebound).toMatchObject({ providerSessionId: 'thread-2', observationGeneration: 2, bindingVersion: 2 })

    // Torn down: hibernation keeps the lease as it was.
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toMatchObject({ ok: true })
    expect(await store.observationCheckpoints.get(sessionId)).toEqual(rebound)

    // Rebooted: boot restores the agent state from the stored checkpoint.
    const sessionB = await boundSession(reg, '/other')
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentObservation',
      observation: snapshot(sessionB, 1, 'thread-1'),
    })
    await reg.dispose()
    const restarted = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    expect((await sessionOf(restarted, sessionB))?.agentState).toMatchObject({ phase: 'idle', since: at(10) })

    await restarted.dispose()
    await store.close()
  })

  it('sees a fence advanced outside this process on the next frame', async () => {
    const store = await openTestStore(':memory:')
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg)
    const sessionId = await boundSession(reg, '/foreign')
    expect((await sessionOf(reg, sessionId))?.status).toBe('live')

    // Another writer re-fences the session. The old observer's exit is no
    // longer authored by the fenced process, so it is ignored. (The deleted
    // in-memory book still held generation 1 here and accepted it.)
    await store.observationCheckpoints.advanceGeneration(sessionId, 'codex', null)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
      observerGeneration: 1,
    })
    expect((await sessionOf(reg, sessionId))?.status).toBe('live')

    await reg.dispose()
    await store.close()
  })
})
