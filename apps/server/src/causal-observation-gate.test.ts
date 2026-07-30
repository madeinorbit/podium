import type { AgentObservation, AgentRuntimeState, ControlMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

const at = (second: number) => `2026-07-18T12:00:${String(second).padStart(2, '0')}.000Z`
const runtime = (
  phase: AgentRuntimeState['phase'],
  second: number,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState => ({
  phase,
  since: at(second),
  workingMsTotal: 0,
  nativeSubagentCount: 0,
  ...extra,
})

describe('causal session observation gate', () => {
  it('restores one snapshot, emits only live edges, and survives restart idempotently', () => {
    const store = new SessionStore(':memory:')
    const sent: ControlMessage[] = []
    const reg = new SessionRegistry(store, {
      ntfy: vi.fn(),
      telegram: vi.fn(),
    })
    reg.modules.sessions.attachDaemon('local', (msg) => sent.push(msg))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })
    const spawn = sent.find(
      (msg): msg is Extract<ControlMessage, { type: 'spawn' }> =>
        msg.type === 'spawn' && msg.sessionId === sessionId,
    )
    expect(spawn?.observationGeneration).toBe(1)
    expect(spawn?.observationBindingVersion).toBe(1)
    expect(spawn?.observationProviderSessionId).toBeNull()

    const effects: AgentObservation[] = []
    reg.bus.on('session.stateChanged', ({ observation }) => {
      if (observation) effects.push(observation)
    })

    const observe = (observation: AgentObservation) =>
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentObservation',
        observation,
      })
    const base: AgentObservation = {
      podiumSessionId: sessionId,
      provider: 'codex',
      providerSessionId: null,
      bindingVersion: 1,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 1,
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
      transitionId: 'snapshot-10',
      state: runtime('idle', 10),
    }

    observe(base)
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState,
    ).toMatchObject({ phase: 'idle', since: at(10) })
    expect(effects).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])

    // Frozen history is cursor-equal even when re-described.
    observe({ ...base, transitionId: 'snapshot-again' })
    expect(effects).toEqual([])

    const working: AgentObservation = {
      ...base,
      provenance: 'live',
      transitionKind: 'turn_opened',
      sourceEventKind: 'task_started',
      providerCursor: { segmentId: 'rollout-1', components: { file: 20 } },
      providerAt: at(20),
      receivedAt: at(21),
      turnEpoch: 1,
      priorPhase: 'idle',
      nextPhase: 'working',
      transitionId: 'turn-1-open',
      state: runtime('working', 20),
    }
    observe(working)
    observe({
      ...working,
      transitionKind: 'activity',
      sourceEventKind: 'token_count',
      providerCursor: { segmentId: 'rollout-1', components: { file: 25 } },
      providerAt: at(25),
      receivedAt: at(26),
      priorPhase: 'working',
      transitionId: 'turn-1-refresh',
      state: runtime('working', 25),
    })
    expect(effects.map((event) => event.transitionId)).toEqual(['turn-1-open'])
    const done: AgentObservation = {
      ...working,
      transitionKind: 'turn_terminal',
      sourceEventKind: 'task_complete',
      providerCursor: { segmentId: 'rollout-1', components: { file: 30 } },
      providerAt: at(30),
      receivedAt: at(31),
      priorPhase: 'working',
      nextPhase: 'idle',
      transitionId: 'turn-1-done',
      state: runtime('idle', 30, { idle: { kind: 'done' } }),
    }
    observe(done)
    expect(effects.map((event) => event.transitionId)).toEqual(['turn-1-open', 'turn-1-done'])
    expect(
      store.events.listEventsSince(0, { kinds: ['session.phase'] }).map((event) => event.payload),
    ).toMatchObject([
      { phase: 'working', transitionId: 'turn-1-open', provenance: 'live' },
      { phase: 'idle', transitionId: 'turn-1-done', provenance: 'live' },
    ])

    // Once v1 exists, a legacy daemon frame cannot downgrade it.
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: runtime('working', 40),
    })
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState,
    ).toMatchObject({ phase: 'idle', since: at(30) })

    reg.dispose()
    const restartedSent: ControlMessage[] = []
    const restarted = new SessionRegistry(store)
    expect(
      restarted.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.agentState,
    ).toMatchObject({ phase: 'idle', since: at(30) })
    restarted.modules.sessions.attachDaemon('local', (msg) => restartedSent.push(msg))
    const reattach = restartedSent.find(
      (msg): msg is Extract<ControlMessage, { type: 'reattach' }> =>
        msg.type === 'reattach' && msg.sessionId === sessionId,
    )
    expect(reattach?.observationGeneration).toBe(2)
    expect(reattach?.observationCheckpoint).toMatchObject({
      provider: 'codex',
      lifecycleObservationGeneration: 1,
      turnEpoch: 1,
      turnState: { phase: 'idle' },
      terminalFence: { turnEpoch: 1 },
    })

    const restartEffects: AgentObservation[] = []
    restarted.bus.on('session.stateChanged', ({ observation }) => {
      if (observation) restartEffects.push(observation)
    })
    restarted.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation: {
        ...done,
        observerGeneration: 2,
        provenance: 'bootstrap',
        transitionKind: 'snapshot',
        sourceEventKind: 'rollout_fold',
        transitionId: 'restart-snapshot',
      },
    })
    expect(restartEffects).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toHaveLength(2)

    restarted.dispose()
    store.close()
  })

  it('routes a foreign lease advance to an explicit rejection acknowledgement', () => {
    const store = new SessionStore(':memory:')
    const sent: ControlMessage[] = []
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', (msg) => sent.push(msg))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })
    store.observationCheckpoints.advanceGeneration(sessionId, 'codex', null)

    expect(() =>
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentObservation',
        observation: {
          podiumSessionId: sessionId,
          provider: 'codex',
          providerSessionId: null,
          bindingVersion: 1,
          providerTurnId: null,
          providerPromptId: null,
          observerGeneration: 1,
          providerCursor: { segmentId: 'rollout-stale', components: { file: 10 } },
          providerAt: at(10),
          receivedAt: at(11),
          sourceEventKind: 'rollout_fold',
          transitionKind: 'snapshot',
          provenance: 'bootstrap',
          inputOrigin: 'provider',
          turnEpoch: 0,
          priorPhase: 'unknown',
          nextPhase: 'idle',
          transitionId: 'stale-foreign-lease',
          state: runtime('idle', 10),
        },
      }),
    ).not.toThrow()
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationAck',
      sessionId,
      transitionId: 'stale-foreign-lease',
      result: 'rejected',
      rejectionReason: 'stale_observer_generation',
    })
    expect(store.observationCheckpoints.get(sessionId)).toMatchObject({
      observationGeneration: 2,
      checkpoint: null,
    })
    reg.dispose()
    store.close()
  })

  it('atomically rebinds an exact native session without phase or notification effects', () => {
    const store = new SessionStore(':memory:')
    const sent: ControlMessage[] = []
    const ntfy = vi.fn()
    const telegram = vi.fn()
    const reg = new SessionRegistry(store, { ntfy, telegram })
    reg.modules.sessions.attachDaemon('local', (msg) => sent.push(msg))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
      confidence: 'exact',
    })
    const effects: AgentObservation[] = []
    reg.bus.on('session.stateChanged', ({ observation }) => {
      if (observation) effects.push(observation)
    })
    const bootstrap: AgentObservation = {
      podiumSessionId: sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 1,
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
      transitionId: 'thread-1-bootstrap',
      state: runtime('idle', 10),
    }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation: bootstrap,
    })
    expect(store.observationCheckpoints.get(sessionId)?.checkpoint).not.toBeNull()

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservationRebind',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 1,
      bindingVersion: 1,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'codex-new-1',
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebindAck',
      result: 'accepted',
      providerSessionId: 'thread-2',
      observerGeneration: 2,
      bindingVersion: 2,
      checkpoint: null,
    })
    expect(store.observationCheckpoints.get(sessionId)).toMatchObject({
      providerSessionId: 'thread-2',
      observationGeneration: 2,
      bindingVersion: 2,
      checkpoint: null,
    })
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.resume,
    ).toEqual({ kind: 'codex-thread', value: 'thread-2' })
    expect(effects).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])
    expect(ntfy).not.toHaveBeenCalled()
    expect(telegram).not.toHaveBeenCalled()

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation: {
        ...bootstrap,
        provenance: 'live',
        transitionKind: 'turn_opened',
        nextPhase: 'working',
        turnEpoch: 1,
        transitionId: 'old-provider-turn',
        state: runtime('working', 20),
      },
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationAck',
      result: 'rejected',
      rejectionReason: 'stale_observer_generation',
      bindingVersion: 1,
    })
    expect(effects).toEqual([])

    const thread2Bootstrap: AgentObservation = {
      ...bootstrap,
      providerSessionId: 'thread-2',
      observerGeneration: 2,
      bindingVersion: 2,
      providerCursor: { segmentId: 'rollout-2', components: { file: 5 } },
      transitionId: 'thread-2-bootstrap',
    }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation: thread2Bootstrap,
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationAck',
      result: 'snapshot_applied',
      bindingVersion: 2,
    })
    expect(effects).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])

    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservationRebind',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 1,
      bindingVersion: 1,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'codex-new-duplicate',
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebindAck',
      result: 'accepted',
      providerSessionId: 'thread-2',
      observerGeneration: 2,
      bindingVersion: 2,
      checkpoint: { providerSessionId: 'thread-2', lastTransitionId: 'thread-2-bootstrap' },
    })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservationRebind',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      observerGeneration: 1,
      bindingVersion: 1,
      nextProviderSessionId: 'thread-3',
      resumeKind: 'codex-thread',
      rebindId: 'codex-new-competing',
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebindAck',
      result: 'rejected',
      providerSessionId: 'thread-2',
      rejectionReason: 'provider_binding_mismatch',
    })
    expect(
      reg.modules.sessions.listSessions().find((session) => session.sessionId === sessionId)
        ?.resume,
    ).toEqual({ kind: 'codex-thread', value: 'thread-2' })
    expect(store.observationCheckpoints.get(sessionId)).toMatchObject({
      providerSessionId: 'thread-2',
      bindingVersion: 2,
      observationGeneration: 2,
      checkpoint: { lastTransitionId: 'thread-2-bootstrap' },
    })
    const thread2Conversation = store.conversations.conversationPodiumId('local', 'thread-2')
    expect(thread2Conversation).toBeDefined()
    expect(store.conversations.conversationPodiumId('local', 'thread-3')).toBeUndefined()
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservationRebind',
      sessionId,
      provider: 'codex',
      providerSessionId: 'thread-2',
      observerGeneration: 2,
      bindingVersion: 2,
      nextProviderSessionId: 'thread-2',
      resumeKind: 'codex-thread',
      rebindId: 'codex-new-same',
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebindAck',
      result: 'accepted',
      providerSessionId: 'thread-2',
      observerGeneration: 2,
      bindingVersion: 2,
    })
    expect(effects).toEqual([])
    expect(store.events.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])

    reg.dispose()
    const restartedSent: ControlMessage[] = []
    const restarted = new SessionRegistry(store)
    restarted.modules.sessions.attachDaemon('local', (msg) => restartedSent.push(msg))
    expect(
      restartedSent.find(
        (msg): msg is Extract<ControlMessage, { type: 'reattach' }> =>
          msg.type === 'reattach' && msg.sessionId === sessionId,
      ),
    ).toMatchObject({
      observationGeneration: 3,
      observationBindingVersion: 2,
      observationProviderSessionId: 'thread-2',
      observationCheckpoint: {
        providerSessionId: 'thread-2',
        bindingVersion: 2,
        providerCursor: { segmentId: 'rollout-2', components: { file: 5 } },
      },
    })
    restarted.dispose()
    store.close()
  })

  it('rolls back resume and lease when conversation linking throws', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.modules.sessions.attachDaemon('local', vi.fn())
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'codex', cwd: '/proj' })
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-1' },
      confidence: 'exact',
    })
    const bootstrap: AgentObservation = {
      podiumSessionId: sessionId,
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 1,
      providerCursor: { segmentId: 'rollout-1', components: { file: 1 } },
      providerAt: at(1),
      receivedAt: at(2),
      sourceEventKind: 'rollout_fold',
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
      inputOrigin: 'provider',
      turnEpoch: 0,
      priorPhase: 'unknown',
      nextPhase: 'idle',
      transitionId: 'bootstrap-1',
      state: runtime('idle', 1),
    }
    reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentObservation',
      observation: bootstrap,
    })
    vi.spyOn(store.conversations, 'linkConversationSegment').mockImplementation(() => {
      throw new Error('link failed')
    })
    expect(() =>
      reg.modules.sessions.onDaemonMessageFrom('local', {
        type: 'agentObservationRebind',
        sessionId,
        provider: 'codex',
        providerSessionId: 'thread-1',
        observerGeneration: 1,
        bindingVersion: 1,
        nextProviderSessionId: 'thread-2',
        resumeKind: 'codex-thread',
        rebindId: 'rollback-rebind',
      }),
    ).toThrow('link failed')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.resume,
    ).toEqual({ kind: 'codex-thread', value: 'thread-1' })
    expect(store.observationCheckpoints.get(sessionId)).toMatchObject({
      providerSessionId: 'thread-1',
      bindingVersion: 1,
      observationGeneration: 1,
      checkpoint: { lastTransitionId: 'bootstrap-1' },
    })
    reg.dispose()
    store.close()
  })
})
