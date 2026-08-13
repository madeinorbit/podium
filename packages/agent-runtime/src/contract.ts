/**
 * THE AGENT RUNTIME CONTRACT — the complete primitive surface every harness
 * session sits behind, whatever the driver family
 * (docs/2026-08-07-agent-runtime-architecture.html §2, §3; POD-1761 W1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 *
 * Podium features may touch an agent session ONLY through this surface. That is
 * the whole point: it is built in FRONT of today's PTY stack rather than after
 * it, so that codex-terminal → codex-server is a driver swap no feature
 * notices. Everything the spec calls "deliberately not in the surface" — raw PTY
 * writes, hook ingest, transcript file paths, abduco socket names, screen/VT
 * state, harness settings files — is private to a driver and appears nowhere
 * below. The one exception is the frame stream, which appears only INSIDE an
 * {@link AttachEndpoint}.
 *
 * FIVE RULES govern what earns a place here (spec §3):
 *
 *   1. A primitive earns its place only if a Podium feature consumes it, AND
 *      every family can implement it or honestly decline it (`Declared<T>` —
 *      consumers branch and degrade; never a silent substitution).
 *   2. Guarantees are family-invariant; fidelity is declared. `send()` means the
 *      same thing on every driver — what varies is the declared mechanism and
 *      confidence, never the semantics.
 *   3. Every write returns a receipt or a typed refusal. Never fire-and-hope.
 *   4. Every read is causally enveloped — see {@link CausalEnvelope}.
 *   5. Machine-transparent: every primitive relays identically over the daemon
 *      WS for local, remote and cloud machines.
 *
 * TWO TIERS, so rule 1 has counter-pressure. The CORE contract is what a new
 * driver MUST implement or explicitly decline, and is all the conformance suite
 * pins. The EXTENDED tier is feature seams that never block a driver: a driver
 * shipping only the core is COMPLETE. New primitives default to extended and
 * must argue their way into core. The tier is recorded as data, not prose — see
 * `RUNTIME_PRIMITIVE_TIER` in ./tiers.ts, which is total over the primitive
 * names below, so adding a primitive without tiering it is a compile error.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not a wire schema. The zod projection lives in ./schemas.ts (and, for
 * the daemon↔server frames, in `@podium/protocol`'s `runtime` message family).
 * Types here may name functions and async iterables; the wire may not.
 */

import type { AgentStateEvent, Declared } from '@podium/harness'
import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type {
  ObservationInputOrigin,
  ObservationProvenance,
  ProviderCursor,
} from '@podium/protocol'

// ---------------------------------------------------------------------------
// Families and driver identity (spec §2)
// ---------------------------------------------------------------------------

/**
 * The three ways a harness can be driven. A harness may implement several; a
 * selection policy (auth mode, platform, availability, user preference) picks
 * one per session at spawn — see the `runtime` axis on `AgentManifest`.
 *
 * `terminal` IS A PERMANENT TIER, NOT A DEPRECATION PATH (spec §2 decision). It
 * is the only subscription-preserving way to run Claude Code and the only way to
 * run harnesses that never grow a protocol. What changes is its RANK: it stops
 * being the definition of a session and becomes one driver behind this contract.
 */
export type DriverFamily = 'server' | 'embedded' | 'terminal'

/**
 * The drivers this build knows how to name. CLOSED on purpose: a driver lands as
 * code in this package, so a new id is an edit somebody makes here deliberately
 * rather than a string that appears in a config file and typos silently.
 */
export const DRIVER_IDS = [
  /** `codex app-server` over JSON-RPC on a per-session unix socket (W6). */
  'codex-app-server',
  /** `opencode serve` over HTTP + SSE on a secret-guarded loopback port (W5). */
  'opencode-server',
  /** The Claude Agent SDK loop, hosted in a runtime-owned worker child. */
  'claude-sdk',
  /** Today's interactive Claude CLI under abduco, wrapped (W3). */
  'claude-pty',
  /** The same terminal mechanism for harnesses with no protocol (grok, cursor). */
  'generic-pty',
  /** The in-memory reference driver the conformance corpus runs against. */
  'fake',
] as const
export type DriverId = (typeof DRIVER_IDS)[number]

// ---------------------------------------------------------------------------
// The causal envelope (spec §3 rule 4)
// ---------------------------------------------------------------------------

/**
 * Every read is causally enveloped, per `reattachment-design.md`'s already-
 * approved contract: bootstrap snapshot + cursor-fenced live deltas, provenance
 * tagged.
 *
 * THE FIELDS ARE REUSED, NOT REDECLARED. `ProviderCursor`, `ObservationProvenance`
 * and `ObservationInputOrigin` come from `@podium/protocol`'s `runtime-state`
 * family, which is where the causal observation protocol already lives. A second
 * cursor vocabulary in a new package is precisely the drift rule 4 exists to
 * prevent — the spec's own note is that the contract "was written for the PTY
 * stack but is driver-agnostic", and only the CURSOR MATERIAL differs per family
 * (file inode+offset for terminal; thread id + event seq for Codex; session id +
 * event offset for opencode). That difference is already inside `ProviderCursor`.
 */
export interface CausalEnvelope {
  /** EVENT-time (ISO 8601) — when the agent acted, never when we observed it.
   *  Observe-time stamping is what makes a reattach restamp every session to
   *  "now", which the reattachment design calls out by name. */
  at: string
  provenance: ObservationProvenance
  cursor: ProviderCursor
  /** Bumped when the observer rebinds; a stale generation is rejected, never
   *  merged. */
  observerGeneration: number
  /** The turn this event belongs to. Fences are absorbing: once a turn epoch is
   *  closed it does not reopen. */
  turnEpoch: number
}

// ---------------------------------------------------------------------------
// Session specification (spec §3 `runtime.spawn`)
// ---------------------------------------------------------------------------

/** What a `select(ctx)` policy is allowed to decide on. Pure input: no clock, no
 *  filesystem, no network — the same function must answer identically on the
 *  server (planning a spawn) and on the machine (performing one). */
export interface SelectionContext {
  /** How this session will authenticate. The load-bearing axis: Claude on a
   *  subscription is `terminal` (the compliant path) and on an API key is
   *  `embedded`. */
  auth: 'subscription' | 'api-key' | 'bedrock' | 'vertex' | 'unknown'
  platform: NodeJS.Platform
  /** Driver ids this machine can actually run right now (binary present, version
   *  in the pinned range). A `select()` that returns an id absent here is a bug
   *  in the policy, not a runtime fallback. */
  available: readonly DriverId[]
  /** The operator's explicit choice, when they made one. Honoured over the
   *  policy's own preference — but still only if it is `available`. */
  preference?: DriverId
  /** What the session is FOR. Background executors auto-answer recovery prompts
   *  and never attach; a session a human opened does neither. */
  role?: 'interactive' | 'executor'
}

/** The hidden, attributed instruction channel: `--append-system-prompt`,
 *  `developer_instructions`, `--rules`. Declared because the transport differs
 *  and some harnesses have none.
 *
 *  RE-PRIMED AFTER COMPACTION — that is why it is part of the SPEC rather than a
 *  launch argument: the driver owns re-delivering it at the compaction boundary
 *  reported by `{ t: 'state' }` events. */
export interface InstructionChannel {
  /** Attributed machine-authored context, kept out of the visible user turn. */
  instructions: readonly string[]
  /** Re-deliver after a compaction event closes the previous context. */
  reprimeOnCompaction: boolean
}

/** Model policy for the session. Per-turn overrides live on {@link TurnInput}
 *  and apply to ONE turn; these are STICKY for the session (spec §3 config). */
export interface ModelPolicy {
  /** Absent (or 'auto') = the harness's own default. */
  model?: string
  effort?: string
  /** Native-subagent model override, where the harness reads one. */
  subagentModel?: Declared<string>
}

/** How Podium's MCP configuration reaches the harness. Declared because the
 *  transport genuinely differs (a config path vs inline JSON) and some harnesses
 *  accept neither. */
export type McpServers = Declared<
  { transport: 'path'; path: string } | { transport: 'inline'; config: string }
>

/**
 * Everything needed to start (or restart) one session, family-independent.
 *
 * PRINCIPAL-FREE. `account` selects WHICH harness-native login to spawn under —
 * it is a harness account ref, not an authorization principal, and it carries no
 * user id, visibility class or grant. Authorization lives at the server
 * projection boundary; this package is on the machine side of that line, which
 * `manifest-principal-free` enforces.
 */
export interface SessionSpec {
  harness: string
  /** Chooses the harness-native account at spawn; recorded on the binding.
   *  Absent = whichever account the harness itself defaults to. */
  account?: string
  selection: SelectionContext
  /** Working directory: a project or worktree path. */
  workdir: string
  model: ModelPolicy
  /** Interaction policy + permission preset for the session's role (spec §4). */
  roleProfile?: RoleProfile
  instructions: Declared<InstructionChannel>
  mcpServers: McpServers
  env?: Readonly<Record<string, string>>
  /** A first prompt delivered as part of the spawn where the harness accepts one. */
  initialPrompt?: string
}

/**
 * The per-session interaction policy's shape at the contract boundary. The
 * POLICY ENGINE is not here — W2 owns it, and the spec puts it server-side. What
 * the contract needs is the answer to "may this session stall on a startup
 * prompt", because a background executor that stalls there never starts.
 */
export interface RoleProfile {
  /** Auto-answers applied before anything escalates to a human. The spec's
   *  default for EVERY role profile: recovery → resume the FULL session;
   *  summary-resume is chosen only when the harness offers no full path. */
  autoAnswer: Partial<Record<InteractionKind, string>>
  /** How long an unanswered interaction waits before it escalates. NOT an
   *  auto-deny — the spec is explicit that `expiresAt` is an escalation
   *  deadline. */
  escalateAfterMs?: number
}

// ---------------------------------------------------------------------------
// Identity: binding, snapshot, archive — three artifacts, three consumer sets
// ---------------------------------------------------------------------------

/**
 * LIVE IDENTITY: who and where the process is. One of the identity triangle's
 * three corners, and the spec is explicit that implementers must not merge them:
 * `binding` = live identity, `snapshot()` = observation bootstrap, `export()` =
 * portable archive.
 */
export interface SessionBinding {
  sessionId: SessionId
  driver: DriverId
  family: DriverFamily
  harness: string
  workdir: string
  /** The harness's own resume ref, captured as EARLY as the harness allows.
   *  Null while the harness has not minted one yet — Codex's rollout files are
   *  lazy, which `DriverCapabilities.resumeRefTiming` declares. */
  resume: ResumeRef | null
  /** The harness account this session runs under, when one was selected. */
  account?: string
  /** Process/scope identity: what `adopt()` matches on after a supervisor
   *  restart. Its CONTENT is driver-private (an abduco socket name, a unix
   *  socket path, a worker pid) — the contract only requires that it round-trips
   *  and identifies EXACTLY one process tree. */
  process: ProcessIdentity
  /** Bumped every time the binding is re-established; the causal envelope's
   *  observer generation is fenced against it. */
  bindingVersion: number
}

export interface ProcessIdentity {
  /** Opaque, driver-private, EXACT. A prefix match here is how ghost sessions
   *  happen. */
  key: string
  /** The cgroup/systemd scope bounding this session's process tree, where the
   *  platform has one. Absent is honest on macOS. */
  scopeUnit?: string
  pid?: number
}

/**
 * OBSERVATION BOOTSTRAP: what the causal contract needs to resume WATCHING.
 * Exactly one snapshot opens an event stream; everything after it is a
 * cursor-fenced live delta.
 */
export interface SessionSnapshot {
  binding: SessionBinding
  state: AgentRuntimeState
  /** Where the transcript reading position sits, so the live tail joins without
   *  a gap and without a replay. */
  cursor: ProviderCursor
  observerGeneration: number
  turnEpoch: number
  /** Open asks at bootstrap. A session that is blocked is, by construction, a
   *  session with an entry here (spec §4). */
  interactions: readonly PendingInteraction[]
  /** The composer's contents, where the driver has a draft. */
  draft?: string
  at: string
}

/**
 * PORTABLE ARCHIVE: what ANOTHER MACHINE needs to resume the CONVERSATION.
 *
 * THE ARCHIVE GUARANTEE (spec §3): an archive is sufficient for
 * `runtime.import` → resume to continue the conversation on any machine with the
 * same harness. It is byte-faithful to the harness-native store (Claude project
 * JSONL, Codex rollouts, opencode sqlite) — deliberately DISTINCT from
 * {@link TranscriptItem}, which is lossy by design for display and search. The
 * two must not be conflated.
 */
export interface SessionArchive {
  harness: string
  /** Opaque-but-VERSIONED per harness: the importing side refuses a version it
   *  does not speak rather than guessing at the layout. */
  formatVersion: number
  resume: ResumeRef
  /** Harness-native files, relative to the archive root. */
  files: readonly ArchiveFile[]
  /** Binding metadata the importer needs to re-home the session (workdir shape,
   *  account, model policy) — never the process identity, which is per-machine. */
  binding: Omit<SessionBinding, 'process' | 'bindingVersion'>
}

export interface ArchiveFile {
  /** Archive-relative path. Never absolute: an absolute path is a promise about
   *  the DESTINATION machine that the source machine cannot make. */
  path: string
  bytes: Uint8Array
}

// ---------------------------------------------------------------------------
// Turns and control — the one write path (spec §3)
// ---------------------------------------------------------------------------

/** How a send should reach the agent. `steer` appends into an OPEN turn where
 *  the harness supports it (Codex `turn/steer`); embedded and terminal degrade
 *  to `queue` and the receipt REPORTS the downgrade. */
export type TurnDelivery = 'when-ready' | 'queue' | 'interrupt' | 'steer'

/** Who is writing. Chat, mail, steward, superagent and auto-continue all become
 *  callers of one verb with different origins — this replaces `typeText` /
 *  `queueText` / `sendTextWhenReady` / `interruptText`. */
export type InputOrigin = ObservationInputOrigin

export interface TurnInput {
  text: string
  /** Refs minted by `stageAttachment` — already landed on the session's machine
   *  in the form the harness accepts. */
  attachments?: readonly AttachmentRef[]
  /** Applies to THIS TURN ONLY. Session-sticky changes go through `configure()`;
   *  the split is a spec rule, not a convention. */
  overrides?: Declared<{ model?: string; effort?: string }>
}

export interface AttachmentRef {
  id: string
  /** Where it landed on the session's machine. */
  path: string
  mediaType?: string
}

export interface SendOptions {
  origin: InputOrigin
  delivery: TurnDelivery
}

/**
 * WHY A SEND CAN BE REFUSED. A refusal is SYNCHRONOUS and EXPECTED — a typed
 * reply to a verb, not an error. The caller handles it; nothing is "wrong".
 */
export type RefusalReason =
  /** An open interaction blocks the write until it is answered. */
  | 'needs_user'
  /** A human holds the control lease in take-over mode. Headless drivers queue
   *  rather than interleave — exactly what `queueText` does today. */
  | 'lease_held'
  /** `Declared<T>` says this driver does not implement the verb. */
  | 'unsupported'
  /** `hibernate()` without a resume ref: hibernating would lose the session. */
  | 'no_resume_ref'
  /** The session reached a terminal lifecycle phase. */
  | 'session_ended'
  /** No live process. `adopt()` or `resume()` first. */
  | 'not_running'
  /** A turn is open and the requested delivery cannot join it. */
  | 'busy'

export interface Refusal {
  reason: RefusalReason
  /** Harness-specific detail, preserved for diagnostics. Never parsed for
   *  control flow — that is what `reason` is for. */
  detail?: string
}

/**
 * THE FOUR OUTCOMES. `send` resolves to exactly one of these — the spec's
 * central honesty commitment.
 *
 * `unverified` IS THE TWO-GENERALS GAP MADE EXPLICIT instead of retried into a
 * lie. The keystrokes were delivered but acceptance could not be proven inside
 * the verification window. Callers decide what to do (retry, surface, wait for
 * the transcript echo) WITH THE TRUTH IN HAND. It is terminal-family only, and
 * the conformance suite's permitted-failures table is what says so.
 */
export type TurnReceipt =
  | {
      outcome: 'accepted'
      /** The turn that opened. Callers correlate subsequent events by it. */
      turnEpoch: number
      /** The delivery ACTUALLY used. Differs from the requested one when a
       *  driver degraded `steer` → `queue`; never a silent substitution. */
      deliveredAs: TurnDelivery
      /** What proved acceptance. For server/embedded this is the protocol ack;
       *  for terminal it is a causal hook where one exists (Claude's
       *  `UserPromptSubmit`) and submit-verification otherwise. */
      provenBy: SendProof
      at: string
    }
  | {
      outcome: 'queued'
      /** Durable position in the queue. */
      position: number
      deliveredAs: TurnDelivery
      at: string
    }
  | { outcome: 'refused'; refusal: Refusal }
  | {
      outcome: 'unverified'
      deliveredAs: TurnDelivery
      /** How long the driver waited for proof before saying so. */
      verificationWindowMs: number
      at: string
    }

/** What proved a send was accepted — the declared mechanism behind rule 2's
 *  family-invariant guarantee. */
export type SendProof =
  /** A protocol acknowledgement (Codex `turn/started`, opencode's message ack). */
  | 'protocol-ack'
  /** An SDK callback returned. */
  | 'sdk-callback'
  /** A causal hook fired — Claude's `UserPromptSubmit`, the same signal the
   *  reattachment design anchors turn epochs to. */
  | 'hook'
  /** The submitted text appeared in the transcript within the window. */
  | 'transcript-echo'

// ---------------------------------------------------------------------------
// Interactions (spec §3, §4)
// ---------------------------------------------------------------------------

export type InteractionKind =
  | 'permission'
  | 'question'
  | 'plan-approval'
  | 'elicitation'
  | 'login'
  /** Resume-time prompts — "session fell out of cache, resume from summary?",
   *  trust re-prompts. Asked while the handle is still STARTING, which is why
   *  the lifecycle phase cannot gate interactions. */
  | 'recovery'

/**
 * PROVENANCE ⇒ CONFIDENCE. This field is what makes fidelity visible instead of
 * assumed, and it carries a hard consumer obligation: consumers of
 * `screen-classifier` interactions must treat asked→answered as AT-LEAST-ONCE,
 * never exactly-once. A re-rendered menu can mint a duplicate ask, and a
 * keystroke answer cannot prove it acted on the exact menu it classified.
 */
export type InteractionSource = 'protocol' | 'sdk-callback' | 'hook' | 'screen-classifier'

/** Whether answering is structured (a protocol reply) or emulated (menu
 *  keystrokes). The second cannot prove what it acted on — see
 *  {@link InteractionSource}. */
export type InteractionAnswerability = 'structured' | 'keystroke-emulated'

/**
 * The per-kind ask payload — tool and input for `permission`, options for
 * `question`, the plan text for `plan-approval`, the url for `login`.
 *
 * TYPED IN W2, NOT HERE. The spec names the per-kind payload and answer schemas
 * as a phase-1 deliverable and says in as many words that they are "the hard
 * part of this aggregate", specified in phase 1 rather than in the architecture
 * doc: W2 normalizes Codex approval requests, opencode's once/always/reject, the
 * SDK's `canUseTool`/AskUserQuestion and classified terminal menus into one
 * vocabulary and replaces this alias with a discriminated union keyed on `kind`.
 *
 * Deliberately OPAQUE rather than absent: the interaction's own shape (id, kind,
 * source, answerability, lifecycle) is stable and testable now, and pinning a
 * payload union here would fix the vocabulary before the normalization work that
 * decides it. It is a JSON OBJECT rather than `unknown` because every payload
 * the spec names is one, and because `unknown` on the wire makes the key
 * optional — which would say a payload-less ask is legal when none is.
 */
export type InteractionPayload = Readonly<Record<string, unknown>>

export interface PendingInteraction {
  id: string
  sessionId: SessionId
  kind: InteractionKind
  payload: InteractionPayload
  askedAt: string
  source: InteractionSource
  answerable: InteractionAnswerability
  /** Set once a policy has ruled. `escalated` means it is waiting on a human. */
  policyVerdict?: 'auto-allowed' | 'auto-denied' | 'escalated'
  /** ESCALATION DEADLINE, NOT AUTO-DENY. The spec is explicit: passing this
   *  raises the ask's visibility; it never answers it. */
  expiresAt?: string
}

/** Answering is idempotent; a second answer returns a typed error rather than
 *  double-acting. */
export type InteractionAnswerOutcome =
  | { ok: true }
  | { ok: false; reason: 'already-answered' | 'expired' | 'unknown-interaction' }

export interface InteractionAsked {
  ev: 'asked'
  interaction: PendingInteraction
}
export interface InteractionAnswered {
  ev: 'answered'
  id: string
  /** Who resolved it: a policy, the superagent, or a human on some surface. */
  answeredBy: 'policy' | 'superagent' | 'human'
  at: string
}
export interface InteractionExpired {
  ev: 'expired'
  id: string
  at: string
}

// ---------------------------------------------------------------------------
// Failure semantics (spec §3)
// ---------------------------------------------------------------------------

/**
 * Errors are not a primitive — they are a normalized vocabulary threading
 * through the three channels the surface already has: a {@link Refusal}
 * (synchronous), a {@link TurnFailed} (in the causal stream), or a
 * {@link ProcessEvent}.
 *
 * TRANSPORT FAILURES ARE DELIBERATELY OUTSIDE SESSION SEMANTICS. A machine being
 * unreachable or a driver crashing is not a session failure: the session may be
 * alive and adoptable even while the path to it is down. Conflating the two is
 * how ghost sessions happen, so there is no arm for it here.
 */
export type TurnFailureReason =
  | 'rate-limit'
  | 'auth-expired'
  | 'context-overflow'
  | 'provider-error'
  | 'timeout'
  | 'interrupted'

/**
 * ONE ROUTING RULE KEEPS SESSIONS UNSTUCK: every failure is classified, and
 * `needs-human` failures MATERIALIZE AS PendingInteractions — auth-expired
 * becomes a `login` interaction, context-overflow becomes a `recovery` one.
 * That is the mechanism by which a blocked session is always an enumerable one.
 */
export type FailureDisposition = 'retryable' | 'needs-human' | 'fatal'

export interface TurnFailed {
  ev: 'failed'
  turnEpoch: number
  reason: TurnFailureReason
  disposition: FailureDisposition
  /** Harness-specific detail preserved verbatim for diagnostics, generalizing
   *  today's superagent harness-error mapping to every consumer. */
  detail?: string
}

export interface TurnStarted {
  ev: 'started'
  turnEpoch: number
  origin: InputOrigin
}

export interface TurnCompleted {
  ev: 'completed'
  turnEpoch: number
  verdict: 'done' | 'question' | 'approval' | 'open_todos' | 'interrupted'
}

export type TurnEvent = TurnStarted | TurnCompleted | TurnFailed

/** Process failure is its own channel: a session's process tree dying is not a
 *  turn outcome. `adopted` is here rather than in lifecycle because a consumer
 *  watching the stream needs to know the binding changed under it. */
export type ProcessEvent =
  | { ev: 'exited'; code: number | null; signal: string | null; classification: ExitClassification }
  | { ev: 'oomKilled'; scopeUnit?: string }
  | { ev: 'adopted'; bindingVersion: number }

export type ExitClassification = 'clean' | 'crashed' | 'killed' | 'oom'

// ---------------------------------------------------------------------------
// Observation (spec §3)
// ---------------------------------------------------------------------------

/**
 * ONE EVENT STREAM PER SESSION. Every arm is causally enveloped, so a consumer
 * can order, fence and deduplicate without knowing which family produced it.
 */
export type RuntimeEvent = CausalEnvelope & RuntimeEventBody

/**
 * The event's own payload, WITHOUT the envelope.
 *
 * Split out rather than derived with `Omit<RuntimeEvent, keyof CausalEnvelope>`
 * because `Omit` over a union is not distributive: it collapses to the keys the
 * arms share, which for a discriminated union is just the discriminant. A driver
 * building an event before stamping it needs this exact type, so it is named
 * here instead of re-derived (incorrectly) at each producer.
 */
export type RuntimeEventBody =
  | {
      /** The existing normalized state vocabulary, INCLUDING compaction — which
       *  is the re-prime boundary for `SessionSpec.instructions`. */
      t: 'state'
      change: AgentStateEvent
    }
  | { t: 'item'; item: TranscriptItemDelta }
  | { t: 'interaction'; ev: InteractionAsked | InteractionAnswered | InteractionExpired }
  | { t: 'turn'; ev: TurnEvent }
  | { t: 'process'; ev: ProcessEvent }
  /** `cd`/EnterWorktree moves, commits and touched files. */
  | { t: 'workspace'; ev: CwdChanged | GitActivity }
  /** Forwarded browser opens, classified by the harness manifest. */
  | { t: 'open-url'; ev: { url: string; intent: 'login' | 'link' } }

export interface CwdChanged {
  ev: 'cwd-changed'
  cwd: string
}

export interface GitActivity {
  ev: 'git-activity'
  /** Commits observed since the last such event. */
  commits: readonly string[]
  touchedFiles: readonly string[]
}

/**
 * A transcript item, or a fragment of one. COMPLETED items arrive at the coarse
 * watch level; token-level `delta` fragments only while a viewer holds a fine
 * watch — which is what keeps the durable path cheap.
 */
export type TranscriptItemDelta =
  | { kind: 'complete'; item: TranscriptItem }
  | { kind: 'delta'; itemId: string; textDelta: string }

/**
 * Two watch levels, refcounted (spec §5). `coarse` is durable-synced and always
 * on; `fine` is live-only token deltas while a viewer is actually watching. A
 * driver that cannot produce token deltas declares `fine` unsupported and the
 * chat degrades to complete items — it does not fabricate a stream.
 */
export type WatchLevel = 'coarse' | 'fine'

/** Where to resume an event stream. `'bootstrap'` asks for the snapshot plus
 *  everything after it. */
export type EventStreamStart = ProviderCursor | 'bootstrap'

// ---------------------------------------------------------------------------
// Attach and lease (spec §5)
// ---------------------------------------------------------------------------

/**
 * An interactive surface, produced on demand.
 *
 * NOT ATTACH: chat, status signals, mail and the steward. Those are `events()`
 * and `send()` on the handle. Attach is only for a real terminal.
 *
 * The two reserved variants below are DEFERRED, not forgotten — they are written
 * as types so that adding them later is an implementation, not a redesign of the
 * union. `handover` in particular is deliberately out of this epic.
 */
export type AttachEndpoint =
  /** Terminal family: today's frames path — the engine terminal IS the session. */
  | { kind: 'engine'; stream: TerminalStreamRef }
  /** Server family: a harness TUI client (`codex --remote`, `opencode attach`)
   *  under abduco in a scope SIBLING to the session's, streamed and warm-parked
   *  so its memory never counts against the agent's budget. */
  | {
      kind: 'client'
      placement: 'on-machine'
      stream: TerminalStreamRef
      warm: { ttlMs: number }
    }

/** RESERVED, DEFERRED (spec §5): a client terminal running on the USER's machine
 *  rather than the session's. Named so the union's growth is planned. */
export interface ReservedUserLocalAttach {
  kind: 'client'
  placement: 'user-local'
  connect: { url: string; token: string }
}

/** RESERVED, DEFERRED (spec §5): hand the session's own argv to a local terminal
 *  under a lease. Explicitly out of scope for POD-1761. */
export interface ReservedHandoverAttach {
  kind: 'handover'
  lease: SessionLease
  argv: readonly string[]
}

/** An opaque handle to the frame stream. The FRAMES THEMSELVES appear nowhere
 *  else in this surface — that containment is the point. */
export interface TerminalStreamRef {
  id: string
}

export interface AttachRequest {
  /** `takeover` claims the control lease; `peek` is an unlimited spectator. */
  mode: 'takeover' | 'peek'
  holder: string
}

/**
 * ONE CONTROL LEASE PER SESSION. Exactly one driver-controller (the runtime) or
 * one human-controller (an attach in take-over mode) holds it; spectators are
 * unlimited. This is what makes "the user attached and started typing" and "the
 * steward tried to nudge" impossible to interleave, and it generalizes
 * `exclusiveInteractiveResume` from a Claude quirk into the concurrency model.
 */
export interface SessionLease {
  holder: string
  kind: 'driver-controller' | 'human-controller'
  acquiredAt: string
  expiresAt?: string
}

// ---------------------------------------------------------------------------
// Config, accounting, health (spec §3 — mostly EXTENDED tier)
// ---------------------------------------------------------------------------

/** STICKY for the session. Per-turn overrides ride {@link TurnInput} instead —
 *  the split is a spec rule because conflating them is how a "just this once"
 *  model change silently becomes permanent. */
export interface ConfigureRequest {
  model?: string
  permissionMode?: string
  effort?: string
}

export interface UsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Percentage of the context window consumed, where the harness reports it. */
  contextUsedPercent?: number
}

export interface SessionHealth {
  alive: boolean
  memoryBytes?: number
  scopeUnit?: string
  oomEvents: number
}

// ---------------------------------------------------------------------------
// Capabilities (spec §3 — `Declared<T>` per axis)
// ---------------------------------------------------------------------------

/** What a driver's `send` can actually do. `mayReturnUnverified` is the field
 *  the conformance suite reads to decide whether an unverified receipt is a
 *  permitted outcome or a bug. */
export interface SendCapability {
  /** Deliveries implemented NATIVELY. One not listed here is degraded, and the
   *  receipt's `deliveredAs` must report the degradation. */
  native: readonly TurnDelivery[]
  /** How acceptance is proven, in preference order. */
  proof: readonly SendProof[]
  /** TERMINAL FAMILY ONLY. A server or embedded driver declaring `true` here is
   *  claiming a weakness it does not have — the suite refuses it. */
  mayReturnUnverified: boolean
  verificationWindowMs?: number
}

export interface InterruptCapability {
  /** `interrupt()` REQUESTS a fence. A driver that cannot obtain provider
   *  confirmation must declare this false rather than manufacture one — fences
   *  are absorbing and state is never fabricated. */
  fenceOnProviderConfirmation: boolean
}

export interface InteractionCapability {
  kinds: readonly InteractionKind[]
  source: InteractionSource
  answerable: InteractionAnswerability
  /** `true` for classifier-sourced interactions: asked→answered may duplicate,
   *  and identity is best-effort. Consumers MUST branch on this. */
  atLeastOnce: boolean
}

export interface ObservationCapability {
  watchLevels: readonly WatchLevel[]
  /** What the cursor is made of, for diagnostics: 'file-offset' (terminal),
   *  'event-seq' (Codex thread), 'event-offset' (opencode session). */
  cursorMaterial: string
}

export interface AttachCapability {
  /** Which endpoint variants this driver can produce. Embedded declares attach
   *  UNSUPPORTED outright — there is no terminal, and chat is the answer. */
  kinds: readonly AttachEndpoint['kind'][]
}

/**
 * WHEN the resume ref becomes available. The spec requires it be captured as
 * early as the harness allows AND that the capability declare when that is —
 * Codex's rollout files are written lazily, so `first-turn` is the honest answer
 * there and `hibernate()` legitimately refuses before it.
 */
export type ResumeRefTiming = 'spawn' | 'first-turn' | 'never'

/**
 * ONE `Declared<T>` PER AXIS, same philosophy as `AgentManifest`. A driver
 * shipping only the CORE axes is complete; the extended ones never block it.
 * Totality is what makes this useful: a new axis must be declared by every
 * driver, so a gap is a compile error rather than an undefined field.
 */
export interface DriverCapabilities {
  // ---- CORE ----
  send: SendCapability
  interrupt: InterruptCapability
  interactions: Declared<InteractionCapability>
  observation: ObservationCapability
  transcript: Declared<{ history: boolean }>
  attach: Declared<AttachCapability>
  lease: Declared<{ humanTakeover: boolean }>
  snapshot: Declared<{ includesDraft: boolean }>
  archive: Declared<{ formatVersion: number; byteFaithful: boolean }>
  resumeRefTiming: ResumeRefTiming
  /** Dedicated process per session is v1's guarantee. A POOLED driver visibly
   *  lacks per-session OOM/crash isolation, so it declares it here rather than
   *  becoming a new mode in the taxonomy (spec §6). */
  placement: 'dedicated' | 'pooled'

  // ---- EXTENDED ----
  draft: Declared<{ read: boolean; write: boolean }>
  configure: Declared<{ fields: readonly (keyof ConfigureRequest)[] }>
  usage: Declared<{ perTurn: boolean }>
  openUrl: Declared<{ intents: readonly ('login' | 'link')[] }>
  title: Declared<{ source: 'osc' | 'transcript' | 'synthetic' }>
  accentColor: Declared<true>
}

// ---------------------------------------------------------------------------
// The session handle
// ---------------------------------------------------------------------------

/**
 * ONE LIVE SESSION, whatever drives it.
 *
 * Every verb here is either a WRITE that returns a receipt or a typed refusal
 * (rule 3), or a READ that is causally enveloped (rule 4). Nothing on this
 * interface exposes a mechanism: there is no `pty`, no `socket`, no `hooks`.
 */
export interface AgentSessionHandle {
  readonly binding: SessionBinding

  // ---- Lifecycle (CORE) ----
  /** Graceful shutdown; the survival table is unchanged from today. */
  stop(): Promise<void>
  /** REFUSES without a resume ref — hibernating a session we cannot bring back
   *  is data loss wearing a lifecycle verb's name. */
  hibernate(): Promise<Refusal | { ok: true }>
  kill(): Promise<void>
  health(): Promise<SessionHealth>

  // ---- Identity (CORE) ----
  snapshot(): Promise<SessionSnapshot>
  export(): Promise<SessionArchive>

  // ---- Turns and control (CORE) ----
  send(input: TurnInput, options: SendOptions): Promise<TurnReceipt>
  stageAttachment(source: { bytes: Uint8Array; filename: string }): Promise<AttachmentRef>
  /** REQUESTS a fence. The fence is emitted only on provider confirmation and is
   *  never manufactured — so this returns nothing to await. Watch the stream. */
  interrupt(): Promise<void>
  answer(interactionId: string, answer: unknown): Promise<InteractionAnswerOutcome>

  // ---- Interactions (CORE) ----
  interactions(): Promise<readonly PendingInteraction[]>

  // ---- Observation (CORE) ----
  events(after: EventStreamStart): AsyncIterable<RuntimeEvent>
  /** Refcounted: the level is the MAX of what current watchers asked for.
   *  Returns a release function so a viewer disconnecting cannot leak a fine
   *  watch — an always-on token stream with nobody reading it is the exact cost
   *  the two levels exist to avoid. */
  watch(level: WatchLevel): Promise<() => void>
  /** Poll-free projection. `lastActivityAt` is EVENT-time, never observe-time. */
  state(): Promise<AgentRuntimeState>

  // ---- Transcript (CORE) ----
  readonly transcript: {
    history(range: { from?: ProviderCursor; limit: number }): Promise<readonly TranscriptItem[]>
  }

  // ---- Attach and lease (CORE) ----
  attach(req: AttachRequest): Promise<AttachEndpoint | Refusal>
  readonly lease: {
    acquire(holder: string, kind: SessionLease['kind']): Promise<SessionLease | Refusal>
    release(holder: string): Promise<void>
    state(): Promise<SessionLease | null>
  }

  // ---- EXTENDED ----
  readonly draft: {
    get(): Promise<string | Refusal>
    set(text: string): Promise<Refusal | { ok: true }>
  }
  configure(request: ConfigureRequest): Promise<Refusal | { ok: true }>
  usage(): Promise<UsageSnapshot | Refusal>
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * ONE OBJECT PER (harness × mechanism). The three constructors are the only ways
 * a handle comes into existence, and `adopt()` is FIRST-CLASS among them: the
 * supervisor restarting must find surviving session processes, rebind by exact
 * identity, emit one bootstrap snapshot and continue. That makes reattach the
 * same verb for every family instead of a PTY special case.
 */
export interface RuntimeDriver {
  readonly id: DriverId
  readonly harness: string
  readonly family: DriverFamily
  capabilities(): DriverCapabilities
  create(spec: SessionSpec): Promise<AgentSessionHandle>
  resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle>
  /** Rebind a SURVIVING process tree after a supervisor restart. Must match on
   *  exact process identity — a prefix or heuristic match here adopts the wrong
   *  process, which is worse than not adopting at all. */
  adopt(binding: SessionBinding): Promise<AgentSessionHandle>
  /** A driver MAY override a procedure when the harness has a native or atomic
   *  form. Absent = the generic composition in ./procedures.ts is used. */
  readonly procedures?: Partial<DriverProcedureOverrides>
}

/**
 * THE PROCEDURES LAYER — pure composition above drivers, below features.
 *
 * The rule for where an operation lives: PRIMITIVE if it needs driver-private
 * access or varies per harness in SEMANTICS; PROCEDURE if it is pure composition
 * whose variance is only mechanism or timing. Generic by default, declared
 * override when a harness needs one — the same house pattern as the manifests,
 * so peculiarities stay inside the driver that owns them.
 *
 * Note what is NOT here: interrupt-and-send. It is so common it folded into the
 * surface as `send({ delivery: 'interrupt' })` instead, implemented natively per
 * driver.
 */
export interface DriverProcedureOverrides {
  /** send + await the matching turn-completed. */
  askAndAwait(handle: AgentSessionHandle, input: TurnInput): Promise<TurnEvent>
  /** ephemeral create → send → await → kill. Drivers with a native one-shot form
   *  (`claude -p`, `codex exec --ephemeral`) override this rather than paying for
   *  a full session. */
  oneShot(spec: SessionSpec, prompt: string): Promise<readonly TranscriptItem[]>
}
