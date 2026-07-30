import { AgentPhase, AgentRuntimeState, SessionIdField, SessionMeta } from '@podium/model'
import { z } from 'zod'

// The session aggregate and the agent-runtime-state family it embeds live in
// @podium/model (POD-300). What stays here is the FRAMES: the causal
// observation protocol between daemon and server, and the server→client
// session-list/state broadcasts.

// ---- Causal observation protocol [spec:SP-cdb2] ----
// Provider history restores one snapshot. Only a fenced, cursor-new live
// observation is eligible to become a transition with downstream effects.
export const ObservationProvider = z.enum(['claude-code', 'codex', 'grok'])
export type ObservationProvider = z.infer<typeof ObservationProvider>

/**
 * An ordered position inside one exact provider segment. components is a
 * monotonic vector so providers with two channels (for example Codex rollout +
 * hooks) do not flatten incomparable evidence into receipt order.
 */
export const ProviderCursor = z.object({
  segmentId: z.string().min(1),
  predecessorSegmentId: z.string().min(1).optional(),
  pathHint: z.string().optional(),
  device: z.string().optional(),
  inode: z.string().optional(),
  integrity: z.string().min(1).optional(),
  components: z.record(z.string().min(1), z.number().int().nonnegative()),
})
export type ProviderCursor = z.infer<typeof ProviderCursor>

export const ObservationProvenance = z.enum(['bootstrap', 'live', 'replay'])
export type ObservationProvenance = z.infer<typeof ObservationProvenance>

export const ObservationInputOrigin = z.enum([
  'human',
  'controller',
  'steward',
  'mail',
  'auto_continue',
  'system',
  'provider',
  'unknown',
])
export type ObservationInputOrigin = z.infer<typeof ObservationInputOrigin>

/** Provider-normalized causal role; sourceEventKind retains native detail. */
export const ObservationTransitionKind = z.enum([
  'turn_opened',
  'activity',
  'needs_user',
  'compaction',
  'turn_terminal',
  'subagent_bookkeeping',
  'session_terminal',
  'snapshot',
])
export type ObservationTransitionKind = z.infer<typeof ObservationTransitionKind>

export const ObservationRejectionReason = z.enum([
  'stale_observer_generation',
  'provider_binding_mismatch',
  'cursor_not_after_checkpoint',
  'duplicate_transition',
  'bootstrap_has_no_live_effects',
  'replay_has_no_live_effects',
  'terminal_epoch_closed',
  'noncausal_epoch_open',
  'unproven_segment_rotation',
  'invalid_provider_timestamp',
  'legacy_unfenced_observation',
])
export type ObservationRejectionReason = z.infer<typeof ObservationRejectionReason>

export const TerminalFence = z.object({
  turnEpoch: z.number().int().nonnegative(),
  providerCursor: ProviderCursor,
  verdict: z.enum([
    'done',
    'question',
    'approval',
    'open_todos',
    'interrupted',
    'errored',
    'ended',
  ]),
  transitionId: z.string().min(1),
  /** A terminal with live children is closed to activity but may still accept
   * matching subagent bookkeeping until the count reaches zero. */
  closing: z.boolean().optional(),
})
export type TerminalFence = z.infer<typeof TerminalFence>

export const AgentObservation = z.object({
  podiumSessionId: z.string().min(1).pipe(SessionIdField),
  provider: ObservationProvider,
  providerSessionId: z.string().min(1).nullable(),
  bindingVersion: z.number().int().nonnegative(),
  providerTurnId: z.string().min(1).nullable(),
  providerPromptId: z.string().min(1).nullable(),
  observerGeneration: z.number().int().positive(),
  providerCursor: ProviderCursor,
  providerAt: z.string().datetime().nullable(),
  receivedAt: z.string().datetime(),
  sourceEventKind: z.string().min(1),
  transitionKind: ObservationTransitionKind,
  provenance: ObservationProvenance,
  inputOrigin: ObservationInputOrigin,
  turnEpoch: z.number().int().nonnegative(),
  priorPhase: AgentPhase,
  nextPhase: AgentPhase,
  transitionId: z.string().min(1),
  state: AgentRuntimeState,
})
export type AgentObservation = z.infer<typeof AgentObservation>

/** Newest-first durable history used to reject delayed observation retries.
 * [spec:SP-cdb2] */
export const ACCEPTED_TRANSITION_ID_WINDOW_SIZE = 32

export const SessionObservationCheckpointV1 = z.object({
  schemaVersion: z.literal(1),
  podiumSessionId: z.string().min(1).pipe(SessionIdField),
  provider: ObservationProvider,
  providerSessionId: z.string().min(1).nullable(),
  bindingVersion: z.number().int().nonnegative(),
  lifecycleObservationGeneration: z.number().int().nonnegative(),
  providerCursor: ProviderCursor.nullable(),
  bootstrapCursor: ProviderCursor.nullable(),
  lastAcceptedLiveCursor: ProviderCursor.nullable(),
  turnEpoch: z.number().int().nonnegative(),
  providerTurnId: z.string().min(1).nullable(),
  providerPromptId: z.string().min(1).nullable(),
  turnState: AgentRuntimeState,
  terminalFence: TerminalFence.nullable(),
  providerAt: z.string().datetime().nullable(),
  acceptedAt: z.string().datetime(),
  lastLiveReceiptAt: z.string().datetime().nullable(),
  lastTransitionId: z.string().min(1).nullable(),
  acceptedTransitionIds: z
    .array(z.string().min(1))
    .max(ACCEPTED_TRANSITION_ID_WINDOW_SIZE)
    .optional(),
})
export type SessionObservationCheckpointV1 = z.infer<typeof SessionObservationCheckpointV1>

export const ObservationAcceptanceKind = z.enum([
  'snapshot_applied',
  'live_transition_accepted',
  'live_refresh_accepted',
  'rejected',
])
export type ObservationAcceptanceKind = z.infer<typeof ObservationAcceptanceKind>

// daemon -> server
export const AgentObservationMessage = z.object({
  type: z.literal('agentObservation'),
  observation: AgentObservation,
})
export type AgentObservationMessage = z.infer<typeof AgentObservationMessage>

/** Provider-neutral proof of a later unchanged live observer poll. [spec:SP-cdb2] */
export const AgentObserverLiveConfirmationMessage = z.object({
  type: z.literal('agentObserverLiveConfirmation'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  provider: ObservationProvider,
  providerSessionId: z.string().min(1).nullable(),
  bindingVersion: z.number().int().positive(),
  observerGeneration: z.number().int().positive(),
  providerCursor: ProviderCursor,
  livePollSequence: z.number().int().positive(),
  confirmedAt: z.string().datetime(),
})
export type AgentObserverLiveConfirmationMessage = z.infer<
  typeof AgentObserverLiveConfirmationMessage
>

// server -> daemon. The durable commit precedes an accepted ack.
export const AgentObservationAckMessage = z.object({
  type: z.literal('agentObservationAck'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  observerGeneration: z.number().int().positive(),
  /** Exact binding fence. Optional only so an older server ack remains parseable. */
  bindingVersion: z.number().int().positive().optional(),
  transitionId: z.string().min(1),
  result: ObservationAcceptanceKind,
  rejectionReason: ObservationRejectionReason.optional(),
  acceptedCursor: ProviderCursor.nullable().optional(),
  /** Authoritative durable state after acceptance or rejection. New daemons use
   * this to rebootstrap after a causal disagreement instead of replaying the
   * rejected live edge. Optional for rolling compatibility with older servers. */
  checkpoint: SessionObservationCheckpointV1.nullable().optional(),
})
export type AgentObservationAckMessage = z.infer<typeof AgentObservationAckMessage>

/**
 * A provider-confirmed native-session replacement (for example Codex `/new`).
 * The prior lease identity makes retries and late old-provider reports inert.
 * Acceptance always resets the provider cursor; the provider submits a normal
 * bootstrap only after the server returns the resulting lease.
 * [spec:SP-cdb2]
 */
export const AgentObservationRebindMessage = z.object({
  type: z.literal('agentObservationRebind'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  provider: ObservationProvider,
  providerSessionId: z.string().min(1).nullable(),
  observerGeneration: z.number().int().positive(),
  bindingVersion: z.number().int().positive(),
  nextProviderSessionId: z.string().min(1),
  resumeKind: z.string().min(1),
  rebindId: z.string().min(1),
})
export type AgentObservationRebindMessage = z.infer<typeof AgentObservationRebindMessage>

export const AgentObservationRebindAckMessage = z.object({
  type: z.literal('agentObservationRebindAck'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  provider: ObservationProvider,
  rebindId: z.string().min(1),
  priorObserverGeneration: z.number().int().positive(),
  priorBindingVersion: z.number().int().positive(),
  nextProviderSessionId: z.string().min(1),
  /** Current durable identity after applying (accepted) or rejecting the request. */
  providerSessionId: z.string().min(1).nullable(),
  result: z.enum(['accepted', 'rejected']),
  rejectionReason: ObservationRejectionReason.optional(),
  observerGeneration: z.number().int().positive(),
  bindingVersion: z.number().int().positive(),
  checkpoint: SessionObservationCheckpointV1.nullable(),
})
export type AgentObservationRebindAckMessage = z.infer<typeof AgentObservationRebindAckMessage>
// server -> browser client: full session-list snapshot.
export const SessionsChangedMessage = z.object({
  type: z.literal('sessionsChanged'),
  sessions: z.array(SessionMeta),
})

// Connection-scoped authorization revocation. These ids were already visible
// to this client; removing them reveals no entity the client did not know.
export const SessionViewDeltaMessage = z.object({
  type: z.literal('sessionViewDelta'),
  removedSessionIds: z.array(z.string()),
})

// One session's runtime phase changed. A dedicated message — not a full
// sessionsChanged rebroadcast — because hook events fire often (a TodoWrite
// mutation, every turn boundary, across all sessions) and re-serializing the
// whole list per event is O(sessions × clients) several times a second.
export const SessionAgentStateChangedMessage = z.object({
  type: z.literal('sessionAgentStateChanged'),
  sessionId: SessionIdField,
  state: AgentRuntimeState,
})

// Harness-observed agent state changed (hooks-driven). Low-frequency: phase
// transitions only, never per-frame. daemon -> server.
export const AgentStateMessage = z.object({
  type: z.literal('agentState'),
  sessionId: SessionIdField,
  state: AgentRuntimeState,
})
