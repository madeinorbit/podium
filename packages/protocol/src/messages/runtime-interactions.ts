/**
 * THE INTERACTION CONTRACT — the browser-facing half of the Agent Runtime wire.
 *
 * Split out of `./runtime.ts` (POD-2470). The common barrel re-exports THIS
 * file; the daemon-plane half — turn receipts, runtime events and the twelve
 * request/result envelopes — is reachable only through `@podium/protocol/daemon`,
 * which is the rule `./index.ts` and `../daemon.ts` both already state and which
 * W1 broke by filing the whole contract in one module.
 *
 * The split is NOT cosmetic and not about tidiness. `./sync.ts` parses
 * {@link PendingInteractionWire} as a real schema — it is the payload of the
 * `pendingInteraction` metadata feed kind — so importing it dragged every
 * sibling Zod schema in this contract into the eager browser graph, including
 * ~19 kB of daemon-plane envelopes no browser can ever receive. Eager Zod
 * schemas are constructed at module scope, so a bundler cannot shake them out;
 * only the import edge decides, which is why the boundary is a file boundary.
 *
 * WHAT BELONGS HERE: the ask/answer vocabulary a client renders and answers.
 * WHAT DOES NOT: anything a browser never parses. If you are adding a schema
 * the server and daemon exchange, it goes in `./runtime.ts`.
 */

import { SessionIdField } from '@podium/model'
import { z } from 'zod'

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

// ---------------------------------------------------------------------------
// The per-kind ask and answer vocabulary (POD-2020 / W2)
// ---------------------------------------------------------------------------
//
// THE SPEC NAMES THIS AS THE HARD PART, AND SAYS WHY. §4's closing paragraph:
// "the per-kind payload and answer schemas — normalizing Codex approval
// requests, opencode's once/always/reject, the SDK's canUseTool/AskUserQuestion
// shapes, and classified terminal menus into one typed vocabulary — are the hard
// part of this aggregate and are specified in phase 1, not in this doc."
//
// THE NORMALIZATION RULE used throughout: a field earns its place only if it
// changes what a person or a policy would DECIDE, or what answering has to send.
// Everything else is harness trivia, and carrying it would make this union the
// intersection of five vendors' shapes instead of the vocabulary they all
// project onto. Two consequences worth stating, because both look like
// omissions:
//
//  - No raw provider payload rides along. A `tool_input` is unbounded and
//    routinely holds whole file contents (see `AgentPermissionAsk` in
//    @podium/model, which made the same call for the same reason); the ask
//    carries a derived, bounded summary of the ONE field that identifies the
//    act, and the transcript keeps the rest.
//  - No provider request id. The aggregate's `id` is Podium's, and the mapping
//    back to a provider handle is the DRIVER's private business — a server
//    driver replies over its own protocol, a terminal driver types digits. A
//    provider id in the shared vocabulary would be a field only one family can
//    fill and every consumer would learn to branch on.
//
// ANSWERS ARE SEPARATE FROM ASKS AND KEYED THE SAME WAY. `InteractionAnswer`
// mirrors `PendingInteraction`'s discriminant, so a handler that narrowed the
// ask has already narrowed the answer, and an answer for the wrong kind is a
// parse failure rather than a runtime surprise.

/**
 * EVERY ASK PAYLOAD CARRIES ITS OWN VERSION, and the reason is specific to this
 * union rather than general good practice.
 *
 * These six payloads are the one place in the system where five vendors' shapes
 * are normalized into one vocabulary, and four of the six have NO producer yet
 * (elicitation, login, recovery today; plan-approval from one source only). They
 * will change shape as W5's opencode driver and W6's codex driver land real
 * asks — and unlike the transport envelope, which `WIRE_VERSION` covers, a
 * payload change is invisible at the frame level. A consumer holding a durable
 * row written months earlier needs to know which vocabulary it is reading.
 *
 * It is a `z.literal(1)` and not a number: a producer cannot forget to set it,
 * and a bump is a deliberate edit at every construction site rather than a
 * value that quietly drifts.
 */
const ASK_VERSION = { v: z.literal(1) } as const

/**
 * `permission` — a tool call awaiting consent.
 *
 * Sources: Claude's `PermissionRequest` hook and its `permission_prompt`
 * Notification; the SDK's `canUseTool`; Codex's server→client approval request;
 * opencode's `permission.updated`.
 *
 * `canAlwaysAllow` records only WHETHER the harness offered a "don't ask again"
 * row, never which one — the native menu's always-allow rows are conditional and
 * ordered per tool, so their key position cannot be predicted. The flag exists
 * so a surface can say the option is there; a `keystroke-emulated` answerer must
 * not try to press it. (`docs/agents/evidence/pod-707-permission-menu.md`.)
 */
export const PermissionAsk = z.object({
  ...ASK_VERSION,
  /** The tool being consented to, in the harness's own naming (`Bash`, `Edit`). */
  toolName: z.string().min(1),
  /** THE ONE FIELD THAT SAYS WHAT IT WOULD DO — the command, the path, the URL —
   *  derived and truncated, never the whole input. Absent when the source
   *  carried no input the harness could identify (Claude's Notification channel
   *  carries a rendered message and no tool call). */
  inputSummary: z.string().optional(),
  /** Did the harness offer an always-allow alongside this ask? */
  canAlwaysAllow: z.boolean(),
  /**
   * RESERVED, AND NOTHING FILLS IT IN W2.
   *
   * Claude's `permission_suggestions` is a discriminated union of RULE
   * MUTATIONS — addRules / replaceRules / setMode / addDirectories — not
   * user-facing labels, and `translateClaudeHookPayload` reduces it to the
   * `canAlwaysAllow` boolean before anything reaches the server. So there is no
   * source for this field today; it is declared so that a driver which does
   * carry the mutations (W5's opencode `permission.updated`, W6's codex) has a
   * place to put them that later consumers can already name.
   *
   * Deliberately `unknown[]` rather than a guessed union: inventing the shape
   * from one harness's bundle, with no consumer, is exactly the vocabulary-
   * before-normalization mistake W1 avoided by leaving `payload` opaque.
   */
  suggestions: z.array(z.unknown()).readonly().optional(),
})
export type PermissionAsk = z.infer<typeof PermissionAsk>

export const PermissionAnswer = z.object({
  kind: z.literal('permission'),
  /** `allow-always` is REFUSED, not downgraded, when `canAlwaysAllow` is false or
   *  the ask is `keystroke-emulated`: silently answering `allow-once` instead
   *  would report a persistent grant that was never made. */
  decision: z.enum(['allow-once', 'allow-always', 'deny']),
  /** Why, for a denial the agent should learn from. Delivered as text where the
   *  channel carries it and dropped where it cannot — never blocks the decision. */
  feedback: z.string().optional(),
})
export type PermissionAnswer = z.infer<typeof PermissionAnswer>

/** One option on one question. `preview` is what makes the menu draw the
 *  side-by-side dialog, which changes what a digit DOES (POD-770) — hence
 *  {@link QuestionPrompt.previewLayout} rather than a per-option inference at
 *  every answering site. */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const QuestionPrompt = z.object({
  question: z.string(),
  /** The short column heading the native dialog draws above the options.
   *  Present on `AskQuestion` in `client-core/src/viewmodels/ask-question.ts`,
   *  which is this shape's reference — the two describe one menu, so a field
   *  there and not here would be a field the server silently drops. */
  header: z.string().optional(),
  /** Digits TOGGLE on a multi-select menu rather than selecting, so answering
   *  one needs a confirming key the single-select path must not send (POD-609). */
  multiSelect: z.boolean(),
  /** 1-BASED (= option count + 1), matching `optionIndices`. The index of the
   *  synthetic "Other" row when the menu offers free text; absent when it does
   *  not. An answer that names it must carry {@link QuestionSelection.text}.
   *
   *  MEANINGLESS UNDER `previewLayout` — that dialog has no Other row at all,
   *  which is the trap POD-770 documents: the Other script there silently
   *  answers option 1 and throws the typed text away. */
  otherIndex: z.number().int().positive().optional(),
  /**
   * The dialog draws SIDE-BY-SIDE, and this is the more dangerous of the two
   * shape facts (POD-770).
   *
   * In that layout a digit only MOVES the cursor, a digit past the last option
   * is dropped, and the closing carriage return commits whatever is highlighted.
   * There is no Other row; the free-text escape is a "Notes" field reached with
   * `n`. A caller that answers such a question with free text has not answered
   * it — it has selected option 1. Consumers must refuse instead.
   *
   * Computed as the CLI's own predicate — `!multiSelect && options.some(o =>
   * o.preview)` — which is `isPreviewLayout` in
   * `client-core/src/viewmodels/ask-question.ts`. Carried on the row rather than
   * recomputed per surface so a client that never sees the options still knows
   * the ask cannot take free text.
   */
  previewLayout: z.boolean(),
  options: z.array(QuestionOption).readonly(),
})
export type QuestionPrompt = z.infer<typeof QuestionPrompt>

/**
 * `question` — a structured choice, one or more prompts at once.
 *
 * Sources: Claude's `AskUserQuestion` tool call (whose `questions[]` is this
 * shape almost verbatim, which is why the shape is plural); opencode/codex
 * question events; a classified terminal menu.
 */
export const QuestionAsk = z.object({
  ...ASK_VERSION,
  questions: z.array(QuestionPrompt).readonly(),
})
export type QuestionAsk = z.infer<typeof QuestionAsk>

/** The answer to ONE prompt. Indices are 1-BASED because that is what the native
 *  menu shows and what the digit path types — a 0-based vocabulary here would put
 *  an off-by-one between every surface and the keystroke it produces. */
export const QuestionSelection = z.object({
  optionIndices: z.array(z.number().int().positive()).readonly(),
  /** Free text for the "Other" row. Present only alongside an `otherIndex`
   *  selection; a channel that cannot type free text refuses rather than
   *  dropping it. */
  text: z.string().optional(),
})
export type QuestionSelection = z.infer<typeof QuestionSelection>

export const QuestionAnswer = z.object({
  kind: z.literal('question'),
  /** ONE ENTRY PER PROMPT, in `questions` order. A menu holds every prompt open
   *  at once and answering it is a single act, so a partial answer is not a
   *  thing the wire should be able to express. */
  selections: z.array(QuestionSelection).readonly(),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

/**
 * `plan-approval` — the agent has written a plan and stopped for a verdict.
 *
 * Source today: a Claude session going idle in plan mode (`IdleVerdict.kind ===
 * 'approval'`). Codex and opencode both surface the same moment as an approval
 * request over their protocol.
 */
export const PlanApprovalAsk = z.object({
  ...ASK_VERSION,
  /** The plan as written. Unbounded by nature — a plan IS its text, so there is
   *  no summary that preserves the thing being approved. */
  plan: z.string(),
  /** Did the harness offer "approve, and stop asking about edits"? Claude's plan
   *  menu does; a bare approval channel does not. */
  autoAcceptOffered: z.boolean(),
})
export type PlanApprovalAsk = z.infer<typeof PlanApprovalAsk>

export const PlanApprovalAnswer = z.object({
  kind: z.literal('plan-approval'),
  decision: z.enum(['approve', 'reject']),
  /** NORMALIZED OUT OF THE DECISION, not folded into it. Claude's menu spells
   *  three rows (auto-accept edits / manually approve / keep planning); two of
   *  them are the same verdict with a different follow-on permission posture,
   *  and a three-value enum would make every non-Claude driver carry a variant
   *  it cannot produce. Ignored on `reject`. */
  autoAcceptEdits: z.boolean().optional(),
  /** What to change, for a rejection. This is the answer that keeps the session
   *  moving, so unlike the permission case it is the point of the verb. */
  feedback: z.string().optional(),
})
export type PlanApprovalAnswer = z.infer<typeof PlanApprovalAnswer>

/**
 * `elicitation` — an MCP server asking the USER for structured input mid-tool-call.
 *
 * NO PRODUCER TODAY, and that is recorded rather than hidden: elicitation
 * arrives with a driver that carries MCP through to the runtime (W5/W6). The
 * shape is MCP's own `elicitation/create` — message, a JSON Schema for the
 * requested fields, and the three-valued result — because normalizing a protocol
 * that already has one shape would only add a translation nobody needs.
 */
export const ElicitationAsk = z.object({
  ...ASK_VERSION,
  message: z.string(),
  /** The MCP `requestedSchema` verbatim: a JSON Schema object describing the
   *  fields. Opaque HERE by nature — it is a schema, not a value — and rendered
   *  by whichever surface draws the form. */
  requestedSchema: z.record(z.string(), z.unknown()),
  /** Which MCP server is asking, when the driver knows. */
  serverName: z.string().optional(),
})
export type ElicitationAsk = z.infer<typeof ElicitationAsk>

export const ElicitationAnswer = z.object({
  kind: z.literal('elicitation'),
  /** MCP's three outcomes, kept distinct: `decline` is "I won't answer this",
   *  `cancel` is "I'm dismissing the whole thing". Servers act differently on
   *  them and collapsing them would decide for every server at once. */
  action: z.enum(['accept', 'decline', 'cancel']),
  /** The filled form. Required in spirit on `accept` and validated against
   *  `requestedSchema` by the driver that speaks MCP, not here — this layer has
   *  the schema as data, not as a validator. */
  content: z.record(z.string(), z.unknown()).optional(),
})
export type ElicitationAnswer = z.infer<typeof ElicitationAnswer>

/**
 * `login` — the session cannot proceed until an account is re-authenticated.
 *
 * This is the materialization half of the routing rule in
 * {@link FailureDisposition}: an `auth-expired` turn failure becomes a `login`
 * interaction, so an agent blocked on credentials is an ENUMERABLE blocked
 * agent rather than a session that silently stopped.
 */
export const LoginAsk = z.object({
  ...ASK_VERSION,
  /** The provider whose credential is wanted, in the harness's naming
   *  ('anthropic', 'openai', …). */
  provider: z.string().min(1),
  reason: z.enum(['auth-expired', 'not-signed-in', 're-auth']),
  /** Where to go, when the harness printed a URL. Answering does not visit it —
   *  a human (or an out-of-band flow) does, and then says so. */
  url: z.string().optional(),
})
export type LoginAsk = z.infer<typeof LoginAsk>

export const LoginAnswer = z.object({
  kind: z.literal('login'),
  /** THE ANSWER IS A REPORT, NOT A CREDENTIAL. No secret ever crosses this
   *  vocabulary: `completed` means the credential was refreshed by some other
   *  means and the runtime should retry, `cancelled` means stop waiting. */
  outcome: z.enum(['completed', 'cancelled']),
})
export type LoginAnswer = z.infer<typeof LoginAnswer>

/** How a session resumes. `full` is the default for every role profile (spec
 *  §4); `summary` is chosen only when the harness offers no full path, and is
 *  then recorded on the session. */
export const RecoveryChoice = z.enum(['full-resume', 'summary-resume', 'fresh-session', 'abandon'])
export type RecoveryChoice = z.infer<typeof RecoveryChoice>

/**
 * `recovery` — a resume-time prompt, asked while the handle is still STARTING.
 *
 * "Session fell out of cache, resume from summary?", trust re-prompts,
 * context-overflow recovery. This is the kind that proves the lifecycle phase
 * cannot gate interactions, and the one a background executor MUST be able to
 * auto-answer or it stalls before it has started.
 *
 * NO PRODUCER TODAY: the terminal driver's resume path (W3) is where these
 * appear. The default answer table already routes the kind — see the server
 * aggregate's `DEFAULT_ANSWERS` — so the producer arrives to a decided policy.
 */
export const RecoveryAsk = z.object({
  ...ASK_VERSION,
  reason: z.enum(['cache-miss', 'trust-prompt', 'context-overflow', 'unknown']),
  /** What the harness actually asked, for a surface that renders it. */
  prompt: z.string(),
  /** Which choices this harness offers. A choice absent here must not be sent —
   *  `full-resume` is the policy default, not a guarantee every harness has one. */
  offered: z.array(RecoveryChoice).readonly(),
})
export type RecoveryAsk = z.infer<typeof RecoveryAsk>

export const RecoveryAnswer = z.object({
  kind: z.literal('recovery'),
  choice: RecoveryChoice,
})
export type RecoveryAnswer = z.infer<typeof RecoveryAnswer>

/**
 * Fields every ask carries regardless of kind, SPLIT AROUND the discriminant.
 *
 * Spread into each arm rather than held in a base object a union extends:
 * `z.discriminatedUnion` needs the literal on the arm itself, and an
 * intersection would lose the narrowing that is the whole point of keying on
 * `kind`.
 *
 * The split into head and tail is not cosmetic. Zod emits parsed keys in SHAPE
 * order, so the golden pins it; typing the payload was supposed to be the only
 * wire change here, and spreading one base object ahead of `kind`/`payload`
 * would have moved four other fields at the same time. Head, discriminant,
 * payload, tail keeps `id · sessionId · kind · payload · askedAt · source ·
 * answerable · policyVerdict · expiresAt` exactly as W1 shipped it.
 */
const INTERACTION_HEAD = {
  /** UNBRANDED BY DECISION: minted by the driver that observed the ask, in that
   *  driver's namespace. W2's durable aggregate keys its own rows. */
  id: z.string().min(1),
  sessionId: z.string().min(1).pipe(SessionIdField),
} as const

const INTERACTION_TAIL = {
  askedAt: z.string().datetime(),
  source: InteractionSource,
  answerable: InteractionAnswerability,
  policyVerdict: z.enum(['auto-allowed', 'auto-denied', 'escalated']).optional(),
  /** ESCALATION DEADLINE, NOT AUTO-DENY. Passing it raises visibility; it never
   *  answers the ask. */
  expiresAt: z.string().datetime().optional(),
} as const

/** One ask arm: head, discriminant, its own payload, tail. */
const askArm = <K extends InteractionKind, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z.object({ ...INTERACTION_HEAD, kind: z.literal(kind), payload, ...INTERACTION_TAIL })

/** The same arm plus the server aggregate's lifecycle — see
 *  {@link PendingInteractionWire}. */
const recordArm = <K extends InteractionKind, P extends z.ZodTypeAny>(kind: K, payload: P) =>
  z.object({
    ...INTERACTION_HEAD,
    kind: z.literal(kind),
    payload,
    ...INTERACTION_TAIL,
    ...INTERACTION_RECORD,
  })

/**
 * THE ASK, KEYED ON ITS KIND (POD-2020, replacing W1's opaque `payload` record).
 *
 * A discriminated union rather than `kind` + open record, because the whole
 * value of typing this vocabulary is that narrowing `kind` narrows `payload`:
 * a handler that has established it is looking at a `permission` must not still
 * have to guess whether `toolName` is there.
 */
export const PendingInteraction = z.discriminatedUnion('kind', [
  askArm('permission', PermissionAsk),
  askArm('question', QuestionAsk),
  askArm('plan-approval', PlanApprovalAsk),
  askArm('elicitation', ElicitationAsk),
  askArm('login', LoginAsk),
  askArm('recovery', RecoveryAsk),
])
export type PendingInteraction = z.infer<typeof PendingInteraction>

/**
 * THE ASK WITHOUT ITS IDENTITY — a kind paired with the payload THAT kind takes.
 *
 * Every producer of an interaction builds this before the aggregate (or the
 * driver) mints an id, and all three of them — the fake driver, the terminal
 * driver, the server synthesizer — reached for `Pick<PendingInteraction, 'kind'
 * | 'payload'>` first and were wrong in the same way. A plain `Pick` over a
 * union is NOT distributive: it collapses to `{kind: InteractionKind; payload:
 * AnyPayload}`, which would let a `login` kind carry a `question` payload —
 * exactly the pairing the discriminated union exists to make unrepresentable.
 *
 * So it is written once, here, distributively.
 */
export type InteractionAskSpec = PendingInteraction extends infer T
  ? T extends { kind: infer K; payload: infer P }
    ? { readonly kind: K; readonly payload: P }
    : never
  : never

/** THE ANSWER, keyed on the same discriminant as the ask. */
export const InteractionAnswer = z.discriminatedUnion('kind', [
  PermissionAnswer,
  QuestionAnswer,
  PlanApprovalAnswer,
  ElicitationAnswer,
  LoginAnswer,
  RecoveryAnswer,
])
export type InteractionAnswer = z.infer<typeof InteractionAnswer>

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
    /**
     * `not-yet-supported` is the DELIBERATE refusal, and it is the one that
     * keeps a session honest rather than safe-looking.
     *
     * Two answering paths are specified and unshipped. A keystroke-emulated
     * PERMISSION is unshipped by POD-707: the native menu's ordinals vary per
     * ask, so deny-by-digit can approve, and the always-allow rows are
     * conditional so they must never be pressed programmatically — the evidence
     * file's §5 lists exactly what a PTY run still has to answer first. A
     * `structured` answer is unshipped because no protocol driver exists yet
     * (W5/W6).
     *
     * Both REFUSE rather than degrade. The ask stays open, the session stays
     * visibly blocked, and a human answers it at the terminal — which is
     * strictly better than a silent wrong keystroke that reports success.
     */
    reason: z.enum([
      'already-answered',
      'expired',
      'unknown-interaction',
      'not-yet-supported',
      /**
       * THE ANSWER WAS RIGHT AND DID NOT ARRIVE (POD-2023).
       *
       * Distinct from `not-yet-supported`, and the distinction is the whole
       * reason it exists: that one says "this driver cannot answer asks of this
       * shape", which a surface renders as a permanent limitation and a caller
       * stops retrying. This one says the capability is there and the REPLY
       * failed to reach the provider — a retry is exactly the right response.
       * Its first producer is the opencode driver, whose REST reply can fail
       * like any other network call.
       *
       * The ask stays OPEN either way, which is what keeps a session visibly
       * blocked instead of falsely resolved.
       */
      'delivery-failed',
    ]),
    /** What went wrong, for a surface to show and a log to keep. Never parsed
     *  for control flow — that is what `reason` is for. */
    detail: z.string().optional(),
  }),
])
export type InteractionAnswerOutcome = z.infer<typeof InteractionAnswerOutcome>

// ---------------------------------------------------------------------------
// The durable aggregate row (POD-2020 / W2)
// ---------------------------------------------------------------------------

/**
 * THE LIFECYCLE, AND WHY `expired` IS NOT A DECISION.
 *
 * `asked` moves to exactly one of three terminals and stops.
 *
 *  - `answered` — somebody decided, and `answeredBy` says who.
 *  - `expired` — the ask stopped being answerable because the SESSION did: it
 *    ended, taking the menu with it.
 *  - `superseded` — the session moved on and this ask is no longer what it is
 *    blocked on. Distinct from `expired` on purpose: the common cause is a
 *    person answering at the terminal, which is a resolution, not a loss, and a
 *    list that reported those as expirations would read as a pile of failures.
 *
 * NOTHING HERE IS A DEADLINE. Spec §4 is explicit that `expiresAt` "raises the
 * ask's visibility; it never answers it", so a row past its escalation deadline
 * is still `asked`. Conflating the two would turn an escalation into a silent
 * denial, which is the failure mode the whole aggregate exists to abolish.
 */
export const InteractionStatus = z.enum(['asked', 'answered', 'expired', 'superseded'])
export type InteractionStatus = z.infer<typeof InteractionStatus>

/** Who resolved it. `policy` is the per-session default answer table; there is
 *  no policy ENGINE yet (W2 ships the table only) but the vocabulary is the
 *  spec's and the table already writes this value. */
export const InteractionAnsweredBy = z.enum(['policy', 'superagent', 'human'])
export type InteractionAnsweredBy = z.infer<typeof InteractionAnsweredBy>

/** Fields the SERVER aggregate adds to a driver's ask. Same spread-not-extend
 *  reason as {@link INTERACTION_HEAD}, and they go after the tail so the ask's
 *  own field order is byte-identical to {@link PendingInteraction}'s. */
const INTERACTION_RECORD = {
  status: InteractionStatus,
  /**
   * THE AT-LEAST-ONCE DEFENCE, and it is only a defence — never a proof.
   *
   * A `screen-classifier` ask has no identity of its own: a re-rendered menu is
   * a fresh observation of the same question, and nothing in a scraped frame
   * distinguishes that from a second question that happens to look identical.
   * The fingerprint is a stable digest of (session, kind, the decision-bearing
   * payload fields) that collapses the first case, and the spec requires
   * consumers to tolerate it failing on the second: asked→answered on a
   * classifier-sourced row is AT-LEAST-ONCE, never exactly-once.
   *
   * Present on every row, not just classifier ones, so the dedupe query needs no
   * branch — but only CONSULTED where `source` says identity is unreliable. A
   * `protocol`-sourced driver has a real request id and must not have two
   * genuinely distinct asks merged because their text matched.
   */
  fingerprint: z.string().min(1),
  answeredAt: z.string().datetime().optional(),
  answeredBy: InteractionAnsweredBy.optional(),
  /** What was decided. Kept on the row because "who answered and how" is the
   *  audit trail a headless run is judged on, and because a duplicate answer's
   *  typed refusal is more useful when the surface can show the first one. */
  answer: InteractionAnswer.optional(),
  /**
   * HOW THE ANSWER REACHED THE AGENT — the honesty field.
   *
   * `menu` typed digits into a live native menu, `text` delivered it as an
   * ordinary message, `structured` replied over a protocol. `unverified` means
   * the aggregate recorded the answer but could not confirm delivery, which is
   * the same distinction {@link TurnReceipt}'s fourth outcome draws and is here
   * for the same reason: a keystroke answer cannot prove it acted on the exact
   * menu it classified.
   */
  deliveredVia: z.enum(['menu', 'text', 'structured', 'unverified']).optional(),
  expiredAt: z.string().datetime().optional(),
} as const

/**
 * THE DURABLE ROW — a driver's {@link PendingInteraction} plus the server
 * aggregate's lifecycle, and the payload of the `pendingInteraction` metadata
 * feed kind.
 *
 * It lives HERE, beside the contract type it extends, rather than in
 * `@podium/model` where every other `MetadataChange` arm's wire type lives. That
 * is a deliberate exception with one argument behind it: this row IS the
 * contract's ask plus five fields, and putting the two halves of one vocabulary
 * in two packages is exactly the drift that a shared vocabulary is supposed to
 * prevent. The arm in `./sync.ts` imports it from this file.
 */
export const PendingInteractionWire = z.discriminatedUnion('kind', [
  recordArm('permission', PermissionAsk),
  recordArm('question', QuestionAsk),
  recordArm('plan-approval', PlanApprovalAsk),
  recordArm('elicitation', ElicitationAsk),
  recordArm('login', LoginAsk),
  recordArm('recovery', RecoveryAsk),
])
export type PendingInteractionWire = z.infer<typeof PendingInteractionWire>
