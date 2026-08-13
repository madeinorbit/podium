import { ResumeRef, SessionIdField, TranscriptItem } from '@podium/model'
import { z } from 'zod'
import { ObservationInputOrigin, ObservationProvenance, ProviderCursor } from './runtime-state'

/**
 * THE `runtime` MESSAGE FAMILY — the wire projection of the Agent Runtime
 * contract (POD-1761 W1; docs/2026-08-07-agent-runtime-architecture.html §3, §8).
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCHEMAS LIVE HERE AND NOT IN `packages/agent-runtime`
 * ---------------------------------------------------------------------------
 *
 * `packages/agent-runtime` is L2 and depends on this package; the dependency
 * cannot point the other way. If the contract's value schemas lived up there,
 * every consumer that only needs to PARSE a runtime frame — the server, the
 * clients, the CLI — would have to import a package whose consumers are
 * restricted to the machine host, which is precisely the coupling the boundary
 * exists to prevent.
 *
 * So the VALUES are defined here, once, and `@podium/agent-runtime/schemas`
 * imports them and asserts them structurally equal to its TypeScript contract.
 * One definition site, one drift guard, and the layering points the right way.
 * `ProviderCursor` above is the standing precedent: the causal observation
 * protocol already lives in this file's neighbour.
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
// Families, drivers, deliveries
// ---------------------------------------------------------------------------

export const DriverFamily = z.enum(['server', 'embedded', 'terminal'])
export type DriverFamily = z.infer<typeof DriverFamily>

/** CLOSED on purpose: a driver lands as code in `packages/agent-runtime`, so a
 *  new id is a deliberate edit rather than a string that typos silently. */
export const DriverId = z.enum([
  'codex-app-server',
  'opencode-server',
  'claude-sdk',
  'claude-pty',
  'generic-pty',
  'fake',
])
export type DriverId = z.infer<typeof DriverId>

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
// Binding — LIVE identity
// ---------------------------------------------------------------------------

export const ProcessIdentity = z.object({
  /** Opaque, driver-private, and EXACT. `adopt()` matches on this; a prefix or
   *  heuristic match adopts the wrong process, which is worse than not
   *  adopting at all. */
  key: z.string().min(1),
  scopeUnit: z.string().optional(),
  pid: z.number().int().positive().optional(),
})
export type ProcessIdentity = z.infer<typeof ProcessIdentity>

export const SessionBinding = z.object({
  sessionId: z.string().min(1).pipe(SessionIdField),
  driver: DriverId,
  family: DriverFamily,
  harness: z.string().min(1),
  workdir: z.string().min(1),
  /** UNBRANDED BY DECISION: a harness-native resume ref is evidence, not Podium
   *  identity. Null while the harness has not minted one — which is honest for
   *  Codex's lazy rollout files and is why `hibernate` can refuse. */
  resume: ResumeRef.nullable(),
  account: z.string().optional(),
  process: ProcessIdentity,
  bindingVersion: z.number().int().nonnegative(),
})
export type SessionBinding = z.infer<typeof SessionBinding>

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
// Attach, lease, health, usage
// ---------------------------------------------------------------------------

export const TerminalStreamRef = z.object({ id: z.string().min(1) })
export type TerminalStreamRef = z.infer<typeof TerminalStreamRef>

/** Only the two LIVE variants. The spec's reserved `user-local` and `handover`
 *  arms are deliberately absent from the wire: a schema arm nothing can produce
 *  is a promise to a client that this build cannot keep. */
export const AttachEndpoint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('engine'), stream: TerminalStreamRef }),
  z.object({
    kind: z.literal('client'),
    placement: z.literal('on-machine'),
    stream: TerminalStreamRef,
    warm: z.object({ ttlMs: z.number().int().nonnegative() }),
  }),
])
export type AttachEndpoint = z.infer<typeof AttachEndpoint>

/** ONE CONTROL LEASE PER SESSION: one driver-controller or one human-controller,
 *  unlimited spectators. Generalizes `exclusiveInteractiveResume` from a Claude
 *  quirk into the concurrency model. */
export const SessionLease = z.object({
  holder: z.string().min(1),
  kind: z.enum(['driver-controller', 'human-controller']),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
})
export type SessionLease = z.infer<typeof SessionLease>

export const SessionHealth = z.object({
  alive: z.boolean(),
  memoryBytes: z.number().int().nonnegative().optional(),
  scopeUnit: z.string().optional(),
  oomEvents: z.number().int().nonnegative(),
})
export type SessionHealth = z.infer<typeof SessionHealth>

export const UsageSnapshot = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  contextUsedPercent: z.number().min(0).max(100).optional(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>

export const SessionSnapshot = z.object({
  binding: SessionBinding,
  /** The normalized runtime state. Typed open here for the same layering reason
   *  as `RuntimeEventBody.change`. */
  state: z.record(z.string(), z.unknown()),
  cursor: ProviderCursor,
  observerGeneration: z.number().int().positive(),
  turnEpoch: z.number().int().nonnegative(),
  interactions: z.array(PendingInteraction).readonly(),
  draft: z.string().optional(),
  at: z.string().datetime(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshot>

// ---------------------------------------------------------------------------
// The frames
// ---------------------------------------------------------------------------
//
// DECLARED, NOT YET ROUTED — see the header. Each carries a `requestId` where it
// is half of a correlated pair, matching every other session verb on the
// host edge.

/** server → daemon: drive one session verb through the contract. */
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
    type: z.literal('runtimeInterruptRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
  }),
  z.object({
    type: z.literal('runtimeAnswerRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    interactionId: z.string().min(1),
    answer: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('runtimeLifecycleRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    verb: z.enum(['stop', 'hibernate', 'kill']),
  }),
  z.object({
    type: z.literal('runtimeAttachRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    mode: z.enum(['takeover', 'peek']),
    holder: z.string().min(1),
  }),
  z.object({
    type: z.literal('runtimeSnapshotRequest'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
  }),
])
export type RuntimeCommandMessage = z.infer<typeof RuntimeCommandMessage>

/** daemon → server: receipts, results, and the causal event stream. */
export const RuntimeEventMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('runtimeSendResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    receipt: TurnReceipt,
  }),
  z.object({
    type: z.literal('runtimeLifecycleResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    /** A refusal is an OUTCOME, not an error: `hibernate` without a resume ref
     *  is expected and the caller handles it. */
    result: z.union([z.object({ ok: z.literal(true) }), Refusal]),
  }),
  z.object({
    type: z.literal('runtimeAnswerResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    outcome: InteractionAnswerOutcome,
  }),
  z.object({
    type: z.literal('runtimeAttachResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    endpoint: z.union([AttachEndpoint, Refusal]),
  }),
  z.object({
    type: z.literal('runtimeSnapshotResult'),
    requestId: z.string(),
    sessionId: z.string().min(1).pipe(SessionIdField),
    snapshot: SessionSnapshot,
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

/** Every frame name this family owns. W2/W3 read it when folding these into the
 *  peer unions, so the fold cannot miss one. */
export const RUNTIME_FRAME_TYPES = [
  'runtimeSendRequest',
  'runtimeInterruptRequest',
  'runtimeAnswerRequest',
  'runtimeLifecycleRequest',
  'runtimeAttachRequest',
  'runtimeSnapshotRequest',
  'runtimeSendResult',
  'runtimeLifecycleResult',
  'runtimeAnswerResult',
  'runtimeAttachResult',
  'runtimeSnapshotResult',
  'runtimeEvent',
] as const satisfies readonly RuntimeMessage['type'][]
