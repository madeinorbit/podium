import type {
  AgentObservation,
  AgentRuntimeState,
  ProviderCursor,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import {
  ACCEPTED_TRANSITION_ID_WINDOW_SIZE,
  SessionObservationCheckpointV1 as SessionObservationCheckpointSchema,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { acceptAgentObservation, compareProviderCursor, type ObservationLease } from './causal.js'

const at = '2026-07-18T12:00:00.000Z'
const lease: ObservationLease = {
  provider: 'codex',
  providerSessionId: 'thread-1',
  bindingVersion: 1,
  observationGeneration: 7,
}
const state = (
  phase: AgentRuntimeState['phase'],
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState => ({
  phase,
  since: at,
  workingMsTotal: 0,
  nativeSubagentCount: 0,
  ...extra,
})
const cursor = (
  offset: number,
  segmentId = 'segment-1',
  predecessorSegmentId?: string,
): ProviderCursor => ({
  segmentId,
  ...(predecessorSegmentId ? { predecessorSegmentId } : {}),
  components: { file: offset },
})
const observation = (overrides: Partial<AgentObservation> = {}): AgentObservation => ({
  podiumSessionId: 'podium-1',
  provider: 'codex',
  providerSessionId: 'thread-1',
  bindingVersion: 1,
  providerTurnId: null,
  providerPromptId: null,
  observerGeneration: 7,
  providerCursor: cursor(10),
  providerAt: at,
  receivedAt: at,
  sourceEventKind: 'snapshot',
  transitionKind: 'snapshot',
  provenance: 'bootstrap',
  inputOrigin: 'provider',
  turnEpoch: 0,
  priorPhase: 'unknown',
  nextPhase: 'idle',
  transitionId: 'snapshot-10',
  state: state('idle'),
  ...overrides,
})

function acceptedCheckpoint(result: ReturnType<typeof acceptAgentObservation>) {
  if (result.kind === 'rejected') throw new Error(result.rejectionReason)
  return result.checkpoint
}

describe('compareProviderCursor', () => {
  it('requires every vector component to be monotonic', () => {
    const current = { segmentId: 's', components: { file: 10, hooks: 2 } }
    expect(
      compareProviderCursor(current, { segmentId: 's', components: { file: 11, hooks: 2 } }),
    ).toBe('after')
    expect(
      compareProviderCursor(current, { segmentId: 's', components: { file: 11, hooks: 1 } }),
    ).toBe('same_or_before')
    expect(
      compareProviderCursor(current, { segmentId: 's', components: { file: 10, hooks: 2 } }),
    ).toBe('same_or_before')
  })

  it('accepts only an explicitly linked successor segment', () => {
    const current = cursor(100, 'old')
    expect(compareProviderCursor(current, cursor(1, 'new', 'old'))).toBe('after')
    expect(compareProviderCursor(current, cursor(1, 'new'))).toBe('incomparable')
  })
})

describe('acceptAgentObservation', () => {
  it('folds bootstrap into one snapshot and makes unchanged history a no-op', () => {
    const first = acceptAgentObservation(null, lease, observation(), at)
    expect(first.kind).toBe('snapshot_applied')
    const checkpoint = acceptedCheckpoint(first)
    expect(
      acceptAgentObservation(
        checkpoint,
        lease,
        observation({ transitionId: 'snapshot-again' }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'cursor_not_after_checkpoint' })
  })

  it('rejects stale generations, binding conflicts, and replay provenance', () => {
    expect(acceptAgentObservation(null, lease, observation({ observerGeneration: 6 }), at)).toEqual(
      { kind: 'rejected', rejectionReason: 'stale_observer_generation' },
    )
    expect(
      acceptAgentObservation(null, lease, observation({ providerSessionId: 'other' }), at),
    ).toEqual({ kind: 'rejected', rejectionReason: 'provider_binding_mismatch' })
    expect(acceptAgentObservation(null, lease, observation({ bindingVersion: 2 }), at)).toEqual({
      kind: 'rejected',
      rejectionReason: 'provider_binding_mismatch',
    })
    expect(
      acceptAgentObservation(
        null,
        lease,
        observation({ provenance: 'replay', providerCursor: cursor(20) }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'replay_has_no_live_effects' })
  })

  it('requires explicit predecessor succession for file identity replacement', () => {
    const current = {
      segmentId: 'segment-1',
      pathHint: '/tmp/rollout.jsonl',
      device: '1',
      inode: '10',
      components: { file: 100 },
    }
    expect(
      compareProviderCursor(current, { ...current, inode: '11', components: { file: 120 } }),
    ).toBe('incomparable')
    expect(
      compareProviderCursor(current, {
        segmentId: 'segment-2',
        predecessorSegmentId: 'segment-1',
        pathHint: '/tmp/rollout.jsonl',
        device: '1',
        inode: '11',
        components: { file: 5 },
      }),
    ).toBe('after')
    expect(
      compareProviderCursor(current, {
        segmentId: 'segment-1',
        pathHint: '/tmp/rollout.jsonl',
        device: '1',
        components: { file: 120 },
      }),
    ).toBe('incomparable')
    expect(
      compareProviderCursor(
        { segmentId: 'segment-1', components: { file: 100 } },
        { ...current, components: { file: 120 } },
      ),
    ).toBe('incomparable')
  })

  it('rejects inconsistent phase envelopes and snapshots mislabeled as live', () => {
    expect(acceptAgentObservation(null, lease, observation({ nextPhase: 'working' }), at)).toEqual({
      kind: 'rejected',
      rejectionReason: 'noncausal_epoch_open',
    })
    expect(
      acceptAgentObservation(
        null,
        lease,
        observation({
          provenance: 'live',
          transitionKind: 'snapshot',
          nextPhase: 'idle',
          providerCursor: cursor(20),
        }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'bootstrap_has_no_live_effects' })
  })

  it('accepts exactly one causal working edge and one terminal edge', () => {
    const boot = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))
    const working = observation({
      provenance: 'live',
      transitionKind: 'turn_opened',
      sourceEventKind: 'task_started',
      turnEpoch: 1,
      priorPhase: 'idle',
      nextPhase: 'working',
      transitionId: 'turn-1-open',
      providerCursor: cursor(20),
      state: state('working'),
    })
    const opened = acceptAgentObservation(boot, lease, working, at)
    expect(opened.kind).toBe('live_transition_accepted')
    const openCheckpoint = acceptedCheckpoint(opened)

    const done = observation({
      provenance: 'live',
      transitionKind: 'turn_terminal',
      sourceEventKind: 'task_complete',
      turnEpoch: 1,
      priorPhase: 'working',
      nextPhase: 'idle',
      transitionId: 'turn-1-done',
      providerCursor: cursor(30),
      state: state('idle', { idle: { kind: 'done' } }),
    })
    const settled = acceptAgentObservation(openCheckpoint, lease, done, at)
    expect(settled.kind).toBe('live_transition_accepted')
    expect(acceptedCheckpoint(settled).terminalFence?.turnEpoch).toBe(1)

    expect(
      acceptAgentObservation(
        acceptedCheckpoint(settled),
        lease,
        observation({
          provenance: 'live',
          transitionKind: 'activity',
          sourceEventKind: 'tool_output',
          turnEpoch: 1,
          priorPhase: 'idle',
          nextPhase: 'working',
          transitionId: 'late-output',
          providerCursor: cursor(40),
          state: state('working'),
        }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'terminal_epoch_closed' })
  })

  it('does not let a newer bootstrap cursor reopen the same terminal epoch', () => {
    const terminal = acceptedCheckpoint(
      acceptAgentObservation(
        null,
        lease,
        observation({
          state: state('idle', { idle: { kind: 'done' } }),
          turnEpoch: 1,
          transitionId: 'boot-done',
        }),
        at,
      ),
    )
    const lateSnapshot = observation({
      providerCursor: cursor(20),
      turnEpoch: 1,
      priorPhase: 'idle',
      nextPhase: 'working',
      transitionId: 'late-snapshot',
      state: state('working'),
    })
    expect(acceptAgentObservation(terminal, lease, lateSnapshot, at)).toEqual({
      kind: 'rejected',
      rejectionReason: 'terminal_epoch_closed',
    })

    const gapTurn = acceptAgentObservation(
      terminal,
      lease,
      {
        ...lateSnapshot,
        turnEpoch: 2,
        transitionId: 'gap-turn-snapshot',
      },
      at,
    )
    expect(gapTurn.kind).toBe('snapshot_applied')
    expect(acceptedCheckpoint(gapTurn).terminalFence).toBeNull()
  })

  it('opens a new epoch only from a provider-confirmed prompt', () => {
    const terminal: SessionObservationCheckpointV1 = acceptedCheckpoint(
      acceptAgentObservation(
        null,
        lease,
        observation({
          state: state('idle', { idle: { kind: 'done' } }),
          turnEpoch: 1,
          transitionId: 'boot-done',
        }),
        at,
      ),
    )
    const noncausal = observation({
      provenance: 'live',
      transitionKind: 'activity',
      turnEpoch: 2,
      priorPhase: 'idle',
      nextPhase: 'working',
      providerCursor: cursor(20),
      transitionId: 'activity-2',
      state: state('working'),
    })
    expect(acceptAgentObservation(terminal, lease, noncausal, at)).toEqual({
      kind: 'rejected',
      rejectionReason: 'noncausal_epoch_open',
    })

    const opened = acceptAgentObservation(
      terminal,
      lease,
      {
        ...noncausal,
        transitionKind: 'turn_opened',
        sourceEventKind: 'user_message',
        transitionId: 'prompt-2',
      },
      at,
    )
    expect(opened.kind).toBe('live_transition_accepted')
    expect(acceptedCheckpoint(opened).turnEpoch).toBe(2)
    expect(acceptedCheckpoint(opened).terminalFence).toBeNull()
  })

  it('rejects a non-last duplicate after restart without mutating the checkpoint', () => {
    const boot = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))
    const opened = acceptedCheckpoint(
      acceptAgentObservation(
        boot,
        lease,
        observation({
          provenance: 'live',
          transitionKind: 'turn_opened',
          sourceEventKind: 'task_started',
          turnEpoch: 1,
          priorPhase: 'idle',
          nextPhase: 'working',
          transitionId: 'turn-1-open',
          providerCursor: cursor(20),
          state: state('working'),
        }),
        at,
      ),
    )
    const refreshed = acceptedCheckpoint(
      acceptAgentObservation(
        opened,
        lease,
        observation({
          provenance: 'live',
          transitionKind: 'activity',
          sourceEventKind: 'tool_output',
          turnEpoch: 1,
          priorPhase: 'working',
          nextPhase: 'working',
          transitionId: 'turn-1-output',
          providerCursor: cursor(30),
          state: state('working'),
        }),
        at,
      ),
    )
    const restarted = SessionObservationCheckpointSchema.parse(
      JSON.parse(JSON.stringify(refreshed)),
    )

    expect(
      acceptAgentObservation(
        restarted,
        lease,
        observation({
          provenance: 'live',
          transitionKind: 'activity',
          sourceEventKind: 'task_started',
          turnEpoch: 1,
          priorPhase: 'working',
          nextPhase: 'working',
          transitionId: 'turn-1-open',
          providerCursor: cursor(40),
          state: state('working'),
        }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'duplicate_transition' })
    expect(restarted).toEqual(refreshed)
  })

  it('deduplicates and trims accepted transition IDs newest-first', () => {
    let checkpoint = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))
    for (let index = 1; index <= ACCEPTED_TRANSITION_ID_WINDOW_SIZE + 2; index += 1) {
      checkpoint = acceptedCheckpoint(
        acceptAgentObservation(
          checkpoint,
          lease,
          observation({
            providerCursor: cursor(10 + index),
            transitionId: `snapshot-${10 + index}`,
          }),
          at,
        ),
      )
    }

    const transitionIds = checkpoint.acceptedTransitionIds ?? []
    expect(transitionIds).toHaveLength(ACCEPTED_TRANSITION_ID_WINDOW_SIZE)
    expect(transitionIds[0]).toBe(`snapshot-${12 + ACCEPTED_TRANSITION_ID_WINDOW_SIZE}`)
    expect(transitionIds).not.toContain('snapshot-10')
    expect(transitionIds).not.toContain('snapshot-11')
    expect(new Set(transitionIds).size).toBe(ACCEPTED_TRANSITION_ID_WINDOW_SIZE)
  })

  it('upgrades legacy checkpoints while preserving lastTransitionId dedupe', () => {
    const current = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))
    const { acceptedTransitionIds: _history, ...legacy } = current

    expect(
      acceptAgentObservation(
        legacy,
        lease,
        observation({ transitionId: 'snapshot-10', providerCursor: cursor(20) }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'duplicate_transition' })

    const next = acceptAgentObservation(
      legacy,
      lease,
      observation({ transitionId: 'snapshot-20', providerCursor: cursor(20) }),
      at,
    )
    expect(next.kind).toBe('snapshot_applied')
    expect(acceptedCheckpoint(next).lastTransitionId).toBe('snapshot-20')
    expect(acceptedCheckpoint(next).acceptedTransitionIds).toEqual(['snapshot-20', 'snapshot-10'])
  })

  it('rejects duplicate bootstrap and replay before cursor or effect acceptance', () => {
    const checkpoint = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))

    for (const provenance of ['bootstrap', 'replay'] as const) {
      expect(
        acceptAgentObservation(
          checkpoint,
          lease,
          observation({
            provenance,
            transitionId: 'snapshot-10',
            providerCursor: cursor(20),
          }),
          at,
        ),
      ).toEqual({ kind: 'rejected', rejectionReason: 'duplicate_transition' })
    }
  })

  it('accepts a genuinely new transition after rejecting an older duplicate', () => {
    const checkpoint = acceptedCheckpoint(acceptAgentObservation(null, lease, observation(), at))
    expect(
      acceptAgentObservation(
        checkpoint,
        lease,
        observation({ transitionId: 'snapshot-10', providerCursor: cursor(20) }),
        at,
      ),
    ).toEqual({ kind: 'rejected', rejectionReason: 'duplicate_transition' })

    const next = acceptAgentObservation(
      checkpoint,
      lease,
      observation({ transitionId: 'snapshot-20', providerCursor: cursor(20) }),
      at,
    )
    expect(next.kind).toBe('snapshot_applied')
    expect(acceptedCheckpoint(next).acceptedTransitionIds).toEqual(['snapshot-20', 'snapshot-10'])
  })
})
