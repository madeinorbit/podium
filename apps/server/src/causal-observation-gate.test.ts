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
})
