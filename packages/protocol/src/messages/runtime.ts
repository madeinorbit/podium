import { ResumeRef, SessionIdField, TranscriptItem } from '@podium/model'
import { z } from 'zod'
import { ObservationInputOrigin, ObservationProvenance, ProviderCursor } from './runtime-state'

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
 * WHY THE FRAMES ARE NOT YET ARMS OF `ControlMessage` / `DaemonMessage`
 * ---------------------------------------------------------------------------
 *
 * [decided POD-2019 — recorded so a later pass can re-derive the argument.]
 *
 * Those two unions are compile-TOTAL in three places at once: the plane
 * classification tables in `./message-class.ts`, the edge membership sets in
 * `../planes/port-rule.ts`, and every `createDispatcher` over them — including
 * the daemon's control registry, where a mapped type makes a union member
 * without a handler a compile error.
 *
 * That totality is a feature, and it is exactly why these frames stay out for
 * now: folding them in would force stub handlers into the daemon and a plane
 * classification argued from nothing, in a work item whose acceptance criterion
 * is NO BEHAVIOR CHANGE ANYWHERE. A classification is a claim about durability
 * and replay — "a lost one is a permanent invisible gap" versus "the durable
 * truth arrives by another path" — and that claim cannot be made honestly before
 * a producer and a consumer exist.
 *
 * WHAT CHANGES THIS: W2 (the interactions backbone) and W3 (the terminal
 * driver) land the first producer and consumer. At that point each frame below
 * joins the peer union it belongs to and takes a classification with a real
 * argument behind it. The expected homes, stated now so the later change is a
 * confirmation rather than a fresh decision:
 *
 *   - `runtimeEvent`            → daemon→server, `control.entity` (durable-synced:
 *                                 a lost RuntimeEvent is a permanent gap in the
 *                                 causal stream, the same argument as `feedDelta`)
 *   - `runtimeInteractionAsked` → daemon→server, `control.entity` (a blocking ask
 *                                 nobody recovers is the stuck session §4 exists
 *                                 to abolish)
 *   - every `runtime*Request`   → server→daemon, `control.command` (correlated
 *     and its `*Result`           request/reply, like every other session verb)
 *   - `runtimeAttachResult`     → the frame STREAM stays `bulk`/`stream.live` on
 *                                 the existing terminal frames path, untouched
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
// Interactions (§4)
// ---------------------------------------------------------------------------

export const InteractionKind = z.enum([
  'permission',
  'question',
  'plan-approval',
  'elicitation',
  'login',
  /** Resume-time prompts, asked while the session is still STARTING. */
  'recovery',
])
export type InteractionKind = z.infer<typeof InteractionKind>

/** PROVENANCE ⇒ CONFIDENCE, and a hard consumer obligation: classifier-sourced
 *  interactions are AT-LEAST-ONCE, never exactly-once. */
export const InteractionSource = z.enum(['protocol', 'sdk-callback', 'hook', 'screen-classifier'])
export type InteractionSource = z.infer<typeof InteractionSource>

export const InteractionAnswerability = z.enum(['structured', 'keystroke-emulated'])
export type InteractionAnswerability = z.infer<typeof InteractionAnswerability>

export const PendingInteraction = z.object({
  /** UNBRANDED BY DECISION: minted by the driver that observed the ask, in that
   *  driver's namespace. W2's durable aggregate keys its own rows. */
  id: z.string().min(1),
  sessionId: z.string().min(1).pipe(SessionIdField),
  kind: InteractionKind,
  /** OPAQUE IN W1. The per-kind payload and answer schemas are the spec's named
   *  phase-1 deliverable and W2 owns them; a guessed union here would be a
   *  vocabulary nobody agreed to. An open record rather than `unknown` keeps the
   *  key REQUIRED — a payload-less ask is not a thing. */
  payload: z.record(z.string(), z.unknown()),
  askedAt: z.string().datetime(),
  source: InteractionSource,
  answerable: InteractionAnswerability,
  policyVerdict: z.enum(['auto-allowed', 'auto-denied', 'escalated']).optional(),
  /** ESCALATION DEADLINE, NOT AUTO-DENY. Passing it raises visibility; it never
   *  answers the ask. */
  expiresAt: z.string().datetime().optional(),
})
export type PendingInteraction = z.infer<typeof PendingInteraction>

export const InteractionEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('asked'), interaction: PendingInteraction }),
  z.object({
    ev: z.literal('answered'),
    id: z.string().min(1),
    answeredBy: z.enum(['policy', 'superagent', 'human']),
    at: z.string().datetime(),
  }),
  z.object({ ev: z.literal('expired'), id: z.string().min(1), at: z.string().datetime() }),
])
export type InteractionEvent = z.infer<typeof InteractionEvent>

/** Answering is IDEMPOTENT: a second answer is a typed error, never a double
 *  action. Classifier-sourced asks make this load-bearing rather than pedantic. */
export const InteractionAnswerOutcome = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['already-answered', 'expired', 'unknown-interaction']),
  }),
])
export type InteractionAnswerOutcome = z.infer<typeof InteractionAnswerOutcome>

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

// ---------------------------------------------------------------------------
// The frames
// ---------------------------------------------------------------------------
//
// DECLARED, NOT YET ROUTED. These are STANDALONE schemas, exactly like
// `./runtime-state.ts` — they are deliberately NOT arms of `ControlMessage` /
// `DaemonMessage` and carry no `MESSAGE_SYNC_CLASSES` entry in W1.
//
// [decided POD-2019 — recorded so a later pass can re-derive the argument.]
// Those unions are compile-TOTAL in three places at once: the plane
// classification tables in `./message-class.ts`, the edge membership sets in
// `../planes/port-rule.ts`, and every `createDispatcher` over them — including
// the daemon's control registry, where a mapped type makes a union member
// without a handler a compile error. Folding these in now would force stub
// handlers across apps and a plane classification argued from nothing, in a work
// item whose acceptance criterion is NO BEHAVIOR CHANGE ANYWHERE. A
// classification is a claim about durability and replay — "a lost one is a
// permanent invisible gap" versus "the durable truth arrives by another path" —
// and that claim cannot be made honestly before a producer and a consumer exist.
//
// SYNC-CLASS INTENT, as a comment now and a table entry when W2/W3 land a
// producer:
//   - `runtimeEvent`             durable-synced (`control.entity`). A lost
//                                RuntimeEvent is a permanent gap in the causal
//                                stream — the same argument as `feedDelta`.
//   - `runtimeInteractionAsked`  durable-synced (`control.entity`). A blocking
//                                ask nobody recovers is exactly the stuck
//                                session §4 exists to abolish.
//   - `runtimeSendRequest` and its result, `runtimeAnswerRequest` and its
//                                result: command (`control.command`) — correlated
//                                request/reply, like every other session verb.
//
// Attach negotiation is absent entirely: its first consumer is W5.

/** server → daemon: the two write verbs W2 and W3 need. */
export const RuntimeCommandMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('runtimeSendRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    text: z.string(),
    origin: ObservationInputOrigin,
    delivery: TurnDelivery,
  }),
  z.object({
    type: z.literal('runtimeAnswerRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    interactionId: z.string().min(1),
    answer: z.record(z.string(), z.unknown()),
  }),
])
export type RuntimeCommandMessage = z.infer<typeof RuntimeCommandMessage>

/** daemon → server: receipts, answer outcomes, the causal event stream, and the
 *  ask that opens an interaction's durable life. */
export const RuntimeEventMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('runtimeSendResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    receipt: TurnReceipt,
  }),
  z.object({
    type: z.literal('runtimeAnswerResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    outcome: InteractionAnswerOutcome,
  }),
  z.object({
    type: z.literal('runtimeInteractionAsked'),
    sessionId: z.string().min(1).pipe(SessionIdField),
    interaction: PendingInteraction,
  }),
  z.object({
    type: z.literal('runtimeEvent'),
    sessionId: z.string().min(1).pipe(SessionIdField),
    event: RuntimeEvent,
  }),
])
export type RuntimeEventMessage = z.infer<typeof RuntimeEventMessage>

export const RuntimeMessage = z.union([RuntimeCommandMessage, RuntimeEventMessage])
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
  'runtimeSendRequest',
  'runtimeAnswerRequest',
  'runtimeSendResult',
  'runtimeAnswerResult',
  'runtimeInteractionAsked',
  'runtimeEvent',
] as const satisfies readonly RuntimeMessage['type'][]

/** Frames in the union that {@link RUNTIME_FRAME_TYPES} forgot. `never` when the
 *  list is complete — which is what the check below requires. */
type Unlisted = Exclude<RuntimeMessage['type'], (typeof RUNTIME_FRAME_TYPES)[number]>
const _runtimeFrameListIsComplete: Unlisted extends never ? true : never = true
void _runtimeFrameListIsComplete
