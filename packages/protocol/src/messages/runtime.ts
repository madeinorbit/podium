import { ResumeRef, SessionIdField, TranscriptItem } from '@podium/model'
import { z } from 'zod'
import { ObservationInputOrigin, ObservationProvenance, ProviderCursor } from './runtime-state'
import {
  InteractionAnswerOutcome,
  InteractionEvent,
  PendingInteraction,
} from './runtime-interactions'

// The interaction contract is one vocabulary with this file; it lives in its own
// module only so the browser can take that half without the daemon plane
// (POD-2470). Re-exported so every daemon-plane consumer still sees one surface.
export * from './runtime-interactions'

/**
 * THE `runtime` MESSAGE FAMILY — the wire projection of the Agent Runtime
 * contract (POD-1761 W1; docs/2026-08-07-agent-runtime-architecture.html §3, §8).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS HERE, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------------
 *
 * Exactly three things cross the wire in W1: TURN RECEIPTS, the RUNTIME EVENT
 * envelope, and PENDING INTERACTIONS with their ask/answer commands. Those are
 * the shapes W2's interactions aggregate and W3's terminal driver need to speak,
 * and no more.
 *
 * NOT HERE, on purpose:
 *   - The driver TAXONOMY (`DriverFamily`, `DriverId`, the `*RuntimeSpec`
 *     shapes, `SelectionContext`). Those are defined once in `@podium/harness`,
 *     beside the manifest that declares them, and re-exported by
 *     `@podium/agent-runtime`. Protocol sits BELOW harness and must not import
 *     it, so a copy here would be a third definition site reconciled by hope.
 *     Nothing on this wire needs them yet.
 *   - ATTACH NEGOTIATION. Its first consumer is W5, and a schema arm nothing can
 *     produce is a promise to a client that this build cannot keep.
 *   - `SessionBinding`, lease, health and usage — same rule: no producer, no
 *     consumer, no schema.
 *
 * WHY HERE AND NOT IN `packages/agent-runtime`: that package is L2 and depends
 * on this one, and its consumers are restricted to the machine host. A server or
 * client that only needs to PARSE a runtime frame must be able to do so without
 * taking a host capability. `ProviderCursor` in this file's neighbour is the
 * standing precedent — the causal observation protocol already lives there.
 *
 * ---------------------------------------------------------------------------
 * TWELVE OF THE THIRTEEN FRAMES ARE ARMS OF `ControlMessage` / `DaemonMessage`
 * AS OF W3
 * ---------------------------------------------------------------------------
 *
 * [decided POD-2019, discharged POD-2021 — the argument is kept because the
 * classification below rests on it.]
 *
 * Those two unions are compile-TOTAL in three places at once: the plane
 * classification tables in `./message-class.ts`, the edge membership sets in
 * `../planes/port-rule.ts`, and every `createDispatcher` over them — including
 * the daemon's control registry, where a mapped type makes a union member
 * without a handler a compile error. W1 kept these frames OUT of the unions for
 * exactly that reason: folding them in would have forced stub handlers into the
 * daemon and a plane classification argued from nothing, in a work item whose
 * acceptance criterion was NO BEHAVIOR CHANGE ANYWHERE.
 *
 * W3 lands the producer (`apps/daemon/src/runtime`) and the consumer
 * (`apps/server/src/modules/sessions/runtime-gateway.ts`), so the classification
 * can now be argued rather than guessed:
 *
 *   - every `runtime*Request` and its `*Result` → `control.command`. They are
 *     correlated request/reply over a live path, exactly like `spawn`,
 *     `memoryBreakdownRequest` and every other session verb. A lost one is a
 *     failed RPC the caller already has to handle, not a durability hole.
 *   - `runtimeEvent` → `control.entity`. POD-2411 makes coarse events
 *     the sole board/recency input after readiness, so the daemon fsync-retains
 *     each one until the server commits its oplog row and restart checkpoint,
 *     then acknowledges the delivery. `runtimeFineEvent` is the separate
 *     `stream.live` token-delta frame and is never retained or persisted.
 *   - `runtimeInteractionAsked` stays OUT, and is the reason this section says
 *     twelve rather than thirteen. Its producer is W2's interactions aggregate,
 *     and W1's classification for it — durable-synced, because a blocking ask
 *     nobody recovers is the stuck session §4 exists to abolish — is a claim
 *     about a durable row that does not exist yet. Folding it in now would be
 *     the guessed classification this whole argument avoids.
 */

// ---------------------------------------------------------------------------
// Deliveries and proof
// ---------------------------------------------------------------------------

export const TurnDelivery = z.enum(['when-ready', 'queue', 'interrupt', 'steer'])
export type TurnDelivery = z.infer<typeof TurnDelivery>

/** What proved a send was accepted. The MECHANISM is declared so callers can
 *  stop caring which one it was — but a driver may not invent one it never
 *  claimed in its capabilities. */
export const SendProof = z.enum(['protocol-ack', 'sdk-callback', 'hook', 'transcript-echo'])
export type SendProof = z.infer<typeof SendProof>

// ---------------------------------------------------------------------------
// Refusals — synchronous and EXPECTED, not errors
// ---------------------------------------------------------------------------

export const RefusalReason = z.enum([
  'needs_user',
  'lease_held',
  'unsupported',
  'no_resume_ref',
  'session_ended',
  'not_running',
  'staging_failed',
  'busy',
])
export type RefusalReason = z.infer<typeof RefusalReason>

export const Refusal = z.object({
  reason: RefusalReason,
  /** Harness detail for diagnostics. NEVER parsed for control flow — that is
   *  what the typed `reason` is for. */
  detail: z.string().optional(),
})
export type Refusal = z.infer<typeof Refusal>

// ---------------------------------------------------------------------------
// The four send outcomes
// ---------------------------------------------------------------------------

/**
 * `send` resolves to exactly one of accepted / queued / refused / unverified.
 *
 * `unverified` is the two-generals gap made explicit instead of retried into a
 * lie: the keystrokes were delivered but acceptance could not be proven inside
 * the window. It is TERMINAL-FAMILY ONLY, which the conformance suite's
 * permitted-failures table enforces in both directions.
 *
 * `deliveredAs` appears on every non-refused arm because a driver that degraded
 * `steer` to `queue` must SAY SO — no silent substitution.
 */
export const TurnReceipt = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    turnEpoch: z.number().int().nonnegative(),
    deliveredAs: TurnDelivery,
    provenBy: SendProof,
    at: z.string().datetime(),
  }),
  z.object({
    outcome: z.literal('queued'),
    position: z.number().int().nonnegative(),
    deliveredAs: TurnDelivery,
    at: z.string().datetime(),
  }),
  z.object({ outcome: z.literal('refused'), refusal: Refusal }),
  z.object({
    outcome: z.literal('unverified'),
    deliveredAs: TurnDelivery,
    /** How long the driver already waited. A bare "we don't know" pushes the
     *  same guess onto every caller, which is what this outcome exists to stop. */
    verificationWindowMs: z.number().int().nonnegative(),
    at: z.string().datetime(),
  }),
])
export type TurnReceipt = z.infer<typeof TurnReceipt>


// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

export const TurnFailureReason = z.enum([
  'rate-limit',
  'auth-expired',
  'context-overflow',
  'provider-error',
  'timeout',
  'interrupted',
])
export type TurnFailureReason = z.infer<typeof TurnFailureReason>

/** ONE ROUTING RULE keeps sessions unstuck: `needs-human` failures materialize
 *  as PendingInteractions (auth-expired → `login`, context-overflow →
 *  `recovery`). */
export const FailureDisposition = z.enum(['retryable', 'needs-human', 'fatal'])
export type FailureDisposition = z.infer<typeof FailureDisposition>

export const TurnEvent = z.discriminatedUnion('ev', [
  z.object({
    ev: z.literal('started'),
    turnEpoch: z.number().int().nonnegative(),
    origin: ObservationInputOrigin,
  }),
  z.object({
    ev: z.literal('completed'),
    turnEpoch: z.number().int().nonnegative(),
    verdict: z.enum(['done', 'question', 'approval', 'open_todos', 'interrupted']),
  }),
  z.object({
    ev: z.literal('failed'),
    turnEpoch: z.number().int().nonnegative(),
    reason: TurnFailureReason,
    disposition: FailureDisposition,
    detail: z.string().optional(),
  }),
])
export type TurnEvent = z.infer<typeof TurnEvent>

export const ExitClassification = z.enum(['clean', 'crashed', 'killed', 'oom'])
export type ExitClassification = z.infer<typeof ExitClassification>

/** Process failure is its OWN channel: a process tree dying is not a turn
 *  outcome. Transport failures are deliberately absent — a session may be alive
 *  and adoptable while the path to it is down, and conflating the two is how
 *  ghost sessions happen. */
export const ProcessEvent = z.discriminatedUnion('ev', [
  z.object({
    ev: z.literal('exited'),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    classification: ExitClassification,
  }),
  z.object({ ev: z.literal('oomKilled'), scopeUnit: z.string().optional() }),
  z.object({ ev: z.literal('adopted'), bindingVersion: z.number().int().nonnegative() }),
])
export type ProcessEvent = z.infer<typeof ProcessEvent>

// ---------------------------------------------------------------------------
// The causal envelope and the event stream
// ---------------------------------------------------------------------------

/** Every read is causally enveloped. Reuses the neighbouring causal observation
 *  protocol rather than minting a second cursor vocabulary — only the cursor
 *  MATERIAL differs per family, and that difference is already inside
 *  `ProviderCursor`. */
export const CausalEnvelope = z.object({
  /** EVENT-time, never observe-time: observe-time stamping is what makes a
   *  reattach restamp every session to "now". */
  at: z.string().datetime(),
  provenance: ObservationProvenance,
  cursor: ProviderCursor,
  observerGeneration: z.number().int().positive(),
  turnEpoch: z.number().int().nonnegative(),
})
export type CausalEnvelope = z.infer<typeof CausalEnvelope>

export const TranscriptItemDelta = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete'), item: TranscriptItem }),
  z.object({
    kind: z.literal('delta'),
    itemId: z.string().min(1),
    textDelta: z.string(),
  }),
])
export type TranscriptItemDelta = z.infer<typeof TranscriptItemDelta>

export const CwdChanged = z.object({ ev: z.literal('cwd-changed'), cwd: z.string().min(1) })
export const GitActivity = z.object({
  ev: z.literal('git-activity'),
  /** READONLY on the wire as well as in the contract: these are observations,
   *  and a consumer that mutates the list it was handed corrupts every other
   *  consumer of the same fanned-out frame. */
  commits: z.array(z.string()).readonly(),
  touchedFiles: z.array(z.string()).readonly(),
})

/**
 * ONE EVENT STREAM PER SESSION, every arm causally enveloped.
 *
 * The `state` arm carries the EXISTING normalized `AgentStateEvent` vocabulary
 * rather than a parallel one. It is typed here as an open record because that
 * vocabulary is defined in `packages/harness` (L2), which this package sits
 * below — the same directional constraint that put these schemas here in the
 * first place. `@podium/agent-runtime` re-narrows it to `AgentStateEvent` at its
 * own boundary, where the import is legal.
 */
export const RuntimeEventBody = z.discriminatedUnion('t', [
  z.object({ t: z.literal('state'), change: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal('item'), item: TranscriptItemDelta }),
  z.object({ t: z.literal('interaction'), ev: InteractionEvent }),
  z.object({ t: z.literal('turn'), ev: TurnEvent }),
  z.object({ t: z.literal('process'), ev: ProcessEvent }),
  z.object({ t: z.literal('workspace'), ev: z.union([CwdChanged, GitActivity]) }),
  z.object({
    t: z.literal('open-url'),
    ev: z.object({ url: z.string(), intent: z.enum(['login', 'link']) }),
  }),
])
export type RuntimeEventBody = z.infer<typeof RuntimeEventBody>

export const RuntimeEvent = z.intersection(CausalEnvelope, RuntimeEventBody)
export type RuntimeEvent = z.infer<typeof RuntimeEvent>

/** The only payload legal on the live-only fine plane. */
export const RuntimeFineEvent = z.intersection(
  CausalEnvelope,
  z.object({
    t: z.literal('item'),
    item: z.object({
      kind: z.literal('delta'),
      itemId: z.string().min(1),
      textDelta: z.string(),
    }),
  }),
)
export type RuntimeFineEvent = z.infer<typeof RuntimeFineEvent>

export const RuntimeAttachmentRef = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  kind: z.enum(['image', 'file']),
})
export type RuntimeAttachmentRef = z.infer<typeof RuntimeAttachmentRef>

export const RuntimeAttachmentSource = z.object({
  dataBase64: z.string().max(10 * 1024 * 1024),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
})
export type RuntimeAttachmentSource = z.infer<typeof RuntimeAttachmentSource>

// ---------------------------------------------------------------------------
// The frames
// ---------------------------------------------------------------------------
//
// Each carries a `requestId` where it is half of a correlated pair, matching
// every other session verb on the host edge. They are exported INDIVIDUALLY
// because `ControlMessage`/`DaemonMessage` are `z.discriminatedUnion`s over
// member schemas — a nested union cannot be an arm of one.

/** server → daemon: deliver one turn through the contract. */
export const RuntimeSendRequestMessage = z.object({
  type: z.literal('runtimeSendRequest'),
  requestId: z.string(),
  /**
   * Stable delivery identity, distinct from the one-shot RPC correlation id.
   *
   * `.min(1)` because the EMPTY STRING is not an identity (POD-2297 review, 5).
   * A driver that loses this turn reports it by id, and the abandonment frame
   * requires ids of `.min(1)` — so an empty one would be wire-legal on the way
   * in and unreportable on the way out, landing the turn in the log-only bucket
   * with no receipt correction. Nothing emits one today; this closes the door
   * rather than relying on that staying true.
   */
  turnId: z.string().min(1),
  sessionId: z.string().min(1).pipe(SessionIdField),
  text: z.string(),
  origin: ObservationInputOrigin,
  delivery: TurnDelivery,
  attachments: z.array(RuntimeAttachmentRef).optional(),
})
export type RuntimeSendRequestMessage = z.infer<typeof RuntimeSendRequestMessage>

export const RuntimeStageAttachmentRequestMessage = z.object({
  type: z.literal('runtimeStageAttachmentRequest'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  source: RuntimeAttachmentSource,
})
export type RuntimeStageAttachmentRequestMessage = z.infer<
  typeof RuntimeStageAttachmentRequestMessage
>

/** server → daemon: REQUEST a fence. The fence itself only ever arrives as a
 *  provider-confirmed terminal event on the causal stream. */
export const RuntimeInterruptRequestMessage = z.object({
  type: z.literal('runtimeInterruptRequest'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
})
export type RuntimeInterruptRequestMessage = z.infer<typeof RuntimeInterruptRequestMessage>

export const RuntimeAnswerRequestMessage = z.object({
  type: z.literal('runtimeAnswerRequest'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  interactionId: z.string().min(1),
  answer: z.record(z.string(), z.unknown()),
})
export type RuntimeAnswerRequestMessage = z.infer<typeof RuntimeAnswerRequestMessage>

export const RuntimeLifecycleRequestMessage = z.object({
  type: z.literal('runtimeLifecycleRequest'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  verb: z.enum(['stop', 'hibernate', 'kill']),
})
export type RuntimeLifecycleRequestMessage = z.infer<typeof RuntimeLifecycleRequestMessage>

/**
 * ATTACH STILL HAS NO FRAME. SNAPSHOT NOW DOES (POD-2023, discharging the W5
 * precondition recorded above).
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRECONDITION HAD TO BE DISCHARGED HERE
 * ---------------------------------------------------------------------------
 *
 * Snapshot remains the folded recovery/read primitive. Coarse delivery no
 * longer depends on snapshot reconstruction: the acknowledged daemon outbox
 * preserves individual turn/git/activity edges that a folded snapshot cannot.
 * A snapshot is still how a consumer obtains current state and an ordered
 * cursor when it has no prior head.
 *
 * ATTACH STAYS OUT for W1's original reason, unchanged: `attach()` is
 * implemented on the driver and exercised by the corpus, and nothing on the
 * server negotiates one. `AttachEndpoint` gets a schema in the item that gives
 * it a remote caller.
 */

/**
 * The live identity half of the identity triangle — WHO and WHERE the process
 * is. Re-added under the header's rule (no producer, no schema) because W5's
 * snapshot frame carries one and the daemon produces it.
 *
 * `process.key` is OPAQUE AND DRIVER-PRIVATE by contract: an abduco label, a
 * scope unit name, a socket path. The wire carries it without interpreting it,
 * which is what lets one schema serve every family.
 */
export const SessionBinding = z.object({
  sessionId: z.string().min(1).pipe(SessionIdField),
  driver: z.string().min(1),
  family: z.enum(['server', 'embedded', 'terminal']),
  harness: z.string().min(1),
  workdir: z.string(),
  /** NULLABLE, not optional: a harness that mints its resume ref lazily (Codex
   *  rollout files) genuinely has none yet, and `null` says so where an absent
   *  key would read as "not carried on this wire". */
  resume: ResumeRef.nullable(),
  principal: z.string().optional(),
  process: z.object({
    key: z.string().min(1),
    scopeUnit: z.string().optional(),
    pid: z.number().int().optional(),
  }),
  bindingVersion: z.number().int().nonnegative(),
})
export type SessionBinding = z.infer<typeof SessionBinding>

/**
 * OBSERVATION BOOTSTRAP: what the causal contract needs to resume WATCHING.
 *
 * Exactly one of these opens an event stream, and everything after it is a
 * cursor-fenced live delta. That is the property the whole `stream.live`
 * classification rests on, and this schema is what makes it invocable across the
 * wire.
 */
export const SessionSnapshot = z.object({
  binding: SessionBinding,
  /** The folded projection. An open record for the same directional reason
   *  `RuntimeEventBody.change` is: `AgentRuntimeState` is `@podium/model`'s and
   *  is re-narrowed at `@podium/agent-runtime`'s boundary. */
  state: z.record(z.string(), z.unknown()),
  cursor: ProviderCursor,
  /** NON-NEGATIVE, matching the contract type exactly (POD-2023 review, 6a).
   *  It was `positive()`, which made the wire NARROWER than the type it
   *  projects — the one asymmetry the drift guard below would have caught, and
   *  did once it existed. */
  observerGeneration: z.number().int().nonnegative(),
  turnEpoch: z.number().int().nonnegative(),
  interactions: z.array(PendingInteraction).readonly(),
  draft: z.string().optional(),
  at: z.string().datetime(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshot>

/** server → daemon: give me this session's observation bootstrap, so I can
 *  resume the stream from its cursor rather than from nothing. */
export const RuntimeSnapshotRequestMessage = z.object({
  type: z.literal('runtimeSnapshotRequest'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
})
export type RuntimeSnapshotRequestMessage = z.infer<typeof RuntimeSnapshotRequestMessage>

/** daemon → server: the bootstrap, or a typed refusal for a session that is not
 *  behind the contract. A refusal is an OUTCOME here exactly as it is on the
 *  lifecycle path — `not_running` is the honest answer, not an error. */
export const RuntimeSnapshotResultMessage = z.object({
  type: z.literal('runtimeSnapshotResult'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  result: z.union([z.object({ snapshot: SessionSnapshot }), Refusal]),
})
export type RuntimeSnapshotResultMessage = z.infer<typeof RuntimeSnapshotResultMessage>

/** server → daemon: the named abandonment report has reached its durable
 *  terminal-row consumer. A lost ack is harmless: the daemon replays the report,
 *  the consumer dedupes its turn ids, and the server acknowledges it again. */
export const RuntimeQueueDrainAbandonedAckMessage = z.object({
  type: z.literal('runtimeQueueDrainAbandonedAck'),
  reportId: z.string().min(1),
})
export type RuntimeQueueDrainAbandonedAckMessage = z.infer<
  typeof RuntimeQueueDrainAbandonedAckMessage
>

/** Server terminal receipt for one retained coarse-event delivery. Rejections are
 * terminal too: retrying a stale, malformed, or purged-session event cannot make
 * it admissible, so the daemon retires either outcome from its fsync outbox. */
export const RuntimeEventAckMessage = z.object({
  type: z.literal('runtimeEventAck'),
  deliveryId: z.string().min(1),
  outcome: z.enum(['committed', 'rejected']),
  rejectionReason: z.string().min(1).optional(),
})
export type RuntimeEventAckMessage = z.infer<typeof RuntimeEventAckMessage>

/** server → daemon: drive one session verb, or acknowledge one durable report. */
export const RuntimeCommandMessage = z.discriminatedUnion('type', [
  RuntimeStageAttachmentRequestMessage,
  RuntimeSendRequestMessage,
  RuntimeInterruptRequestMessage,
  RuntimeAnswerRequestMessage,
  RuntimeLifecycleRequestMessage,
  RuntimeSnapshotRequestMessage,
  RuntimeQueueDrainAbandonedAckMessage,
  RuntimeEventAckMessage,
])
export type RuntimeCommandMessage = z.infer<typeof RuntimeCommandMessage>

/**
 * daemon → server: the outcome of one `runtimeSendRequest`.
 *
 * THE OUTCOME IS NOT ALWAYS AN ANSWER, and the consumer of this frame is the
 * party that has to cope with that (POD-2297 review, E1). `unverified` — and an
 * RPC window that closes with no daemon reply at all — means UNKNOWN, not "did
 * not arrive": the server keeps its row queued and the next bind, reconnect or
 * enqueue re-sends it under the SAME `turnId`. THE WRITE PATH IS THEREFORE
 * AT-LEAST-ONCE, deliberately, because under a two-generals gap a duplicate
 * prompt is recoverable by a reader and a vanished one is not.
 *
 * WHAT THAT OBLIGES OF WHOEVER HANDLES THIS FRAME: be IDEMPOTENT UNDER REPEATS,
 * keyed on `turnId`. Idempotent, not necessarily deduplicating — a status write
 * guarded on `status = 'queued'` is already safe however often it is replayed,
 * and append-only observation events may legitimately fire once per receipt.
 * The same rule, stated the same way, governs `RuntimeQueueDrainAbandonedMessage`,
 * whose replay-until-acknowledged transport makes repeats routine rather than
 * exceptional. Neither rule reaches the duplicate the AGENT sees — two identical
 * user turns in its provider transcript carry provider ids and no `turnId`, so
 * no consumer here can pair them; that residual is POD-2497's.
 */
export const RuntimeSendResultMessage = z.object({
  type: z.literal('runtimeSendResult'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  receipt: TurnReceipt,
})
export type RuntimeSendResultMessage = z.infer<typeof RuntimeSendResultMessage>

export const RuntimeStageAttachmentResultMessage = z.object({
  type: z.literal('runtimeStageAttachmentResult'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  result: z.union([RuntimeAttachmentRef, Refusal]),
})
export type RuntimeStageAttachmentResultMessage = z.infer<
  typeof RuntimeStageAttachmentResultMessage
>

/**
 * WHY A DRIVER QUEUE GAVE UP ON TURNS IT HAD ALREADY ACCEPTED.
 *
 * Each arm is a DIFFERENT thing to tell the person holding the `queued` receipt,
 * which is why they are not collapsed into one "undelivered":
 *
 *  - `never-live`      the terminal drain reached its readiness deadline with the
 *                      session still not typeable (POD-2107, POD-2202).
 *  - `teardown`        the session stopped, was killed, hibernated, crashed or was
 *                      forgotten while turns were still parked in its queue. True
 *                      of every family; the server families reach it through their
 *                      own disposal paths (POD-2297).
 *  - `delivery-failed` a server-family driver took the turn off its queue and the
 *                      send itself threw — the link to the agent's own server was
 *                      gone or refused it (POD-2297). Distinct from `teardown`
 *                      because nobody tore anything down: the turn was attempted.
 *
 * WIDENING THIS ENUM IS A ROLLING-UPGRADE EVENT, AND THE COST IS NOT THE ONE AN
 * EARLIER DRAFT OF THIS COMMENT CLAIMED (POD-2297 review, 4). A NEW daemon
 * against an OLD server is the only arm that produces it, and it is NOT the same
 * shape as an offline server: offline, `scheduleQueueDrainRetry` returns early on
 * `state !== 'connected'` and nothing is re-sent at all. Connected-but-too-old,
 * the server drops the unparseable frame with a warn and NO ack, so the daemon
 * re-sends the ENTIRE pending outbox every 500ms forever — no backoff, no cap —
 * and every enqueue and every ack rewrites the whole JSON file with two fsyncs,
 * so the per-abandonment cost grows with the stuck set. Other frames are not
 * starved (replay interleaves on the same socket) and an unparseable frame does
 * not tear down the connection, so this cannot become a reconnect loop. Bounding
 * that outbox is POD-2499; it is not a reason to avoid a fourth arm, but it is
 * the real bill for one.
 */
export const QueueDrainAbandonedReason = z.enum(['never-live', 'teardown', 'delivery-failed'])
export type QueueDrainAbandonedReason = z.infer<typeof QueueDrainAbandonedReason>

/**
 * daemon → server: a driver queue gave up on turns it had accepted. No turn was
 * started, so this is a receipt correction, not a turn event — the daemon is
 * saying these turns were never delivered and will not be.
 *
 * THE FRAME is at-least-once, not fire-and-forget. Before the driver discards
 * these turns the daemon durably records this report, replays it while connected
 * and across daemon restarts, and retires it only after the server acknowledges
 * the durable correction. THE DELIVERY it reports on is not retried by anybody.
 * Consumers must therefore be IDEMPOTENT UNDER REPEATS, keyed on turn id, so
 * hearing a replay corrects the same receipt once — the same rule, in the same
 * words, as `RuntimeSendResultMessage`. Idempotent rather than deduplicating:
 * a status write guarded on `status = 'queued'` is already safe however often it
 * is replayed, and append-only observation events may legitimately fire once per
 * report.
 */
export const RuntimeQueueDrainAbandonedMessage = z.object({
  type: z.literal('runtimeQueueDrainAbandoned'),
  /** Present on daemons with the acknowledged outbox. Optional only so a newer
   *  server can still accept the pre-outbox frame during a rolling upgrade. */
  reportId: z.string().min(1).optional(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  turnIds: z.array(z.string().min(1)).min(1),
  reason: QueueDrainAbandonedReason,
})
export type RuntimeQueueDrainAbandonedMessage = z.infer<typeof RuntimeQueueDrainAbandonedMessage>

export const RuntimeLifecycleResultMessage = z.object({
  type: z.literal('runtimeLifecycleResult'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  /** A refusal is an OUTCOME, not an error: `hibernate` without a resume ref
   *  is expected and the caller handles it. */
  result: z.union([z.object({ ok: z.literal(true) }), Refusal]),
})
export type RuntimeLifecycleResultMessage = z.infer<typeof RuntimeLifecycleResultMessage>

export const RuntimeAnswerResultMessage = z.object({
  type: z.literal('runtimeAnswerResult'),
  requestId: z.string(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  outcome: InteractionAnswerOutcome,
})
export type RuntimeAnswerResultMessage = z.infer<typeof RuntimeAnswerResultMessage>

/**
 * daemon → server: the ask that opens an interaction's durable life.
 *
 * STILL DECLARED-ONLY after W3, and deliberately so. Its producer is the
 * interactions backbone (W2), and the classification W1 argued for it —
 * durable-synced, because "a blocking ask nobody recovers is exactly the stuck
 * session §4 exists to abolish" — is a claim about a durable aggregate that does
 * not exist yet. W3 folded the frames it PRODUCES into the peer unions and left
 * this one out rather than give it a plane class with no writer behind it.
 */
export const RuntimeInteractionAskedMessage = z.object({
  type: z.literal('runtimeInteractionAsked'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  interaction: PendingInteraction,
})
export type RuntimeInteractionAskedMessage = z.infer<typeof RuntimeInteractionAskedMessage>

/** daemon → server: one retained coarse event. The delivery id is optional only
 * during a rolling upgrade from the former unacknowledged stream. */
export const RuntimeEventMessage = z.object({
  type: z.literal('runtimeEvent'),
  deliveryId: z.string().min(1).optional(),
  sessionId: z.string().min(1).pipe(SessionIdField),
  event: RuntimeEvent,
})
export type RuntimeEventMessage = z.infer<typeof RuntimeEventMessage>

/** daemon → server: token-level viewer delta; never retained or acknowledged. */
export const RuntimeFineEventMessage = z.object({
  type: z.literal('runtimeFineEvent'),
  sessionId: z.string().min(1).pipe(SessionIdField),
  event: RuntimeFineEvent,
})
export type RuntimeFineEventMessage = z.infer<typeof RuntimeFineEventMessage>

/** daemon → server: receipts, results, and the causal event stream. */
export const RuntimeDaemonMessage = z.discriminatedUnion('type', [
  RuntimeStageAttachmentResultMessage,
  RuntimeSendResultMessage,
  RuntimeQueueDrainAbandonedMessage,
  RuntimeLifecycleResultMessage,
  RuntimeAnswerResultMessage,
  RuntimeInteractionAskedMessage,
  RuntimeSnapshotResultMessage,
  RuntimeEventMessage,
  RuntimeFineEventMessage,
])
export type RuntimeDaemonMessage = z.infer<typeof RuntimeDaemonMessage>

export const RuntimeMessage = z.union([RuntimeCommandMessage, RuntimeDaemonMessage])
export type RuntimeMessage = z.infer<typeof RuntimeMessage>

/**
 * Every frame name this family owns. W2/W3 read it when folding these into the
 * peer unions, so the fold cannot miss one.
 *
 * TWO assertions, because `satisfies` alone only gives one of them.
 * `satisfies readonly RuntimeMessage['type'][]` proves every name listed is a
 * VALID frame; it says nothing about whether the list is COMPLETE, so a frame
 * added to the union above and forgotten here would compile — and the comment
 * promising "the fold cannot miss one" would be false. `Unlisted` below closes
 * that: it resolves to `never` only when the union is fully covered, and the
 * `extends never` check fails to compile otherwise.
 */
export const RUNTIME_FRAME_TYPES = [
  'runtimeStageAttachmentRequest',
  'runtimeSendRequest',
  'runtimeInterruptRequest',
  'runtimeAnswerRequest',
  'runtimeLifecycleRequest',
  'runtimeSnapshotRequest',
  'runtimeQueueDrainAbandonedAck',
  'runtimeEventAck',
  'runtimeStageAttachmentResult',
  'runtimeSendResult',
  'runtimeQueueDrainAbandoned',
  'runtimeLifecycleResult',
  'runtimeAnswerResult',
  'runtimeInteractionAsked',
  'runtimeSnapshotResult',
  'runtimeEvent',
  'runtimeFineEvent',
] as const satisfies readonly RuntimeMessage['type'][]

/** Frames in the union that {@link RUNTIME_FRAME_TYPES} forgot. `never` when the
 *  list is complete — which is what the check below requires. */
type Unlisted = Exclude<RuntimeMessage['type'], (typeof RUNTIME_FRAME_TYPES)[number]>
const _runtimeFrameListIsComplete: Unlisted extends never ? true : never = true
void _runtimeFrameListIsComplete
