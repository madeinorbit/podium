import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentStateProviderFor,
  type AgentStateEvent,
  type AgentStateProvider,
} from '@podium/agent-bridge'
import type { DaemonMessage } from '@podium/protocol'
import type { StatTick } from '@podium/transcript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionObservers,
  IDLE_TRANSITION_DEBOUNCE_MS,
  type SpawnControl,
} from './session-observers'

class ManualStatTick implements StatTick {
  readonly watchers = new Set<() => void>()

  subscribe(watcher: () => void): () => void {
    this.watchers.add(watcher)
    return () => this.watchers.delete(watcher)
  }
}

const G = { cols: 80, rows: 24 }

function agentStateMsgs(sent: DaemonMessage[], sessionId: string) {
  return sent.filter(
    (m): m is Extract<DaemonMessage, { type: 'agentState' }> =>
      m.type === 'agentState' && m.sessionId === sessionId,
  )
}

/**
 * Stand up a tracker + observation with a mock provider so tests can feed
 * exact AgentStateEvents through onHookPayload → applyAgentStateEvents.
 */
function setupControlledSession(sessionId = 's-idle') {
  const sent: DaemonMessage[] = []
  let nextEvents: AgentStateEvent[] = []
  const provider: AgentStateProvider = {
    instrumentation: () => ({ args: [] }),
    translate: async () => {
      const events = nextEvents
      nextEvents = []
      return events
    },
  }
  const observers = createSessionObservers({
    send: (m) => sent.push(m),
    onTranscriptDirty: vi.fn(),
    cwdTracker: { onHookCwd: vi.fn(async () => {}) },
  })
  const msg: SpawnControl = {
    type: 'spawn',
    sessionId,
    agentKind: 'claude-code',
    cwd: '/tmp',
    geometry: G,
    durableLabel: `podium-${sessionId}`,
  }
  observers.initSessionObservers(
    msg,
    // seedOnFrame: false and no bootEvents → session handle unused.
    { onFrame: () => () => {} } as never,
    provider,
    { seedOnFrame: false },
  )

  const apply = async (events: AgentStateEvent[]): Promise<void> => {
    nextEvents = events
    observers.onHookPayload(sessionId, {
      session_id: 'harness-1',
      transcript_path: '/tmp/t.jsonl',
      hook_event_name: 'test',
    })
    // translate is async; flush the microtask that calls applyAgentStateEvents.
    await Promise.resolve()
    await Promise.resolve()
  }

  return { sent, apply, observers, sessionId }
}

describe('session observer stat polling', () => {
  it('shares one daemon tick between a session transcript tail and agent-state observer', () => {
    const statTick = new ManualStatTick()
    const observers = createSessionObservers({
      statTick,
      send: vi.fn(),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })

    observers.bindHeadlessSession('podium-session', 'cursor', '/repo', 'cursor-chat')
    expect(statTick.watchers.size).toBe(2)

    observers.clearSession('podium-session')
    expect(statTick.watchers.size).toBe(0)
  })
})

describe('session observer →idle debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a transition into idle and emits only after the debounce window', async () => {
    const { sent, apply, observers, sessionId } = setupControlledSession()
    await apply([{ kind: 'prompt_submitted' }])
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual(['working'])

    await apply([{ kind: 'turn_completed' }])
    // Still held — no idle on the wire yet.
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual(['working'])
    expect(observers.trackedState(sessionId)?.phase).toBe('idle')

    await vi.advanceTimersByTimeAsync(IDLE_TRANSITION_DEBOUNCE_MS - 1)
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual(['working'])

    await vi.advanceTimersByTimeAsync(1)
    const phases = agentStateMsgs(sent, sessionId).map((m) => m.state.phase)
    expect(phases).toEqual(['working', 'idle'])
    expect(agentStateMsgs(sent, sessionId).at(-1)?.state.idle).toEqual({ kind: 'done' })

    observers.clearSession(sessionId)
  })

  it('cancels a pending idle emission when a non-idle event arrives within the window', async () => {
    const { sent, apply, observers, sessionId } = setupControlledSession()
    await apply([{ kind: 'prompt_submitted' }])
    await apply([{ kind: 'turn_completed' }])
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual(['working'])

    // Resume working before the idle window elapses.
    await apply([{ kind: 'prompt_submitted' }])
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual([
      'working',
      'working',
    ])
    expect(observers.trackedState(sessionId)?.phase).toBe('working')

    await vi.advanceTimersByTimeAsync(IDLE_TRANSITION_DEBOUNCE_MS + 50)
    // Idle must never have been emitted.
    expect(agentStateMsgs(sent, sessionId).every((m) => m.state.phase !== 'idle')).toBe(true)

    observers.clearSession(sessionId)
  })

  it('emits non-idle transitions immediately (needs_user / errored)', async () => {
    const { sent, apply, observers, sessionId } = setupControlledSession()
    await apply([{ kind: 'prompt_submitted' }])
    await apply([{ kind: 'needs_user', need: 'question', summary: 'pick' }])
    expect(agentStateMsgs(sent, sessionId).at(-1)?.state).toMatchObject({
      phase: 'needs_user',
      need: { kind: 'question', summary: 'pick' },
    })

    await apply([{ kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }])
    expect(agentStateMsgs(sent, sessionId).at(-1)?.state).toMatchObject({
      phase: 'errored',
      error: { class: 'rate_limit', retryable: true },
    })
    // No timers needed — non-idle was immediate.
    expect(agentStateMsgs(sent, sessionId).map((m) => m.state.phase)).toEqual([
      'working',
      'needs_user',
      'errored',
    ])

    observers.clearSession(sessionId)
  })

  it('clears pending idle timers on clearSession so teardown cannot leak emits', async () => {
    const { sent, apply, observers, sessionId } = setupControlledSession()
    await apply([{ kind: 'prompt_submitted' }])
    await apply([{ kind: 'turn_completed' }])
    observers.clearSession(sessionId)

    await vi.advanceTimersByTimeAsync(IDLE_TRANSITION_DEBOUNCE_MS + 50)
    expect(agentStateMsgs(sent, sessionId).every((m) => m.state.phase !== 'idle')).toBe(true)
  })
})
describe('Claude causal daemon emission [spec:SP-cdb2]', () => {
  it('buffers live hooks behind one bootstrap ack and preserves the submitted steward origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-causal-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    observers.initSessionObservers(
      {
        type: 'spawn',
        sessionId: 'podium-1',
        agentKind: 'claude-code',
        cwd: dir,
        geometry: G,
        durableLabel: 'podium-podium-1',
        observationGeneration: 7,
        observationBindingVersion: 2,
      },
      { onFrame: () => () => {} } as never,
      agentStateProviderFor('claude-code'),
      { seedOnFrame: false },
    )
    observers.recordInputOrigin('podium-1', 'steward')
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'prompt-1',
    }
    observers.onHookPayload('podium-1', prompt)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(1)
    })
    const snapshot = sent.find((m) => m.type === 'agentObservation')!
    expect(snapshot.observation).toMatchObject({
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
    })
    expect(sent.some((m) => m.type === 'agentState')).toBe(false)

    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      transitionId: snapshot.observation.transitionId,
      result: 'snapshot_applied',
      acceptedCursor: snapshot.observation.providerCursor,
    })
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(2)
    })
    const working = sent.filter((m) => m.type === 'agentObservation').at(-1)!
    expect(working.observation).toMatchObject({
      provenance: 'live',
      transitionKind: 'turn_opened',
      inputOrigin: 'steward',
      observerGeneration: 7,
      providerSessionId: 'claude-1',
      priorPhase: 'idle',
      nextPhase: 'working',
    })

    const stop = { ...prompt, hook_event_name: 'Stop' }
    observers.onHookPayload('podium-1', stop)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(3)
    })
    expect(sent.filter((m) => m.type === 'agentObservation').at(-1)?.observation).toMatchObject({
      transitionKind: 'turn_terminal',
      priorPhase: 'working',
      nextPhase: 'idle',
    })
    observers.onHookPayload('podium-1', stop)
    await Promise.resolve()
    expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(3)
    observers.clearSession('podium-1')
  })
})
