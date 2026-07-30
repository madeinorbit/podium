import type {
  AgentObservation,
  ObservationProvider,
  ObservationRejectionReason,
  ProviderCursor,
  SessionObservationCheckpointV1,
  TerminalFence,
} from '@podium/protocol'
import { ACCEPTED_TRANSITION_ID_WINDOW_SIZE } from '@podium/protocol'

export interface ObservationLease {
  provider: ObservationProvider
  providerSessionId: string | null
  bindingVersion: number
  observationGeneration: number
}

export type CursorOrder = 'after' | 'same_or_before' | 'incomparable'

/**
 * Compare positions without inventing an order across provider segments or
 * channels. A successor is accepted only when it names the current segment as
 * its predecessor; within a segment every known vector component is monotonic.
 * [spec:SP-cdb2]
 */
export function compareProviderCursor(
  current: ProviderCursor | null,
  next: ProviderCursor,
): CursorOrder {
  if (!current) return 'after'
  if (current.segmentId !== next.segmentId) {
    return next.predecessorSegmentId === current.segmentId ? 'after' : 'incomparable'
  }
  // A path replacement or file-identity change cannot inherit ordering merely
  // because an adapter reused its segment label. It must mint a successor that
  // explicitly names the delivered predecessor checkpoint. Timestamps never
  // participate in succession. [spec:SP-cdb2]
  for (const key of ['pathHint', 'device', 'inode'] as const) {
    if (current[key] !== next[key]) return 'incomparable'
  }

  let advanced = false
  const keys = new Set([...Object.keys(current.components), ...Object.keys(next.components)])
  for (const key of keys) {
    const before = current.components[key] ?? 0
    const after = next.components[key] ?? 0
    if (after < before) return 'same_or_before'
    if (after > before) advanced = true
  }
  return advanced ? 'after' : 'same_or_before'
}

export type ObservationAcceptance =
  | {
      kind: 'snapshot_applied' | 'live_transition_accepted' | 'live_refresh_accepted'
      checkpoint: SessionObservationCheckpointV1
    }
  | { kind: 'rejected'; rejectionReason: ObservationRejectionReason }

function rejected(rejectionReason: ObservationRejectionReason): ObservationAcceptance {
  return { kind: 'rejected', rejectionReason }
}

function terminalFenceFor(observation: AgentObservation): TerminalFence | null {
  const { state } = observation
  let verdict: TerminalFence['verdict'] | undefined
  if (state.phase === 'idle' && state.idle) verdict = state.idle.kind
  else if (state.phase === 'errored') verdict = 'errored'
  else if (state.phase === 'ended') verdict = 'ended'
  if (!verdict) return null
  return {
    turnEpoch: observation.turnEpoch,
    providerCursor: observation.providerCursor,
    verdict,
    transitionId: observation.transitionId,
    ...(state.awaitingSubagents || state.nativeSubagentCount > 0 ? { closing: true } : {}),
  }
}

function checkpointFrom(
  observation: AgentObservation,
  generation: number,
  acceptedAt: string,
  previous: SessionObservationCheckpointV1 | null,
): SessionObservationCheckpointV1 {
  const live = observation.provenance === 'live'
  const inferredFence = terminalFenceFor(observation)
  const previousTransitionIds =
    previous?.acceptedTransitionIds ??
    (previous?.lastTransitionId ? [previous.lastTransitionId] : [])
  return {
    schemaVersion: 1,
    podiumSessionId: observation.podiumSessionId,
    provider: observation.provider,
    providerSessionId: observation.providerSessionId,
    bindingVersion: observation.bindingVersion,
    lifecycleObservationGeneration: generation,
    providerCursor: observation.providerCursor,
    bootstrapCursor: live ? (previous?.bootstrapCursor ?? null) : observation.providerCursor,
    lastAcceptedLiveCursor: live
      ? observation.providerCursor
      : (previous?.lastAcceptedLiveCursor ?? null),
    turnEpoch: observation.turnEpoch,
    providerTurnId: observation.providerTurnId,
    providerPromptId: observation.providerPromptId,
    turnState: observation.state,
    terminalFence:
      observation.transitionKind === 'turn_opened' ||
      (previous !== null && observation.turnEpoch > previous.turnEpoch && inferredFence === null)
        ? null
        : (inferredFence ?? previous?.terminalFence ?? null),
    providerAt: observation.providerAt,
    acceptedAt,
    lastLiveReceiptAt: live ? observation.receivedAt : (previous?.lastLiveReceiptAt ?? null),
    lastTransitionId: observation.transitionId,
    acceptedTransitionIds: [
      observation.transitionId,
      ...previousTransitionIds.filter((id) => id !== observation.transitionId),
    ].slice(0, ACCEPTED_TRANSITION_ID_WINDOW_SIZE),
  }
}

/**
 * The shared durable acceptance gate. It is deliberately independent of
 * provider parsing: adapters own semantic classification; this gate owns lease,
 * binding, cursor, epoch, terminal-fence, and effect eligibility.
 */
export function acceptAgentObservation(
  checkpoint: SessionObservationCheckpointV1 | null,
  lease: ObservationLease,
  observation: AgentObservation,
  acceptedAt: string,
): ObservationAcceptance {
  if (observation.observerGeneration !== lease.observationGeneration) {
    return rejected('stale_observer_generation')
  }
  if (observation.nextPhase !== observation.state.phase) {
    return rejected('noncausal_epoch_open')
  }
  if (observation.provenance === 'live' && observation.transitionKind === 'snapshot') {
    return rejected('bootstrap_has_no_live_effects')
  }
  if (
    observation.provider !== lease.provider ||
    observation.bindingVersion !== lease.bindingVersion ||
    (lease.providerSessionId !== null && observation.providerSessionId !== lease.providerSessionId)
  ) {
    return rejected('provider_binding_mismatch')
  }
  if (observation.providerAt !== null && !Number.isFinite(Date.parse(observation.providerAt))) {
    return rejected('invalid_provider_timestamp')
  }
  if (
    checkpoint?.lastTransitionId === observation.transitionId ||
    checkpoint?.acceptedTransitionIds?.includes(observation.transitionId)
  ) {
    return rejected('duplicate_transition')
  }

  const cursorOrder = compareProviderCursor(
    checkpoint?.providerCursor ?? null,
    observation.providerCursor,
  )
  if (cursorOrder === 'incomparable') return rejected('unproven_segment_rotation')
  if (cursorOrder === 'same_or_before') return rejected('cursor_not_after_checkpoint')

  if (observation.provenance === 'replay') return rejected('replay_has_no_live_effects')
  if (observation.provenance === 'bootstrap') {
    if (checkpoint && observation.turnEpoch < checkpoint.turnEpoch) {
      return rejected(checkpoint.terminalFence ? 'terminal_epoch_closed' : 'noncausal_epoch_open')
    }
    if (
      checkpoint?.terminalFence &&
      observation.turnEpoch === checkpoint.turnEpoch &&
      terminalFenceFor(observation) === null &&
      !(checkpoint.terminalFence.closing === true && observation.state.awaitingSubagents === true)
    ) {
      return rejected('terminal_epoch_closed')
    }
    return {
      kind: 'snapshot_applied',
      checkpoint: checkpointFrom(observation, lease.observationGeneration, acceptedAt, checkpoint),
    }
  }

  if (!checkpoint) {
    if (observation.transitionKind !== 'turn_opened') return rejected('noncausal_epoch_open')
  } else {
    if (observation.priorPhase !== checkpoint.turnState.phase) {
      return rejected('noncausal_epoch_open')
    }
    if (observation.turnEpoch < checkpoint.turnEpoch) {
      return rejected(checkpoint.terminalFence ? 'terminal_epoch_closed' : 'noncausal_epoch_open')
    }
    if (observation.turnEpoch > checkpoint.turnEpoch) {
      if (
        observation.turnEpoch !== checkpoint.turnEpoch + 1 ||
        observation.transitionKind !== 'turn_opened'
      ) {
        return rejected('noncausal_epoch_open')
      }
    } else {
      if (observation.transitionKind === 'turn_opened') {
        return rejected('noncausal_epoch_open')
      }
      if (checkpoint.terminalFence) {
        const canCloseChildren =
          checkpoint.terminalFence.closing === true &&
          observation.transitionKind === 'subagent_bookkeeping' &&
          observation.state.nativeSubagentCount <= checkpoint.turnState.nativeSubagentCount
        if (!canCloseChildren) return rejected('terminal_epoch_closed')
      }
    }
  }

  const next = checkpointFrom(observation, lease.observationGeneration, acceptedAt, checkpoint)
  // Once matching child bookkeeping reaches zero it settles the closing fence
  // at this transition rather than preserving the earlier provisional terminal.
  if (
    checkpoint?.terminalFence?.closing &&
    observation.transitionKind === 'subagent_bookkeeping' &&
    observation.state.nativeSubagentCount === 0
  ) {
    next.terminalFence = terminalFenceFor(observation) ?? {
      ...checkpoint.terminalFence,
      providerCursor: observation.providerCursor,
      transitionId: observation.transitionId,
      closing: false,
    }
  }

  return {
    kind:
      checkpoint?.turnState.phase === observation.state.phase
        ? 'live_refresh_accepted'
        : 'live_transition_accepted',
    checkpoint: next,
  }
}
