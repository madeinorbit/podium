import { createHash } from 'node:crypto'
import type {
  AgentObservation,
  AgentObservationAckMessage,
  AgentRuntimeState,
  ProviderCursor,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import { initialAgentState, reduceAgentState } from './reducer.js'
import type { AgentStateEvent } from './types.js'

export interface GrokObservationLease {
  podiumSessionId: string
  providerSessionId: string
  bindingVersion: number
  observerGeneration: number
  acceptedCheckpoint: SessionObservationCheckpointV1 | null
  onObservation(observation: AgentObservation): void
  now?: () => string
  retryMs?: number
  retryNow?: () => number
}

export interface GrokRecordEvidence {
  record: Record<string, unknown>
  cursor: ProviderCursor
  events: AgentStateEvent[]
  sourceEventKind: string
  providerAt: string | null
}

const MAX_BUFFERED_GROK_RECORDS = 64

export type GrokSegmentIdentity = {
  segmentId: string
  pathHint: string
  device: string
  inode: string
}

/**
 * Provider-local causal fold for Grok. Disk records may be read ahead, but only
 * one durable observation is released at a time; its successor waits for the
 * exact server acknowledgement. [spec:SP-cdb2]
 */
export class GrokCausalObserver {
  private readonly now: () => string
  private state: AgentRuntimeState
  private turnEpoch: number
  private providerTurnId: string | null
  private providerPromptId: string | null
  private epochOpen: boolean
  private predecessorSegmentId: string | undefined
  private acceptedCursor: ProviderCursor | null
  private readonly queued: GrokRecordEvidence[] = []
  private inFlight: AgentObservation | null = null
  private nextRetryAt = 0
  private draining = false

  constructor(private readonly lease: GrokObservationLease) {
    const checkpoint = lease.acceptedCheckpoint
    this.now = lease.now ?? (() => new Date().toISOString())
    this.state = checkpoint?.turnState ?? initialAgentState(this.now())
    this.turnEpoch = checkpoint?.turnEpoch ?? 0
    this.providerTurnId = checkpoint?.providerTurnId ?? null
    this.providerPromptId = checkpoint?.providerPromptId ?? null
    this.acceptedCursor = checkpoint?.providerCursor ?? null
    this.epochOpen =
      checkpoint?.terminalFence === null &&
      (this.state.phase === 'working' ||
        this.state.phase === 'compacting' ||
        this.state.phase === 'needs_user')
  }

  get hasPendingDelivery(): boolean {
    return this.inFlight !== null || this.queued.length > 0 || this.draining
  }

  get acceptedProviderCursor(): ProviderCursor | null {
    return this.acceptedCursor
  }

  get bufferedRecordCount(): number {
    return this.queued.length
  }

  retryPending(force = false): boolean {
    if (!this.inFlight) return false
    const now = this.lease.retryNow?.() ?? Date.now()
    if (!force && now < this.nextRetryAt) return true
    this.nextRetryAt = now + (this.lease.retryMs ?? 2_000)
    this.lease.onObservation(this.inFlight)
    return true
  }

  /**
   * Select the only history range that needs folding. An exact accepted cursor
   * restores its durable snapshot and reads merely the cursor gap; a replaced
   * file starts a successor segment and folds its complete prefix once.
   */
  beginSegment(identity: GrokSegmentIdentity, boundary: number, forceSuccessor = false): number {
    const accepted = this.acceptedCursor
    const sameFile =
      accepted?.pathHint === identity.pathHint &&
      accepted.device === identity.device &&
      accepted.inode === identity.inode
    const acceptedOffset = accepted?.components.updates
    const sameSegmentInvalid =
      accepted?.segmentId === identity.segmentId &&
      (!sameFile ||
        !Number.isSafeInteger(acceptedOffset) ||
        acceptedOffset === undefined ||
        acceptedOffset > boundary)
    if (accepted && (forceSuccessor || sameSegmentInvalid)) {
      identity.segmentId = createHash('sha256')
        .update([accepted.segmentId, 'successor', identity.pathHint, boundary].join('|'))
        .digest('hex')
    }
    const exact = accepted?.segmentId === identity.segmentId && sameFile
    if (exact && Number.isSafeInteger(acceptedOffset) && acceptedOffset !== undefined) {
      this.predecessorSegmentId = undefined
      return acceptedOffset
    }

    if (accepted) this.predecessorSegmentId = accepted.segmentId
    return 0
  }

  cursorFor(identity: GrokSegmentIdentity, offset: number): ProviderCursor {
    return grokProviderCursor(identity, offset, this.predecessorSegmentId)
  }

  fold(record: GrokRecordEvidence): void {
    this.apply(record, false)
  }

  finishBootstrap(cursor: ProviderCursor): void {
    if (sameCursor(this.acceptedCursor, cursor)) return
    const observation = this.observation({
      cursor,
      sourceEventKind: 'bootstrap',
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
      priorPhase: this.lease.acceptedCheckpoint?.turnState.phase ?? 'unknown',
      providerAt: null,
      identity: `bootstrap:${cursor.components.updates ?? 0}`,
    })
    this.deliver(observation)
  }

  enqueue(record: GrokRecordEvidence): boolean {
    if (this.queued.length >= MAX_BUFFERED_GROK_RECORDS) return false
    this.queued.push(record)
    void this.drain()
    return true
  }

  acknowledge(ack: AgentObservationAckMessage): void {
    const current = this.inFlight
    if (
      !current ||
      ack.sessionId !== this.lease.podiumSessionId ||
      ack.observerGeneration !== this.lease.observerGeneration ||
      (ack.bindingVersion !== undefined && ack.bindingVersion !== this.lease.bindingVersion) ||
      ack.transitionId !== current.transitionId
    ) {
      return
    }
    const acceptedCursor = ack.acceptedCursor ?? null
    const released =
      ack.result !== 'rejected' ||
      (ack.rejectionReason === 'duplicate_transition' &&
        acceptedCursor !== null &&
        sameCursor(acceptedCursor, current.providerCursor))
    if (!released) {
      const checkpoint = this.authoritativeCheckpoint(ack.checkpoint)
      if (checkpoint) {
        this.adoptCheckpoint(checkpoint)
        return
      }
      this.retryPending(true)
      return
    }
    this.acceptedCursor = acceptedCursor ?? current.providerCursor
    this.restoreAcceptedCheckpoint(this.acceptedCursor)
    this.inFlight = null
    this.nextRetryAt = 0
    void this.drain()
  }

  private authoritativeCheckpoint(
    checkpoint: SessionObservationCheckpointV1 | null | undefined,
  ): SessionObservationCheckpointV1 | null {
    return checkpoint &&
      checkpoint.podiumSessionId === this.lease.podiumSessionId &&
      checkpoint.provider === 'grok' &&
      checkpoint.providerSessionId === this.lease.providerSessionId &&
      checkpoint.bindingVersion === this.lease.bindingVersion &&
      checkpoint.lifecycleObservationGeneration <= this.lease.observerGeneration &&
      checkpoint.providerCursor !== null
      ? checkpoint
      : null
  }

  private adoptCheckpoint(checkpoint: SessionObservationCheckpointV1): void {
    const cursor = checkpoint.providerCursor
    if (!cursor) return
    this.state = checkpoint.turnState
    this.turnEpoch = checkpoint.turnEpoch
    this.providerTurnId = checkpoint.providerTurnId
    this.providerPromptId = checkpoint.providerPromptId
    this.acceptedCursor = cursor
    this.epochOpen =
      checkpoint.terminalFence === null &&
      (this.state.phase === 'working' ||
        this.state.phase === 'compacting' ||
        this.state.phase === 'needs_user')
    const durableOffset = cursor.components.updates
    if (Number.isSafeInteger(durableOffset) && durableOffset !== undefined) {
      const retained = this.queued.filter(
        (record) =>
          record.cursor.segmentId !== cursor.segmentId ||
          record.cursor.pathHint !== cursor.pathHint ||
          record.cursor.device !== cursor.device ||
          record.cursor.inode !== cursor.inode ||
          (record.cursor.components.updates ?? 0) > durableOffset,
      )
      this.queued.splice(0, this.queued.length, ...retained)
    }
    this.inFlight = null
    this.nextRetryAt = 0
    void this.drain()
  }

  private restoreAcceptedCheckpoint(cursor: ProviderCursor): void {
    const checkpoint = this.lease.acceptedCheckpoint
    if (!checkpoint?.providerCursor || !sameCursor(checkpoint.providerCursor, cursor)) return
    this.state = checkpoint.turnState
    this.turnEpoch = checkpoint.turnEpoch
    this.providerTurnId = checkpoint.providerTurnId
    this.providerPromptId = checkpoint.providerPromptId
    this.epochOpen =
      checkpoint.terminalFence === null &&
      (this.state.phase === 'working' ||
        this.state.phase === 'compacting' ||
        this.state.phase === 'needs_user')
  }

  private async drain(): Promise<void> {
    if (this.draining || this.inFlight) return
    this.draining = true
    try {
      while (!this.inFlight && this.queued.length > 0) {
        const record = this.queued.shift()!
        const observation = this.apply(record, true)
        if (observation) this.deliver(observation)
      }
    } finally {
      this.draining = false
    }
  }

  private apply(record: GrokRecordEvidence, live: boolean): AgentObservation | null {
    let result: AgentObservation | null = null
    for (let index = 0; index < record.events.length; index += 1) {
      const event = record.events[index]!
      const prompt = event.kind === 'prompt_submitted'
      if (prompt) {
        if (this.epochOpen) continue
        this.turnEpoch += 1
        this.epochOpen = true
        this.providerPromptId = nativeId(record.record, ['prompt_id', 'promptId'])
        this.providerTurnId = nativeId(record.record, ['turn_id', 'turnId'])
        const prior = this.state
        this.state = reduceAgentState(prior, event, this.now())
        if (live && !result) {
          result = this.observation({
            cursor: record.cursor,
            sourceEventKind: record.sourceEventKind,
            transitionKind: 'turn_opened',
            provenance: 'live',
            priorPhase: prior.phase,
            providerAt: record.providerAt,
            identity: recordIdentity(record, index),
          })
        }
        continue
      }

      if (!this.epochOpen) continue
      const terminal =
        event.kind === 'turn_completed' ||
        event.kind === 'turn_failed' ||
        event.kind === 'session_ended' ||
        event.kind === 'needs_user'
      const prior = this.state
      const next = reduceAgentState(prior, event, this.now())
      if (next === prior) continue
      this.state = next
      this.providerTurnId = nativeId(record.record, ['turn_id', 'turnId']) ?? this.providerTurnId
      if (terminal) this.epochOpen = false
      if (live && !result) {
        result = this.observation({
          cursor: record.cursor,
          sourceEventKind: record.sourceEventKind,
          transitionKind:
            event.kind === 'session_ended'
              ? 'session_terminal'
              : terminal
                ? 'turn_terminal'
                : event.kind === 'compaction'
                  ? 'compaction'
                  : event.kind === 'task_delta'
                    ? 'subagent_bookkeeping'
                    : 'activity',
          provenance: 'live',
          priorPhase: prior.phase,
          providerAt: record.providerAt,
          identity: recordIdentity(record, index),
        })
      }
    }
    return result
  }

  private deliver(observation: AgentObservation): void {
    if (this.inFlight) {
      throw new Error('Grok causal observer attempted concurrent delivery')
    }
    this.inFlight = observation
    this.retryPending(true)
  }

  private observation(input: {
    cursor: ProviderCursor
    sourceEventKind: string
    transitionKind: AgentObservation['transitionKind']
    provenance: AgentObservation['provenance']
    priorPhase: AgentRuntimeState['phase']
    providerAt: string | null
    identity: string
  }): AgentObservation {
    const transitionId = createHash('sha256')
      .update(
        [
          input.cursor.segmentId,
          input.cursor.components.updates ?? 0,
          this.turnEpoch,
          input.identity,
          input.priorPhase,
          this.state.phase,
        ].join('|'),
      )
      .digest('hex')
    return {
      podiumSessionId: this.lease.podiumSessionId,
      provider: 'grok',
      providerSessionId: this.lease.providerSessionId,
      bindingVersion: this.lease.bindingVersion,
      providerTurnId: this.providerTurnId,
      providerPromptId: this.providerPromptId,
      observerGeneration: this.lease.observerGeneration,
      providerCursor: input.cursor,
      providerAt: input.providerAt,
      receivedAt: this.now(),
      sourceEventKind: input.sourceEventKind,
      transitionKind: input.transitionKind,
      provenance: input.provenance,
      inputOrigin: 'provider',
      turnEpoch: this.turnEpoch,
      priorPhase: input.priorPhase,
      nextPhase: this.state.phase,
      transitionId,
      state: this.state,
    }
  }
}

export function grokProviderCursor(
  identity: GrokSegmentIdentity,
  offset: number,
  predecessorSegmentId?: string,
): ProviderCursor {
  return {
    segmentId: identity.segmentId,
    ...(predecessorSegmentId ? { predecessorSegmentId } : {}),
    pathHint: identity.pathHint,
    device: identity.device,
    inode: identity.inode,
    components: { updates: offset },
  }
}

function sameCursor(left: ProviderCursor | null, right: ProviderCursor): boolean {
  return (
    left?.segmentId === right.segmentId &&
    left.pathHint === right.pathHint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.components.updates === right.components.updates
  )
}

function nativeId(record: Record<string, unknown>, keys: string[]): string | null {
  const candidates = [record, objectField(objectField(record, 'params'), 'update')]
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return null
}

function objectField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key]
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function recordIdentity(record: GrokRecordEvidence, eventIndex: number): string {
  const native =
    nativeId(record.record, ['prompt_id', 'promptId', 'turn_id', 'turnId', 'task_id', 'taskId']) ??
    ''
  return `${record.sourceEventKind}:${native}:${eventIndex}`
}
