import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentStateEvent,
  type AgentStateProvider,
  acceptAgentObservation,
  agentStateProviderFor,
  captureClaudeTranscript,
  claudeTranscriptSegmentId,
  type HarnessObserveInput,
  type HarnessObserverHost,
  harnessAdapterFor,
} from '@podium/agent-bridge'
import type {
  AgentObservation,
  DaemonMessage,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import type { StatTick } from '@podium/transcript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAUSAL_DELIVERY_RETRY_BASE_MS,
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

function claudeProvider(): AgentStateProvider {
  const provider = agentStateProviderFor('claude-code')
  if (!provider) throw new Error('Claude provider missing')
  return provider
}

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

describe('generic causal observer host [spec:SP-cdb2]', () => {
  it('waits for a completed provider poll and emits at most one monotonic proof per completion', async () => {
    const statTick = new ManualStatTick()
    const sent: DaemonMessage[] = []
    const completions: Array<() => void> = []
    let bootstrapped = false
    let reading = false
    const cursor = { segmentId: 'rollout-1', components: { file: 20 } }
    const codex = harnessAdapterFor('codex')
    if (!codex) throw new Error('Codex adapter missing')
    const observers = createSessionObservers({
      statTick,
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: (kind) =>
        kind === 'codex'
          ? {
              ...codex,
              observer: (_input, host) => {
                const stop = statTick.subscribe(() => {
                  if (reading) return
                  reading = true
                  void new Promise<void>((resolve) => completions.push(resolve)).then(() => {
                    reading = false
                    if (bootstrapped) host.onLiveObservationCycle?.(cursor)
                  })
                })
                return {
                  stop,
                  onObservationAck: () => {
                    bootstrapped = true
                  },
                }
              },
            }
          : harnessAdapterFor(kind),
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'delayed-poll',
        durableLabel: 'podium-delayed-poll',
        agentKind: 'codex',
        cwd: '/repo',
        geometry: G,
        resume: { kind: 'codex-thread', value: 'thread-1' },
        observationGeneration: 7,
        observationBindingVersion: 2,
        observationProviderSessionId: 'thread-1',
      },
      { onFrame: () => () => {} } as never,
      agentStateProviderFor('codex'),
      { seedOnFrame: false },
    )
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'delayed-poll',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: 'bootstrap',
      result: 'snapshot_applied',
      acceptedCursor: cursor,
    })
    for (const watcher of statTick.watchers) watcher()
    for (const watcher of statTick.watchers) watcher()
    expect(completions).toHaveLength(1)
    expect(sent.filter((message) => message.type === 'agentObserverLiveConfirmation')).toHaveLength(
      0,
    )
    completions.shift()?.()
    await Promise.resolve()
    expect(
      sent.filter((message) => message.type === 'agentObserverLiveConfirmation'),
    ).toMatchObject([{ livePollSequence: 1 }])
    for (const watcher of statTick.watchers) watcher()
    expect(sent.filter((message) => message.type === 'agentObserverLiveConfirmation')).toHaveLength(
      1,
    )
    completions.shift()?.()
    await Promise.resolve()
    expect(
      sent.filter((message) => message.type === 'agentObserverLiveConfirmation'),
    ).toMatchObject([{ livePollSequence: 1 }, { livePollSequence: 2 }])
    for (const watcher of statTick.watchers) watcher()
    completions.shift()?.()
    await Promise.resolve()
    expect(sent.filter((message) => message.type === 'agentObserverLiveConfirmation')).toHaveLength(
      2,
    )
  })
  it('delivers the exact lease, routes exact acks, and fences an accepted native rebind', () => {
    const sent: DaemonMessage[] = []
    const observationAck = vi.fn()
    const rebindAck = vi.fn()
    let input: HarnessObserveInput | undefined
    let host: HarnessObserverHost | undefined
    const codex = harnessAdapterFor('codex')
    if (!codex) throw new Error('Codex adapter missing')
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: (kind) =>
        kind === 'codex'
          ? {
              ...codex,
              observer: (nextInput, nextHost) => {
                input = nextInput
                host = nextHost
                return {
                  stop: vi.fn(),
                  onObservationAck: observationAck,
                  onProviderRebindAck: rebindAck,
                  bindHookThread: (nativeId) =>
                    nextHost.onExactProviderRebind({
                      nextProviderSessionId: nativeId,
                      resumeKind: 'codex-thread',
                      rebindId: 'rebind-1',
                    }),
                }
              },
            }
          : harnessAdapterFor(kind),
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'podium-1',
        durableLabel: 'podium-podium-1',
        agentKind: 'codex',
        cwd: '/repo',
        geometry: G,
        resume: { kind: 'codex-thread', value: 'thread-1' },
        observationGeneration: 7,
        observationBindingVersion: 2,
        observationProviderSessionId: 'thread-1',
        observationCheckpoint: {
          schemaVersion: 1,
          podiumSessionId: 'podium-1',
          provider: 'codex',
          providerSessionId: 'thread-other',
          bindingVersion: 2,
          lifecycleObservationGeneration: 6,
          providerCursor: null,
          bootstrapCursor: null,
          lastAcceptedLiveCursor: null,
          turnEpoch: 0,
          providerTurnId: null,
          providerPromptId: null,
          turnState: {
            phase: 'idle',
            since: '2026-07-19T08:00:00.000Z',
            nativeSubagentCount: 0,
          },
          terminalFence: null,
          providerAt: null,
          acceptedAt: '2026-07-19T08:00:00.000Z',
          lastLiveReceiptAt: null,
          lastTransitionId: null,
        },
      },
      { onFrame: () => () => {} } as never,
      agentStateProviderFor('codex'),
      { seedOnFrame: false },
    )
    expect(input?.observationLease).toEqual({
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 2,
      observerGeneration: 7,
      acceptedCheckpoint: null,
    })

    const observation = (overrides: Partial<AgentObservation> = {}): AgentObservation => ({
      podiumSessionId: 'podium-1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      bindingVersion: 2,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: 7,
      providerCursor: { segmentId: 'rollout-1', components: { file: 1 } },
      providerAt: null,
      receivedAt: '2026-07-19T08:00:00.000Z',
      sourceEventKind: 'rollout_fold',
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
      inputOrigin: 'provider',
      turnEpoch: 0,
      priorPhase: 'unknown',
      nextPhase: 'idle',
      transitionId: 'snapshot-1',
      state: {
        phase: 'idle',
        since: '2026-07-19T08:00:00.000Z',
        nativeSubagentCount: 0,
      },
      ...overrides,
    })
    host?.onObservation(observation())
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)

    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      bindingVersion: 1,
      transitionId: 'snapshot-1',
      result: 'rejected',
      rejectionReason: 'provider_binding_mismatch',
    })
    expect(observationAck).not.toHaveBeenCalled()
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      transitionId: 'snapshot-1',
      result: 'rejected',
      rejectionReason: 'provider_binding_mismatch',
    })
    expect(observationAck).not.toHaveBeenCalled()
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: 'snapshot-1',
      result: 'rejected',
      rejectionReason: 'cursor_not_after_checkpoint',
    })
    expect(observationAck).toHaveBeenCalledTimes(1)

    observers.onHookPayload('podium-1', {
      session_id: 'thread-2',
      transcript_path: '/repo/thread-2.jsonl',
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit',
    })
    expect(
      sent.some(
        (message) => message.type === 'sessionResumeRef' && message.resume.value === 'thread-2',
      ),
    ).toBe(false)
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebind',
      providerSessionId: 'thread-1',
      nextProviderSessionId: 'thread-2',
      observerGeneration: 7,
      bindingVersion: 2,
    })
    host?.onObservation(
      observation({
        providerSessionId: 'thread-2',
        observerGeneration: 8,
        bindingVersion: 3,
        transitionId: 'new-provider-bootstrap',
      }),
    )
    host?.onExactProviderRebind({
      nextProviderSessionId: 'thread-3',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-2',
    })
    expect(sent.filter((message) => message.type === 'agentObservationRebind')).toHaveLength(1)
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-1',
      priorObserverGeneration: 7,
      priorBindingVersion: 2,
      nextProviderSessionId: 'thread-2',
      providerSessionId: 'thread-2',
      result: 'accepted',
      observerGeneration: 9,
      bindingVersion: 3,
      checkpoint: null,
    })
    expect(rebindAck).not.toHaveBeenCalled()
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-1',
      priorObserverGeneration: 7,
      priorBindingVersion: 2,
      nextProviderSessionId: 'thread-2',
      providerSessionId: 'thread-2',
      result: 'accepted',
      observerGeneration: 8,
      bindingVersion: 3,
      checkpoint: null,
    })
    expect(rebindAck).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebind',
      providerSessionId: 'thread-2',
      nextProviderSessionId: 'thread-3',
      observerGeneration: 8,
      bindingVersion: 3,
    })
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-2',
      priorObserverGeneration: 8,
      priorBindingVersion: 3,
      nextProviderSessionId: 'thread-3',
      providerSessionId: 'thread-3',
      result: 'accepted',
      observerGeneration: 9,
      bindingVersion: 4,
      checkpoint: null,
    })
    expect(rebindAck).toHaveBeenCalledTimes(2)
    host?.onObservation(observation({ transitionId: 'old-provider-late' }))
    expect(
      sent
        .filter((message) => message.type === 'agentObservation')
        .map((message) => message.observation.transitionId),
    ).toEqual(['snapshot-1', 'new-provider-bootstrap'])
    host?.onExactProviderRebind({
      nextProviderSessionId: 'thread-4',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-rejected',
    })
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-rejected',
      priorObserverGeneration: 9,
      priorBindingVersion: 4,
      nextProviderSessionId: 'thread-4',
      providerSessionId: 'thread-current',
      result: 'rejected',
      rejectionReason: 'stale_observer_generation',
      observerGeneration: 10,
      bindingVersion: 5,
      checkpoint: null,
    })
    expect(rebindAck).toHaveBeenCalledTimes(3)
    host?.onObservation(
      observation({
        providerSessionId: 'thread-current',
        observerGeneration: 10,
        bindingVersion: 5,
        transitionId: 'authoritative-after-rejection',
      }),
    )
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservation',
      observation: { transitionId: 'authoritative-after-rejection' },
    })
    host?.onExactProviderRebind({
      nextProviderSessionId: 'thread-current',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-same',
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebind',
      providerSessionId: 'thread-current',
      nextProviderSessionId: 'thread-current',
      observerGeneration: 10,
      bindingVersion: 5,
    })
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-same',
      priorObserverGeneration: 10,
      priorBindingVersion: 5,
      nextProviderSessionId: 'thread-current',
      providerSessionId: 'thread-current',
      result: 'accepted',
      observerGeneration: 10,
      bindingVersion: 5,
      checkpoint: null,
    })
    expect(rebindAck).toHaveBeenCalledTimes(4)
    host?.onObservation(
      observation({
        providerSessionId: 'thread-current',
        observerGeneration: 10,
        bindingVersion: 5,
        transitionId: 'same-id-pending-released',
      }),
    )
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservation',
      observation: { transitionId: 'same-id-pending-released' },
    })
    host?.onExactProviderRebind({
      nextProviderSessionId: 'thread-6',
      resumeKind: 'codex-thread',
      rebindId: 'rebind-lost',
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'podium-1',
        durableLabel: 'podium-podium-1',
        agentKind: 'codex',
        cwd: '/repo',
        geometry: G,
        resume: { kind: 'codex-thread', value: 'thread-5' },
        observationGeneration: 12,
        observationBindingVersion: 7,
        observationProviderSessionId: 'thread-5',
      },
      { onFrame: () => () => {} } as never,
      undefined,
      { seedOnFrame: false },
    )
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-1',
      provider: 'codex',
      rebindId: 'rebind-lost',
      priorObserverGeneration: 10,
      priorBindingVersion: 5,
      nextProviderSessionId: 'thread-6',
      providerSessionId: 'thread-6',
      result: 'accepted',
      observerGeneration: 11,
      bindingVersion: 6,
      checkpoint: null,
    })
    expect(rebindAck).toHaveBeenCalledTimes(4)
    host?.onObservation(
      observation({
        providerSessionId: 'thread-5',
        observerGeneration: 12,
        bindingVersion: 7,
        transitionId: 'authoritative-reattach-bootstrap',
      }),
    )
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservation',
      observation: { transitionId: 'authoritative-reattach-bootstrap' },
    })
  })

  it('resends an exact lost observation and cancels it on authoritative reconnect', async () => {
    vi.useFakeTimers()
    const sent: DaemonMessage[] = []
    let host: HarnessObserverHost | undefined
    const codex = harnessAdapterFor('codex')
    if (!codex) throw new Error('Codex adapter missing')
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: (kind) =>
        kind === 'codex'
          ? {
              ...codex,
              observer: (_input, nextHost) => {
                host = nextHost
                return { stop: vi.fn() }
              },
            }
          : harnessAdapterFor(kind),
    })
    const init = (generation: number, bindingVersion: number, providerSessionId: string) =>
      observers.initSessionObservers(
        {
          type: 'reattach',
          sessionId: 'retry-observation',
          durableLabel: 'podium-retry-observation',
          agentKind: 'codex',
          cwd: '/repo',
          geometry: G,
          resume: { kind: 'codex-thread', value: providerSessionId },
          observationGeneration: generation,
          observationBindingVersion: bindingVersion,
          observationProviderSessionId: providerSessionId,
        },
        { onFrame: () => () => {} } as never,
        undefined,
        { seedOnFrame: false },
      )
    const observation = (
      generation: number,
      bindingVersion: number,
      providerSessionId: string,
      transitionId: string,
    ): AgentObservation => ({
      podiumSessionId: 'retry-observation',
      provider: 'codex',
      providerSessionId,
      bindingVersion,
      providerTurnId: null,
      providerPromptId: null,
      observerGeneration: generation,
      providerCursor: { segmentId: providerSessionId, components: { file: 1 } },
      providerAt: null,
      receivedAt: '2026-07-19T08:00:00.000Z',
      sourceEventKind: 'test',
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
      inputOrigin: 'provider',
      turnEpoch: 0,
      priorPhase: 'unknown',
      nextPhase: 'idle',
      transitionId,
      state: { phase: 'idle', since: '2026-07-19T08:00:00.000Z', nativeSubagentCount: 0 },
    })
    try {
      init(7, 2, 'thread-1')
      host?.onObservation(observation(7, 2, 'thread-1', 'lost-bootstrap'))
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(CAUSAL_DELIVERY_RETRY_BASE_MS)
      const retries = sent.filter((message) => message.type === 'agentObservation')
      expect(retries).toHaveLength(2)
      expect(retries[1]).toEqual(retries[0])

      init(8, 3, 'thread-2')
      await vi.advanceTimersByTimeAsync(CAUSAL_DELIVERY_RETRY_BASE_MS * 8)
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)

      host?.onObservation(observation(8, 3, 'thread-2', 'reconnected-bootstrap'))
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(3)
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'retry-observation',
        observerGeneration: 8,
        bindingVersion: 3,
        transitionId: 'reconnected-bootstrap',
        result: 'snapshot_applied',
        acceptedCursor: { segmentId: 'thread-2', components: { file: 1 } },
      })
      await vi.advanceTimersByTimeAsync(CAUSAL_DELIVERY_RETRY_BASE_MS * 8)
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(3)
    } finally {
      observers.clearSession('retry-observation')
      vi.useRealTimers()
    }
  })

  it('retries the exact rebind command until its authoritative ack', async () => {
    vi.useFakeTimers()
    const sent: DaemonMessage[] = []
    let host: HarnessObserverHost | undefined
    const codex = harnessAdapterFor('codex')
    if (!codex) throw new Error('Codex adapter missing')
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: (kind) =>
        kind === 'codex'
          ? {
              ...codex,
              observer: (_input, nextHost) => {
                host = nextHost
                return { stop: vi.fn() }
              },
            }
          : harnessAdapterFor(kind),
    })
    try {
      observers.initSessionObservers(
        {
          type: 'reattach',
          sessionId: 'retry-rebind',
          durableLabel: 'podium-retry-rebind',
          agentKind: 'codex',
          cwd: '/repo',
          geometry: G,
          resume: { kind: 'codex-thread', value: 'thread-1' },
          observationGeneration: 7,
          observationBindingVersion: 2,
          observationProviderSessionId: 'thread-1',
        },
        { onFrame: () => () => {} } as never,
        undefined,
        { seedOnFrame: false },
      )
      host?.onExactProviderRebind({
        nextProviderSessionId: 'thread-2',
        resumeKind: 'codex-thread',
        rebindId: 'exact-rebind',
      })
      await vi.advanceTimersByTimeAsync(CAUSAL_DELIVERY_RETRY_BASE_MS)
      const retries = sent.filter((message) => message.type === 'agentObservationRebind')
      expect(retries).toHaveLength(2)
      expect(retries[1]).toEqual(retries[0])

      observers.onProviderRebindAck({
        type: 'agentObservationRebindAck',
        sessionId: 'retry-rebind',
        provider: 'codex',
        rebindId: 'exact-rebind',
        priorObserverGeneration: 7,
        priorBindingVersion: 2,
        nextProviderSessionId: 'thread-2',
        providerSessionId: 'thread-2',
        result: 'accepted',
        observerGeneration: 8,
        bindingVersion: 3,
        checkpoint: null,
      })
      await vi.advanceTimersByTimeAsync(CAUSAL_DELIVERY_RETRY_BASE_MS * 8)
      expect(sent.filter((message) => message.type === 'agentObservationRebind')).toHaveLength(2)
    } finally {
      observers.clearSession('retry-rebind')
      vi.useRealTimers()
    }
  })

  it('ignores late old hooks before transcript or binding mutation', () => {
    const sent: DaemonMessage[] = []
    const statTick = new ManualStatTick()
    const bindHookThread = vi.fn()
    const translate = vi.fn(async () => [])
    const codex = harnessAdapterFor('codex')
    if (!codex) throw new Error('Codex adapter missing')
    const observers = createSessionObservers({
      statTick,
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: (kind) =>
        kind === 'codex'
          ? {
              ...codex,
              observer: (_input, host) => ({
                stop: vi.fn(),
                bindHookThread: (nativeId) => {
                  bindHookThread(nativeId)
                  host.onExactProviderRebind({
                    nextProviderSessionId: nativeId,
                    resumeKind: 'codex-thread',
                    rebindId: `rebind-${nativeId}`,
                  })
                },
              }),
            }
          : harnessAdapterFor(kind),
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'podium-late',
        durableLabel: 'podium-podium-late',
        agentKind: 'codex',
        cwd: '/repo',
        geometry: G,
        resume: { kind: 'codex-thread', value: 'thread-b' },
        observationGeneration: 7,
        observationBindingVersion: 2,
        observationProviderSessionId: 'thread-b',
      },
      { onFrame: () => () => {} } as never,
      { instrumentation: () => ({ args: [] }), translate },
      { seedOnFrame: false },
    )
    const baselineWatchers = statTick.watchers.size
    for (const hook_event_name of ['Stop', 'SessionEnd', 'PostToolUse']) {
      observers.onHookPayload('podium-late', {
        session_id: 'thread-a',
        transcript_path: `/repo/${hook_event_name}.jsonl`,
        cwd: '/stale',
        hook_event_name,
      })
    }
    expect(sent).toEqual([])
    expect(bindHookThread).not.toHaveBeenCalled()
    expect(translate).not.toHaveBeenCalled()
    expect(statTick.watchers.size).toBe(baselineWatchers)
    expect(observers.trackedState('podium-late')?.phase).toBe('unknown')

    observers.onHookPayload('podium-late', {
      session_id: 'thread-c',
      transcript_path: '/repo/thread-c.jsonl',
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit',
    })
    expect(bindHookThread).toHaveBeenCalledOnce()
    expect(sent.filter((message) => message.type === 'agentObservationRebind')).toHaveLength(1)
    expect(sent.some((message) => message.type === 'sessionResumeRef')).toBe(false)
    expect(sent.some((message) => message.type === 'agentObservation')).toBe(false)
    expect(translate).not.toHaveBeenCalled()
    expect(statTick.watchers.size).toBe(baselineWatchers)

    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-late',
      provider: 'codex',
      rebindId: 'rebind-thread-c',
      priorObserverGeneration: 7,
      priorBindingVersion: 2,
      nextProviderSessionId: 'thread-c',
      providerSessionId: 'thread-c',
      result: 'accepted',
      observerGeneration: 8,
      bindingVersion: 3,
      checkpoint: null,
    })
    expect(statTick.watchers.size).toBe(baselineWatchers + 1)
    observers.clearSession('podium-late')
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
    expect(agentStateMsgs(sent, sessionId).at(-1)?.state.idle).toEqual({
      kind: 'done',
    })

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
  it('reconciles a prompt flushed after its live hook across daemon restart', async () => {
    const at = '2026-07-19T00:00:00.000Z'
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-late-flush-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const promptText = 'start from the unflushed hook'
    const hook = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      prompt: promptText,
    }
    const lease7 = {
      provider: 'claude-code' as const,
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      observationGeneration: 7,
    }
    const firstSent: DaemonMessage[] = []
    const first = createSessionObservers({
      send: (message) => firstSent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    try {
      first.initSessionObservers(
        {
          type: 'spawn',
          sessionId: 'podium-late-flush',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          durableLabel: 'podium-podium-late-flush',
          observationGeneration: 7,
          observationBindingVersion: 2,
        },
        { onFrame: () => () => {} } as never,
        claudeProvider(),
        { seedOnFrame: false },
      )
      first.onHookPayload('podium-late-flush', hook)
      await vi.waitFor(() => {
        expect(firstSent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
      })
      const bootstrap = firstSent.find(
        (message) => message.type === 'agentObservation',
      )!.observation
      const bootResult = acceptAgentObservation(null, lease7, bootstrap, at)
      if (bootResult.kind === 'rejected') throw new Error(bootResult.rejectionReason)
      first.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-late-flush',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: bootstrap.transitionId,
        result: bootResult.kind,
        acceptedCursor: bootResult.checkpoint.providerCursor,
        checkpoint: bootResult.checkpoint,
      })
      await vi.waitFor(() => {
        expect(firstSent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
      })
      const opened = firstSent
        .filter((message) => message.type === 'agentObservation')
        .at(-1)!.observation
      const openedResult = acceptAgentObservation(bootResult.checkpoint, lease7, opened, at)
      if (openedResult.kind === 'rejected') throw new Error(openedResult.rejectionReason)
      expect(opened).toMatchObject({
        turnEpoch: 1,
        transitionKind: 'turn_opened',
        providerCursor: { components: { transcript: 0, hook: 1 } },
      })
      first.clearSession('podium-late-flush')

      const record = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: promptText },
      })
      await writeFile(transcript, record + '\n')
      const restartedSent: DaemonMessage[] = []
      const restarted = createSessionObservers({
        send: (message) => restartedSent.push(message),
        onTranscriptDirty: vi.fn(),
        cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      })
      restarted.initSessionObservers(
        {
          type: 'reattach',
          sessionId: 'podium-late-flush',
          durableLabel: 'podium-podium-late-flush',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          resume: { kind: 'claude-session', value: 'claude-1' },
          pathHint: transcript,
          observationGeneration: 8,
          observationBindingVersion: 2,
          observationCheckpoint: openedResult.checkpoint,
        },
        { onFrame: () => () => {} } as never,
        claudeProvider(),
        { seedOnFrame: false },
      )
      restarted.onHookPayload('podium-late-flush', {
        ...hook,
        hook_event_name: 'SessionStart',
      })
      await vi.waitFor(() => {
        expect(restartedSent.filter((message) => message.type === 'agentObservation')).toHaveLength(
          1,
        )
      })
      const restartBootstrap = restartedSent.find(
        (message) => message.type === 'agentObservation',
      )!.observation
      expect(restartBootstrap).toMatchObject({
        provenance: 'bootstrap',
        transitionKind: 'snapshot',
        turnEpoch: 1,
        providerPromptId: opened.providerPromptId,
        nextPhase: 'working',
        providerCursor: { components: { transcript: Buffer.byteLength(record + '\n'), hook: 1 } },
      })
      expect(
        acceptAgentObservation(
          openedResult.checkpoint,
          { ...lease7, observationGeneration: 8 },
          restartBootstrap,
          at,
        ).kind,
      ).toBe('snapshot_applied')
      restarted.clearSession('podium-late-flush')
    } finally {
      first.clearSession('podium-late-flush')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps composer idle false through an unflushed causal turn and true only after terminal debounce', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-composer-causal-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const sent: DaemonMessage[] = []
    const idleStates: boolean[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      onIdleState: (_sessionId, idle) => idleStates.push(idle),
    })
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      promptSource: 'system',
      prompt: '<system-reminder>You have new Podium mail.</system-reminder>',
    }
    try {
      observers.initSessionObservers(
        {
          type: 'spawn',
          sessionId: 'podium-composer',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          durableLabel: 'podium-podium-composer',
          observationGeneration: 7,
          observationBindingVersion: 2,
        },
        { onFrame: () => () => {} } as never,
        claudeProvider(),
        { seedOnFrame: false },
      )
      observers.onHookPayload('podium-composer', prompt)
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
      })
      const bootstrap = sent.find((message) => message.type === 'agentObservation')!.observation
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-composer',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: bootstrap.transitionId,
        result: 'snapshot_applied',
        acceptedCursor: bootstrap.providerCursor,
      })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
      })
      expect(idleStates).toEqual([false])
      expect(sent.some((message) => message.type === 'agentState')).toBe(false)

      const opened = sent
        .filter((message) => message.type === 'agentObservation')
        .at(-1)!.observation
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-composer',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: opened.transitionId,
        result: 'live_transition_accepted',
        acceptedCursor: opened.providerCursor,
      })
      observers.onHookPayload('podium-composer', { ...prompt, hook_event_name: 'Stop' })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(3)
      })
      expect(idleStates).toEqual([false])
      await new Promise((resolve) => setTimeout(resolve, IDLE_TRANSITION_DEBOUNCE_MS + 25))
      expect(idleStates).toEqual([false, true])
      expect(sent.some((message) => message.type === 'agentState')).toBe(false)
    } finally {
      observers.clearSession('podium-composer')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cannot install a dead generation when reset while bootstrap capture is awaiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-reset-capture-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    let releaseCapture!: () => void
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    let resolveFirstCapture!: () => void
    const firstCaptureReturned = new Promise<void>((resolve) => {
      resolveFirstCapture = resolve
    })
    let captures = 0
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      captureClaudeTranscript: async (path, options) => {
        captures += 1
        const captureNumber = captures
        if (captureNumber === 1) await captureGate
        const result = await captureClaudeTranscript(path, options)
        if (captureNumber === 1) resolveFirstCapture()
        return result
      },
    })
    const init = (observerGeneration: number) =>
      observers.initSessionObservers(
        {
          type: 'spawn',
          sessionId: 'podium-reset-capture',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          durableLabel: 'podium-podium-reset-capture',
          observationGeneration: observerGeneration,
          observationBindingVersion: 2,
        },
        { onFrame: () => () => {} } as never,
        agentStateProviderFor('claude-code'),
        { seedOnFrame: false },
      )
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'prompt-1',
    }
    try {
      init(7)
      observers.onHookPayload('podium-reset-capture', prompt)
      await vi.waitFor(() => expect(captures).toBe(1))

      init(8)
      releaseCapture()
      await firstCaptureReturned
      await Promise.resolve()
      await Promise.resolve()
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(0)

      observers.onHookPayload('podium-reset-capture', prompt)
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
      })
      expect(sent.find((message) => message.type === 'agentObservation')).toMatchObject({
        observation: { observerGeneration: 8 },
      })
      expect(captures).toBe(2)
    } finally {
      observers.clearSession('podium-reset-capture')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('buffers live hooks behind one bootstrap ack and preserves the submitted steward origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-causal-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const sent: DaemonMessage[] = []
    const statTick = new ManualStatTick()
    const observers = createSessionObservers({
      statTick,
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
      providerCursor: { components: { transcript: 0, hook: 1 } },
      inputOrigin: 'steward',
      observerGeneration: 7,
      providerSessionId: 'claude-1',
      priorPhase: 'idle',
      nextPhase: 'working',
    })
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: working.observation.transitionId,
      result: 'live_transition_accepted',
      acceptedCursor: working.observation.providerCursor,
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
    const terminal = sent.filter((m) => m.type === 'agentObservation').at(-1)!
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: terminal.observation.transitionId,
      result: 'live_transition_accepted',
      acceptedCursor: terminal.observation.providerCursor,
    })
    // A delayed predecessor ack cannot roll the accepted confirmation cursor backward.
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: working.observation.transitionId,
      result: 'live_transition_accepted',
      acceptedCursor: working.observation.providerCursor,
    })
    for (const watcher of statTick.watchers) watcher()
    await vi.waitFor(() =>
      expect(sent.filter((m) => m.type === 'agentObserverLiveConfirmation')).toHaveLength(1),
    )
    expect(sent.filter((m) => m.type === 'agentObserverLiveConfirmation').at(-1)).toMatchObject({
      providerCursor: terminal.observation.providerCursor,
    })

    // Complete late output is benign and can reconfirm the accepted terminal cursor.
    await appendFile(
      transcript,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'late' } })}\n`,
    )
    for (const watcher of statTick.watchers) watcher()
    await vi.waitFor(() =>
      expect(sent.filter((m) => m.type === 'agentObserverLiveConfirmation')).toHaveLength(2),
    )

    // A torn suffix and then a completed prompt-bearing suffix both emit zero proof.
    const confirmations = sent.filter((m) => m.type === 'agentObserverLiveConfirmation').length
    await appendFile(transcript, '{"type":"user"')
    for (const watcher of statTick.watchers) watcher()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.filter((m) => m.type === 'agentObserverLiveConfirmation')).toHaveLength(
      confirmations,
    )
    await appendFile(transcript, ',"message":{"role":"user","content":"next"}}\n')
    for (const watcher of statTick.watchers) watcher()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.filter((m) => m.type === 'agentObserverLiveConfirmation')).toHaveLength(
      confirmations,
    )

    observers.onHookPayload('podium-1', stop)
    await Promise.resolve()
    expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(3)
    observers.clearSession('podium-1')
  })
  it('learns an ack-lost fresh Claude binding and rolls exactly once through rebind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-roll-'))
    const firstTranscript = join(dir, 'claude-1.jsonl')
    const nextTranscript = join(dir, 'claude-2.jsonl')
    await writeFile(firstTranscript, '')
    await writeFile(nextTranscript, '')
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    observers.initSessionObservers(
      {
        type: 'spawn',
        sessionId: 'podium-roll',
        agentKind: 'claude-code',
        cwd: dir,
        geometry: G,
        durableLabel: 'podium-podium-roll',
        observationGeneration: 7,
        observationBindingVersion: 2,
        observationProviderSessionId: null,
      },
      { onFrame: () => () => {} } as never,
      agentStateProviderFor('claude-code'),
      { seedOnFrame: false },
    )
    const firstPrompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: firstTranscript,
      cwd: dir,
      prompt_id: 'prompt-1',
    }
    observers.onHookPayload('podium-roll', firstPrompt)
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
    })
    const firstSnapshot = sent.find((message) => message.type === 'agentObservation')!
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-roll',
      observerGeneration: 7,
      bindingVersion: 2,
      transitionId: firstSnapshot.observation.transitionId,
      result: 'rejected',
      rejectionReason: 'duplicate_transition',
      acceptedCursor: firstSnapshot.observation.providerCursor,
    })
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
    })

    const nextPrompt = {
      ...firstPrompt,
      session_id: 'claude-2',
      transcript_path: nextTranscript,
      prompt_id: 'prompt-2',
    }
    observers.onHookPayload('podium-roll', nextPrompt)
    await vi.waitFor(() => {
      expect(sent.some((message) => message.type === 'agentObservationRebind')).toBe(true)
    })
    const rebind = sent.findLast(
      (message): message is Extract<DaemonMessage, { type: 'agentObservationRebind' }> =>
        message.type === 'agentObservationRebind',
    )!
    expect(rebind).toMatchObject({
      providerSessionId: 'claude-1',
      nextProviderSessionId: 'claude-2',
      observerGeneration: 7,
      bindingVersion: 2,
    })
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
    expect(
      sent.some(
        (message) => message.type === 'sessionResumeRef' && message.resume.value === 'claude-2',
      ),
    ).toBe(false)
    observers.onProviderRebindAck({
      type: 'agentObservationRebindAck',
      sessionId: 'podium-roll',
      provider: 'claude-code',
      rebindId: rebind.rebindId,
      priorObserverGeneration: 7,
      priorBindingVersion: 2,
      nextProviderSessionId: 'claude-2',
      providerSessionId: 'claude-2',
      result: 'accepted',
      observerGeneration: 8,
      bindingVersion: 3,
      checkpoint: null,
    })
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(3)
    })
    const nextSnapshot = sent.filter((message) => message.type === 'agentObservation').at(-1)!
    expect(nextSnapshot.observation).toMatchObject({
      providerSessionId: 'claude-2',
      observerGeneration: 8,
      bindingVersion: 3,
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
    })
    expect(sent.some((message) => message.type === 'agentState')).toBe(false)
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-roll',
      observerGeneration: 8,
      bindingVersion: 3,
      transitionId: nextSnapshot.observation.transitionId,
      result: 'snapshot_applied',
      acceptedCursor: nextSnapshot.observation.providerCursor,
    })
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(4)
    })
    expect(
      sent.filter((message) => message.type === 'agentObservation').at(-1)?.observation,
    ).toMatchObject({
      providerSessionId: 'claude-2',
      observerGeneration: 8,
      bindingVersion: 3,
      transitionKind: 'turn_opened',
      priorPhase: 'idle',
      nextPhase: 'working',
    })
    const beforeLate = {
      observations: sent.filter((message) => message.type === 'agentObservation').length,
      rebinds: sent.filter((message) => message.type === 'agentObservationRebind').length,
      resumeRefs: sent.filter((message) => message.type === 'sessionResumeRef').length,
    }
    for (const hook_event_name of ['Stop', 'SessionEnd', 'PostToolUse']) {
      observers.onHookPayload('podium-roll', {
        ...firstPrompt,
        hook_event_name,
      })
    }
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(
      beforeLate.observations,
    )
    expect(sent.filter((message) => message.type === 'agentObservationRebind')).toHaveLength(
      beforeLate.rebinds,
    )
    expect(sent.filter((message) => message.type === 'sessionResumeRef')).toHaveLength(
      beforeLate.resumeRefs,
    )

    observers.onHookPayload('podium-roll', {
      ...nextPrompt,
      session_id: 'claude-3',
      transcript_path: join(dir, 'claude-3.jsonl'),
      prompt_id: 'prompt-3',
    })
    expect(sent.filter((message) => message.type === 'agentObservationRebind')).toHaveLength(
      beforeLate.rebinds + 1,
    )
    expect(sent.at(-1)).toMatchObject({
      type: 'agentObservationRebind',
      providerSessionId: 'claude-2',
      nextProviderSessionId: 'claude-3',
    })
    expect(
      sent.some(
        (message) => message.type === 'sessionResumeRef' && message.resume.value === 'claude-3',
      ),
    ).toBe(false)
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(
      beforeLate.observations,
    )
    observers.clearSession('podium-roll')
  })

  it('reboots from an authoritative live rejection without replaying buffered effects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-reject-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    const lease = {
      provider: 'claude-code' as const,
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      observationGeneration: 7,
    }
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'prompt-1',
    }
    try {
      observers.initSessionObservers(
        {
          type: 'spawn',
          sessionId: 'podium-reject',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          durableLabel: 'podium-podium-reject',
          resume: { kind: 'claude-session', value: 'claude-1' },
          observationGeneration: 7,
          observationBindingVersion: 2,
          observationProviderSessionId: 'claude-1',
        },
        { onFrame: () => () => {} } as never,
        agentStateProviderFor('claude-code'),
        { seedOnFrame: false },
      )
      observers.onHookPayload('podium-reject', prompt)
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
      })
      const bootstrapMessage = sent.find((message) => message.type === 'agentObservation')
      if (!bootstrapMessage || bootstrapMessage.type !== 'agentObservation') {
        throw new Error('missing Claude bootstrap')
      }
      const bootstrap = bootstrapMessage.observation
      const bootstrapResult = acceptAgentObservation(
        null,
        lease,
        bootstrap,
        '2026-07-19T08:00:00.000Z',
      )
      if (bootstrapResult.kind === 'rejected') throw new Error(bootstrapResult.rejectionReason)
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-reject',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: bootstrap.transitionId,
        result: bootstrapResult.kind,
        acceptedCursor: bootstrapResult.checkpoint.providerCursor,
        checkpoint: bootstrapResult.checkpoint,
      })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
      })
      const openedMessage = sent.filter((message) => message.type === 'agentObservation').at(-1)
      if (!openedMessage || openedMessage.type !== 'agentObservation') {
        throw new Error('missing Claude live open')
      }
      const opened = openedMessage.observation
      expect(opened.transitionKind).toBe('turn_opened')

      observers.onHookPayload('podium-reject', { ...prompt, hook_event_name: 'Stop' })
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-reject',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: opened.transitionId,
        result: 'rejected',
        rejectionReason: 'terminal_epoch_closed',
        acceptedCursor: bootstrapResult.checkpoint.providerCursor,
        checkpoint: bootstrapResult.checkpoint,
      })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(3)
      })
      const recoveryMessage = sent.filter((message) => message.type === 'agentObservation').at(-1)
      if (!recoveryMessage || recoveryMessage.type !== 'agentObservation') {
        throw new Error('missing Claude recovery bootstrap')
      }
      expect(recoveryMessage.observation).toMatchObject({
        provenance: 'bootstrap',
        transitionKind: 'snapshot',
        nextPhase: 'idle',
      })
      expect(
        sent
          .filter((message) => message.type === 'agentObservation')
          .slice(2)
          .some((message) => message.observation.provenance === 'live'),
      ).toBe(false)

      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-reject',
        observerGeneration: 7,
        bindingVersion: 2,
        transitionId: recoveryMessage.observation.transitionId,
        result: 'rejected',
        rejectionReason: 'duplicate_transition',
        acceptedCursor: recoveryMessage.observation.providerCursor,
        checkpoint: bootstrapResult.checkpoint,
      })
      observers.onHookPayload('podium-reject', { ...prompt, prompt_id: 'prompt-2' })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(4)
      })
      expect(sent.filter((message) => message.type === 'agentObservation').at(-1)).toMatchObject({
        observation: { provenance: 'live', transitionKind: 'turn_opened' },
      })
    } finally {
      observers.clearSession('podium-reject')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not let a stale generation ack release an identical current bootstrap transition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-generation-'))
    const transcript = join(dir, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
      prompt_id: 'prompt-1',
    }
    const start = (observerGeneration: number) => {
      observers.initSessionObservers(
        {
          type: 'spawn',
          sessionId: 'podium-1',
          agentKind: 'claude-code',
          cwd: dir,
          geometry: G,
          durableLabel: 'podium-podium-1',
          observationGeneration: observerGeneration,
          observationBindingVersion: 2,
        },
        { onFrame: () => () => {} } as never,
        agentStateProviderFor('claude-code'),
        { seedOnFrame: false },
      )
      observers.onHookPayload('podium-1', prompt)
    }

    start(7)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(1)
    })
    const stale = sent.find((m) => m.type === 'agentObservation')!.observation
    observers.clearSession('podium-1')

    start(8)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(2)
    })
    const current = sent.filter((m) => m.type === 'agentObservation').at(-1)!.observation
    expect(current.transitionId).toBe(stale.transitionId)

    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 7,
      transitionId: stale.transitionId,
      result: 'snapshot_applied',
      acceptedCursor: {
        ...stale.providerCursor,
        components: { transcript: 9999 },
      },
    })
    await Promise.resolve()
    expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(2)

    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 8,
      transitionId: current.transitionId,
      result: 'snapshot_applied',
      acceptedCursor: current.providerCursor,
    })
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(3)
    })
    expect(sent.filter((m) => m.type === 'agentObservation').at(-1)?.observation).toMatchObject({
      observerGeneration: 8,
      provenance: 'live',
      transitionKind: 'turn_opened',
    })
    observers.clearSession('podium-1')
  })
  it.each([
    { name: 'same transcript segment', rotated: false },
    { name: 'terminal reconciliation', rotated: false },
    { name: 'linked successor transcript segment', rotated: true },
  ])('reattaches terminal epoch 5 on $name and accepts exactly epoch 6', async ({
    name,
    rotated,
  }) => {
    const at = '2026-07-19T00:00:00.000Z'
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-epoch-seed-'))
    const oldTranscript = join(dir, 'claude-old.jsonl')
    const liveTranscript = rotated ? join(dir, 'claude-new.jsonl') : oldTranscript
    await writeFile(oldTranscript, `${JSON.stringify({ type: 'bridge-session' })}\n`)
    if (rotated) await writeFile(liveTranscript, '')
    const oldCapture = await captureClaudeTranscript(oldTranscript)
    const oldCursor = {
      segmentId: claudeTranscriptSegmentId('claude-1', oldCapture),
      components: { transcript: oldCapture.boundary },
    }
    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: 'podium-1',
      provider: 'claude-code',
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      lifecycleObservationGeneration: 7,
      providerCursor: oldCursor,
      bootstrapCursor: oldCursor,
      lastAcceptedLiveCursor: oldCursor,
      turnEpoch: 5,
      providerTurnId: null,
      providerPromptId: 'prompt-5',
      turnState: {
        phase: 'idle',
        idle: { kind: 'done' },
        since: at,
        workingMsTotal: 0,
        nativeSubagentCount: 0,
      },
      terminalFence: {
        turnEpoch: 5,
        providerCursor: oldCursor,
        verdict: 'done',
        transitionId: 'terminal-5',
      },
      providerAt: at,
      acceptedAt: at,
      lastLiveReceiptAt: at,
      lastTransitionId: 'terminal-5',
    }
    const lease = {
      provider: 'claude-code' as const,
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      observationGeneration: 8,
    }
    const bootEvents = vi.fn(async (): Promise<AgentStateEvent[]> => [{ kind: 'prompt_submitted' }])
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'podium-1',
        durableLabel: 'podium-podium-1',
        agentKind: 'claude-code',
        cwd: dir,
        geometry: G,
        resume: { kind: 'claude-session', value: 'claude-1' },
        pathHint: liveTranscript,
        observationGeneration: 8,
        observationBindingVersion: 2,
        observationCheckpoint: checkpoint,
      },
      { onFrame: () => () => {} } as never,
      { ...claudeProvider(), bootEvents },
      { seedOnFrame: false },
    )
    const sessionStart = {
      hook_event_name: 'SessionStart',
      session_id: 'claude-1',
      transcript_path: liveTranscript,
      cwd: dir,
    }
    observers.onHookPayload('podium-1', sessionStart)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(1)
    })
    const bootstrap = sent.find((m) => m.type === 'agentObservation')!.observation
    expect(bootEvents).not.toHaveBeenCalled()
    expect(bootstrap).toMatchObject({
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
      turnEpoch: 5,
      providerPromptId: 'prompt-5',
      providerCursor: rotated
        ? { predecessorSegmentId: oldCursor.segmentId }
        : {
            segmentId: oldCursor.segmentId,
            components: { transcript: oldCapture.boundary },
          },
    })
    const bootResult = acceptAgentObservation(checkpoint, lease, bootstrap, at)
    if (rotated) {
      expect(bootResult.kind).toBe('snapshot_applied')
      if (bootResult.kind === 'rejected') throw new Error(bootResult.rejectionReason)
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-1',
        observerGeneration: 8,
        transitionId: bootstrap.transitionId,
        result: bootResult.kind,
        acceptedCursor: bootResult.checkpoint.providerCursor,
      })
    } else {
      expect(bootResult).toEqual({
        kind: 'rejected',
        rejectionReason: 'cursor_not_after_checkpoint',
      })
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-1',
        observerGeneration: 8,
        transitionId: bootstrap.transitionId,
        result: 'rejected',
        rejectionReason:
          name === 'terminal reconciliation'
            ? 'terminal_epoch_closed'
            : 'cursor_not_after_checkpoint',
        acceptedCursor: oldCursor,
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(1)

    const acceptedBootstrap = bootResult.kind === 'rejected' ? checkpoint : bootResult.checkpoint
    await writeFile(liveTranscript, 'y'.repeat(120))
    observers.recordInputOrigin('podium-1', 'human')
    const prompt = {
      ...sessionStart,
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-6',
    }
    observers.onHookPayload('podium-1', prompt)
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(2)
    })
    const opened = sent.filter((m) => m.type === 'agentObservation').at(-1)!.observation
    expect(opened).toMatchObject({
      provenance: 'live',
      transitionKind: 'turn_opened',
      turnEpoch: 6,
      priorPhase: 'idle',
      nextPhase: 'working',
    })
    const openedResult = acceptAgentObservation(acceptedBootstrap, lease, opened, at)
    expect(openedResult.kind).toBe('live_transition_accepted')
    if (openedResult.kind === 'rejected') throw new Error(openedResult.rejectionReason)
    observers.onObservationAck({
      type: 'agentObservationAck',
      sessionId: 'podium-1',
      observerGeneration: 8,
      bindingVersion: 2,
      transitionId: opened.transitionId,
      result: openedResult.kind,
      acceptedCursor: openedResult.checkpoint.providerCursor,
      checkpoint: openedResult.checkpoint,
    })

    observers.onHookPayload('podium-1', {
      ...prompt,
      hook_event_name: 'Stop',
    })
    await vi.waitFor(() => {
      expect(sent.filter((m) => m.type === 'agentObservation')).toHaveLength(3)
    })
    const terminal = sent.filter((m) => m.type === 'agentObservation').at(-1)!.observation
    expect(terminal).toMatchObject({
      provenance: 'live',
      transitionKind: 'turn_terminal',
      turnEpoch: 6,
      priorPhase: 'working',
      nextPhase: 'idle',
    })
    const terminalResult = acceptAgentObservation(openedResult.checkpoint, lease, terminal, at)
    expect(terminalResult.kind).toBe('live_transition_accepted')
    if (terminalResult.kind === 'rejected') throw new Error(terminalResult.rejectionReason)
    expect(terminalResult.checkpoint.terminalFence?.turnEpoch).toBe(6)
    observers.clearSession('podium-1')
  })

  it.each([
    { scenario: 'frozen', rotated: false },
    { scenario: 'lost_stop', rotated: false },
    { scenario: 'prompt', rotated: false },
    { scenario: 'metadata', rotated: false },
    { scenario: 'prompt', rotated: true },
    { scenario: 'system_prompt', rotated: false },
    { scenario: 'two_turns', rotated: false },
  ] as const)('reconciles realistic transcript scenario=$scenario rotated=$rotated without a false live edge', async ({
    scenario,
    rotated,
  }) => {
    const at = '2026-07-19T00:00:00.000Z'
    const dir = await mkdtemp(join(tmpdir(), 'podium-claude-gap-reconcile-'))
    const oldTranscript = join(dir, rotated ? 'old' : '', 'claude-1.jsonl')
    const transcript = join(dir, rotated ? 'new' : '', 'claude-1.jsonl')
    if (rotated) {
      await mkdir(join(dir, 'old'))
      await mkdir(join(dir, 'new'))
    }
    const userRecord = (content: string, system = false) =>
      `${JSON.stringify({
        type: 'user',
        ...(system ? { promptSource: 'system' } : {}),
        message: { role: 'user', content },
      })}\n`
    const assistantRecord = (content: string) =>
      `${JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: content }],
        },
      })}\n`
    const terminalBase = `${userRecord('finish the task')}${assistantRecord(
      'Committed. All 42 tests pass.',
    )}`
    const workingBase = userRecord('finish the task')
    const acceptedText = scenario === 'lost_stop' ? workingBase : terminalBase
    const appendedText =
      scenario === 'frozen'
        ? ''
        : scenario === 'lost_stop'
          ? assistantRecord('Committed. All 42 tests pass.')
          : scenario === 'prompt'
            ? userRecord('start the next task')
            : scenario === 'two_turns'
              ? `${userRecord('first downtime turn')}${assistantRecord(
                  'First downtime turn done.',
                )}${userRecord('second downtime turn')}${assistantRecord(
                  'Second downtime turn done.',
                )}`
              : scenario === 'system_prompt'
                ? userRecord('scheduled controller continuation', true)
                : `${JSON.stringify({
                    type: 'bridge-session',
                    sessionId: 'claude-1',
                    bridgeSessionId: 'cse_late',
                  })}\n${JSON.stringify({
                    type: 'user',
                    isMeta: true,
                    message: {
                      role: 'user',
                      content: 'Continue from where you left off.',
                    },
                  })}\n${JSON.stringify({
                    type: 'user',
                    message: {
                      role: 'user',
                      content: [
                        {
                          type: 'tool_result',
                          tool_use_id: 'late-1',
                          content: 'done',
                        },
                      ],
                    },
                  })}\n${assistantRecord('Late bookkeeping output only.')}`
    await writeFile(oldTranscript, rotated ? acceptedText : `${acceptedText}${appendedText}`)
    if (rotated) await writeFile(transcript, appendedText)
    const acceptedOffset = Buffer.byteLength(acceptedText)
    const liveOffset = Buffer.byteLength(rotated ? appendedText : `${acceptedText}${appendedText}`)
    const oldCapture = await captureClaudeTranscript(oldTranscript)
    const acceptedCursor = {
      segmentId: claudeTranscriptSegmentId('claude-1', oldCapture),
      components: { transcript: acceptedOffset, hook: 9 },
    }
    const checkpointTerminal = scenario !== 'lost_stop'
    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: 'podium-1',
      provider: 'claude-code',
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      lifecycleObservationGeneration: 7,
      providerCursor: acceptedCursor,
      bootstrapCursor: acceptedCursor,
      lastAcceptedLiveCursor: acceptedCursor,
      turnEpoch: 5,
      providerTurnId: null,
      providerPromptId: 'prompt-5',
      turnState: checkpointTerminal
        ? {
            phase: 'idle',
            idle: { kind: 'done' },
            since: at,
            workingMsTotal: 0,
            nativeSubagentCount: 0,
          }
        : {
            phase: 'working',
            since: at,
            workingMsTotal: 0,
            nativeSubagentCount: 0,
          },
      terminalFence: checkpointTerminal
        ? {
            turnEpoch: 5,
            providerCursor: acceptedCursor,
            verdict: 'done',
            transitionId: 'terminal-5',
          }
        : null,
      providerAt: at,
      acceptedAt: at,
      lastLiveReceiptAt: at,
      lastTransitionId: checkpointTerminal ? 'terminal-5' : 'working-5',
    }
    const lease = {
      provider: 'claude-code' as const,
      providerSessionId: 'claude-1',
      bindingVersion: 2,
      observationGeneration: 8,
    }
    const provider = claudeProvider()
    if (!provider.bootEvents) throw new Error('Claude bootEvents missing')
    const bootEvents = vi.fn(provider.bootEvents)
    const sent: DaemonMessage[] = []
    const observers = createSessionObservers({
      send: (message) => sent.push(message),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
    })
    observers.initSessionObservers(
      {
        type: 'reattach',
        sessionId: 'podium-1',
        durableLabel: 'podium-podium-1',
        agentKind: 'claude-code',
        cwd: dir,
        geometry: G,
        resume: { kind: 'claude-session', value: 'claude-1' },
        pathHint: transcript,
        observationGeneration: 8,
        observationBindingVersion: 2,
        observationCheckpoint: checkpoint,
      },
      { onFrame: () => () => {} } as never,
      { ...provider, bootEvents },
      { seedOnFrame: false },
    )
    const sessionStart = {
      hook_event_name: 'SessionStart',
      session_id: 'claude-1',
      transcript_path: transcript,
      cwd: dir,
    }
    observers.onHookPayload('podium-1', sessionStart)
    await vi.waitFor(() => {
      expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)
    })
    expect(bootEvents).not.toHaveBeenCalled()
    const bootstrap = sent.find((message) => message.type === 'agentObservation')!.observation
    const gapPromptCount =
      scenario === 'two_turns'
        ? 2
        : scenario === 'prompt' || scenario === 'system_prompt' || scenario === 'metadata'
          ? 1
          : 0
    const opensNewEpoch = gapPromptCount > 0
    const reconciledEpoch = 5 + gapPromptCount
    const reconciledPhase =
      scenario === 'two_turns' || scenario === 'metadata'
        ? 'idle'
        : opensNewEpoch
          ? 'working'
          : 'idle'
    expect(bootstrap).toMatchObject({
      provenance: 'bootstrap',
      transitionKind: 'snapshot',
      turnEpoch: reconciledEpoch,
      providerPromptId: opensNewEpoch ? null : 'prompt-5',
      nextPhase: reconciledPhase,
      providerCursor: { components: { transcript: liveOffset, hook: 9 } },
    })
    if (rotated) {
      expect(bootstrap.providerCursor.predecessorSegmentId).toBe(acceptedCursor.segmentId)
    }
    const bootResult = acceptAgentObservation(checkpoint, lease, bootstrap, at)
    if (scenario === 'frozen') {
      expect(bootResult).toEqual({
        kind: 'rejected',
        rejectionReason: 'cursor_not_after_checkpoint',
      })
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-1',
        observerGeneration: 8,
        transitionId: bootstrap.transitionId,
        result: 'rejected',
        rejectionReason: 'cursor_not_after_checkpoint',
        acceptedCursor,
      })
    } else {
      expect(bootResult.kind).toBe('snapshot_applied')
      if (bootResult.kind === 'rejected') throw new Error(bootResult.rejectionReason)
      expect(bootResult.checkpoint).toMatchObject({
        turnEpoch: reconciledEpoch,
        turnState: { phase: reconciledPhase },
        terminalFence:
          scenario === 'two_turns' || scenario === 'metadata'
            ? { turnEpoch: reconciledEpoch }
            : opensNewEpoch
              ? null
              : { turnEpoch: 5 },
      })
      observers.onObservationAck({
        type: 'agentObservationAck',
        sessionId: 'podium-1',
        observerGeneration: 8,
        transitionId: bootstrap.transitionId,
        result: 'snapshot_applied',
        acceptedCursor: bootResult.checkpoint.providerCursor,
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(1)

    if (opensNewEpoch && reconciledPhase === 'working') {
      if (bootResult.kind === 'rejected') throw new Error(bootResult.rejectionReason)
      observers.onHookPayload('podium-1', {
        ...sessionStart,
        hook_event_name: 'Stop',
      })
      await vi.waitFor(() => {
        expect(sent.filter((message) => message.type === 'agentObservation')).toHaveLength(2)
      })
      const terminal = sent
        .filter((message) => message.type === 'agentObservation')
        .at(-1)!.observation
      expect(terminal).toMatchObject({
        provenance: 'live',
        transitionKind: 'turn_terminal',
        turnEpoch: reconciledEpoch,
        inputOrigin: scenario === 'system_prompt' ? 'system' : 'unknown',
        priorPhase: 'working',
        nextPhase: 'idle',
      })
      expect(acceptAgentObservation(bootResult.checkpoint, lease, terminal, at).kind).toBe(
        'live_transition_accepted',
      )
    }
    observers.clearSession('podium-1')
  })
})
