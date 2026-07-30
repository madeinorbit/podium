/**
 * The session aggregate and its value objects — relocated verbatim from
 * `@podium/protocol`'s `messages/runtime-state.ts` and `messages/terminal.ts`
 * at POD-300. Field names, order, optionality, `.default()`s and `.catch()`es
 * are unchanged: the move is byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`.
 *
 * `SessionMeta` is the wire/read projection of a session, not its durable
 * storage row — ADR 4's representation policy keeps those distinct, and this
 * move deliberately does not collapse them.
 *
 * ---------------------------------------------------------------------------
 * NOTES FOR THE ISSUES QUEUED BEHIND THIS ONE (docs/multi-user-readiness.md,
 * human decisions 2026-07-29). Recorded here, not implemented here.
 * ---------------------------------------------------------------------------
 *
 * OWNER / VISIBILITY (POD-1075 model types, POD-1071 matrix columns). Not added
 * here — adding them would break the byte-identical contract that makes this
 * move safe. `SessionMeta` is a flat aggregate with no positional encoding, so
 * `owner` / `visibility` / a grants reference are all PURELY ADDITIVE later:
 * append optional fields and the golden fixtures still pass unchanged, which is
 * exactly how §3.2's "minimum shape" is meant to be proven additive.
 *
 * PER-USER STATE (§3.3, POD-1076). `readAt`, `unread` and `snoozedUntil` are
 * declared here as SINGLETONS because that is what they are on the wire today
 * ("Global (single-operator)" says so in their own doc comments). Under
 * multi-user they become per-user rows keyed `(userId, sessionId)`. Because the
 * stored and wire values stay the strings they already are, that is a RE-KEY,
 * not a re-representation (see the model README's invariant 2).
 *
 * ATTRIBUTION (§3.1.3 A3, and see `entities/issue.ts`). `controllerId` and
 * `spawnedBy` are actor-shaped fields carrying at most one value. A3 makes
 * attribution a PAIR — actor (which agent) and on-behalf-of (which human). The
 * on-behalf-of half is POD-1075's; flagged to POD-304 (provenance envelope) as
 * a placement decision that must accommodate two values, not one.
 *
 * MACHINE FACTS EMBEDDED HERE. `machineId` / `machineName` are a *reference to*
 * a machine, not facts about one, so they stay on the session rather than
 * joining `entities/machine.ts`'s per-machine group. §3.1.4 M1's `see` verb
 * explicitly covers "your session ran there" attribution, so a principal who
 * can see the session may learn these two.
 */

import { z } from 'zod'
import {
  AccountIdField,
  ConversationIdField,
  IssueIdField,
  machineIdBlockedOnPOD318,
  SessionIdField,
} from '../ids'
import { AgentKind } from './agent'

// ---------------------------------------------------------------------------
// Terminal value objects
// ---------------------------------------------------------------------------

const positiveInt = z.number().int().positive()

export const Geometry = z.object({ cols: positiveInt, rows: positiveInt })
export type Geometry = z.infer<typeof Geometry>

export const ResumeRef = z.object({ kind: z.string(), value: z.string() })
export type ResumeRef = z.infer<typeof ResumeRef>

export const SessionStatus = z.enum(['starting', 'live', 'reconnecting', 'hibernated', 'exited'])
export type SessionStatus = z.infer<typeof SessionStatus>

// ---------------------------------------------------------------------------
// Agent runtime state (harness-observed, distinct from SessionStatus)
// ---------------------------------------------------------------------------
// SessionStatus says whether the PTY/process is alive (starting/live/hibernated/…).
// AgentRuntimeState says what the agent inside it is doing, derived from harness
// side-channels (hooks). `unknown` = uninstrumented agent kind or no events yet.
export const AgentPhase = z.enum([
  'unknown',
  'working',
  'idle',
  'needs_user',
  'errored',
  'compacting',
  'ended',
])
export type AgentPhase = z.infer<typeof AgentPhase>

// Why did the agent go idle? `open_todos` = stopped with unfinished task list;
// `question` = last message reads like it wants an answer; `approval` = stopped
// while in plan mode; `interrupted` = user explicitly aborted the running turn.
// Tier-3 (LLM classification) will refine this later.
export const IdleVerdict = z.object({
  kind: z.enum(['done', 'question', 'approval', 'open_todos', 'interrupted']),
  summary: z.string().optional(),
})
export type IdleVerdict = z.infer<typeof IdleVerdict>

export const AgentNeed = z.object({
  kind: z.enum(['question', 'permission']),
  summary: z.string().optional(),
})
export type AgentNeed = z.infer<typeof AgentNeed>

export const AgentError = z.object({
  class: z.string(), // harness error class, e.g. rate_limit / server_error / billing_error
  retryable: z.boolean(), // true → a blind "continue" is worth offering
})
export type AgentError = z.infer<typeof AgentError>

/** One live native harness subagent (Claude Task/Agent tool, etc.).
 *  Identity rides the hook channel (`agent_id` / `agent_type` on SubagentStart
 *  / SubagentStop); optional so older daemons omit it. [spec:SP-dae6] */
export const NativeSubagent = z.object({
  /** UNBRANDED: a HARNESS-minted `agent_id` off the hook channel, not a Podium
   *  session id. Its brand is ADR 9's `AgentIdentityId` (the actor half of the
   *  attribution pair), which POD-1075 owns; a `SessionId` here would be wrong. */
  id: z.string(),
  type: z.string().optional(),
})
export type NativeSubagent = z.infer<typeof NativeSubagent>

export const AgentRuntimeState = z.object({
  phase: AgentPhase,
  since: z.string(), // ISO 8601 of the last phase change
  /** Completed working/compacting stretches before `since`, in milliseconds.
   *  Optional for compatibility with daemons and persisted rows from before the
   *  cumulative motion timer existed. While actively working, clients add the
   *  live `now - since` stretch; in a stopped phase this is the final total. */
  workingMsTotal: z.number().int().nonnegative().optional(),
  nativeSubagentCount: z.number().int().nonnegative(),
  /** Active native subagents with harness identity (agent_id + optional type).
   *  Additive/optional for back-compat; when present, length matches
   *  nativeSubagentCount for identity-tracked spawns. M6 consumes for naming. */
  nativeSubagents: z.array(NativeSubagent).optional(),
  /** True when turn_completed already fired but idle was deferred because
   *  native subagents were still running. Cleared on genuine work / settle /
   *  terminal phases. Optional for back-compat with older daemons/rows. */
  awaitingSubagents: z.boolean().optional(),
  idle: IdleVerdict.optional(), // present when phase === 'idle'
  need: AgentNeed.optional(), // present when phase === 'needs_user'
  error: AgentError.optional(), // present when phase === 'errored'
})
export type AgentRuntimeState = z.infer<typeof AgentRuntimeState>

// ---------------------------------------------------------------------------
// Session aggregate
// ---------------------------------------------------------------------------

export const SessionOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn') }),
  /** NOT a branded `ConversationId`, and this is evidence-based rather than an
   *  oversight: this field holds the HARNESS-NATIVE conversation id, not the
   *  Podium-stable `podiumId`. `apps/server/src/modules/sessions/service.ts`
   *  fills it from `session.resume.value` — the native resume ref — on the
   *  handoff path, and elsewhere from `r.conversationId ?? ''`. A native id has
   *  no brand by decision (see `ids/brands.ts`), and the empty-string default is
   *  why a `.min(1)` schema could not go here either. */
  z.object({ kind: z.literal('resume'), conversationId: z.string() }),
])
export type SessionOrigin = z.infer<typeof SessionOrigin>

// The state of the WORK a session carries (kanban column on the home board) —
// user-sorted, unlike AgentPhase which is harness-observed.
export const WorkState = z.enum(['planning', 'implementing', 'testing', 'done', 'icebox'])
export type WorkState = z.infer<typeof WorkState>

/** Agent action offer [spec:SP-c7f1] — a freeform message plus zero..N action
 *  buttons an agent offers the user as suggested next actions. */
export const SessionOffer = z.object({
  message: z.string(),
  actions: z.array(
    z.object({
      label: z.string(),
      prompt: z.string(),
      /** True when clicking must first collect freeform user feedback (e.g. a
       *  "Send back" button); the UI appends the text to `prompt`. */
      input: z.boolean().optional(),
    }),
  ),
  /** Issue-artifact references [POD-120] — paths (as published via `podium
   *  issue artifact --add`) of the session's issue's artifacts offered as
   *  evidence. Ordered, ≤6; clients resolve them against the issue panel's
   *  artifact list and silently drop paths that no longer resolve. */
  artifacts: z.array(z.string()).optional(),
  createdAt: z.string(), // ISO 8601
})
export type SessionOffer = z.infer<typeof SessionOffer>

export const SessionMeta = z.object({
  sessionId: SessionIdField,
  agentKind: AgentKind,
  title: z.string(),
  /** Curated name. Wins over `title` (the live terminal title) wherever shown. */
  name: z.string().optional(),
  /** Resolved launch configuration captured at spawn [spec:SP-dae6]. */
  model: z.string().optional(),
  effort: z.string().optional(),
  accountId: AccountIdField.optional(),
  /** WHO set `name` (#490): 'user' = a human named it, and no agent may overwrite it;
   *  'agent' = the session named itself (it may re-title itself). Absent = unnamed. */
  nameSource: z.enum(['user', 'agent']).optional(),
  cwd: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().optional(), // present only when status === 'exited'
  /** Daemon diagnosis for exitCode=-1 (spawn never started). */
  spawnFailure: z.string().optional(),
  /** NOT a `SessionId` — it holds a WEBSOCKET CLIENT id
   *  (`apps/server/src/modules/sessions/session.ts`: `if (this.controllerId ===
   *  null) this.controllerId = client.id`). Branding it `SessionId` because the
   *  field sits on `SessionMeta` and is "actor-shaped" would have been a
   *  well-typed lie. Its brand is ADR 9's `DeviceId` family (a device/connection,
   *  not a person and not a session), which POD-1075 owns. */
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO 8601
  lastActiveAt: z.string(), // ISO 8601 — recency signal for the home board
  /** ISO 8601 time of the last human (controller) input into this session, when
   *  one has happened. The offer-artifact freshness fallback [POD-120] compares
   *  issue-artifact addedAt against this to show "new since you last typed". */
  lastInputAt: z.string().optional(),
  origin: SessionOrigin,
  agentState: AgentRuntimeState.optional(),
  archived: z.boolean(),
  /** Email-style read state (issue #124). Global (single-operator) — the ISO time
   *  the operator last opened this session, or null if never opened. */
  readAt: z.string().nullable().catch(null).default(null),
  /** Durable terminal-transition metadata for completion decay. [spec:SP-6144] */
  stoppedAt: z.string().optional(),
  stopReason: z.enum(['self', 'parent', 'forced', 'exited']).optional(),
  /** Server-DERIVED: there is activity the operator hasn't seen —
   *  `lastActiveAt > readAt`, or `readAt` is null (never opened). Defaulted so a
   *  pre-field cached payload still validates (unread → false). */
  unread: z.boolean().catch(false).default(false),
  workState: WorkState.optional(),
  /** True when a resume ref is known — hibernate→resume is possible. */
  resumable: z.boolean().optional(),
  /** The native CLI resume ref (kind + value) when known — the conversation id
   *  the harness reattaches to. Lets the client surface the literal
   *  `claude --resume <id>` / `codex resume <id>` command without a round-trip.
   *  Present only when `resumable`; omitted for shells / not-yet-known sessions. */
  resume: ResumeRef.optional(),
  /** True once a structured transcript has been observed for this session — the
   *  capability that powers chat view. Set by the layer that owns the tail, so a
   *  new transcript provider lights up chat with no client-side kind checks. */
  transcriptAvailable: z.boolean().optional(),
  /** True while the session is actively writing to its PTY (debounced). The
   *  activity signal for uninstrumented kinds with no agentState — a shell reads
   *  as "working" only while a process is producing output, idle at its prompt. */
  busy: z.boolean().optional(),
  /** The agent's self-chosen identity colour (Claude's `/color`): a named colour
   *  — red|blue|green|yellow|purple|orange|pink|cyan — used to tell agents apart,
   *  shown as the tab/sidebar accent line. Absent / 'default' = no colour. This is
   *  identity, distinct from the runtime *status* dot. */
  agentColor: z.string().optional(),
  /** The model OBSERVED producing this session's assistant turns (transcript
   *  `message.model`, e.g. "claude-fable-5") — resolves a spawn-time `auto` and
   *  follows mid-session `/model` switches. Distinct from `model` above, which is
   *  the spawn-time *selection*. Absent until the first assistant turn is seen. */
  observedModel: z.string().optional(),
  /** The reasoning-effort tier OBSERVED on assistant turns (transcript top-level
   *  `effort`) — the observed counterpart of the spawn-time `effort` request. */
  observedEffort: z.string().optional(),
  // The machine (daemon) this session runs on. machineId is the stable join key;
  // machineName is the display label (server-resolved from the machines table).
  // OPTIONAL during build-out so every task stays typecheck-green: Task 5 always
  // emits them, and the web treats absent as the local machine.
  // machineId is CARVED OUT of the brand flip, not missed: it can hold
  // '__local__' (the `sessions.machine_id` column DEFAULT) or 'local'
  // (LOCAL_MACHINE_ID), and ADR 1 Amendment 2 D16.2 forbids branding a site that
  // can hold either until POD-318 retires them — a brand that validates length
  // and not shape would launder the sentinel instead of flagging it.
  machineId: machineIdBlockedOnPOD318.optional(),
  machineName: z.string().optional(),
  /** Snooze state — orthogonal to agentState. `undefined`/absent = not snoozed;
   *  `null` = snoozed until the next message; an ISO string = snoozed until that
   *  time (or the next message, whichever first). Drives the sidebar's attention
   *  triage only; never changes the agent's phase. */
  snoozedUntil: z.string().nullable().optional(),
  /** Last-edit time (ISO 8601) of a non-empty unsent composer draft, when one
   *  exists. Drives the "DRAFT" tag and lifts the session in NEEDS YOUR ATTENTION
   *  by when its prompt was last edited (a draft edit is recent user intent on
   *  that session). Absent = no draft (or an empty one). */
  draftUpdatedAt: z.string().optional(),
  /** Draft Sync v2 (POD-859): true when the session's daemon runs the composer
   *  scrape/inject engine. A client uses it to retire its own native sampler +
   *  chat→native flush (the daemon owns that now). Absent/false = legacy path. */
  draftSyncEngine: z.boolean().optional(),
  /** Number of durable server-held messages waiting to be typed into this agent
   *  once it is back (docs/spec/outbox-write-path.md §2.2). Absent = none. Like
   *  snoozedUntil/draftUpdatedAt this is pending USER intent, orthogonal to the
   *  agent's phase; it drives the chat "queued" state on every client. */
  queuedMessageCount: z.number().int().positive().optional(),
  /** Agent action offer [spec:SP-c7f1]. Session-scoped channel for an agent to
   *  suggest next actions the user can pick — a freeform message plus zero..N
   *  buttons, each carrying an agent-authored prompt injected as a normal turn
   *  on click. Like snoozedUntil/draftUpdatedAt it is a derived overlay merged
   *  onto SessionMeta, orthogonal to the agent's phase. Ephemeral: cleared on
   *  the next user-submitted turn (a button click counts). Absent/null = none. */
  offer: SessionOffer.nullable().optional(),
  /** Transient move overlay; absent outside an in-flight handoff. Not an id at
   *  all: the server sets it to `targetMachine.name`, a display label. */
  handoffTarget: z.string().optional(),
  /** The stable Podium conversation identity this session is working in
   *  (docs/spec/conversation-registry.md) — survives resume-rolls and worktree
   *  moves, unlike the native resume ref. Absent until first known.
   *
   *  THE branded `ConversationId` on this schema — `origin.conversationId` above
   *  is the native id and is deliberately unbranded. */
  conversationPodiumId: ConversationIdField.optional(),
  /** WHO created this session (provenance, issue #60). Freeform; documented values:
   *  'user' | 'superagent:<threadId>' | 'steward' | 'issue:<issueId>' |
   *  'session:<sessionId>'. Absent = created before this field existed (unknown).
   *
   *  DELIBERATELY LEFT A RAW STRING, and not because it is not identity —
   *  because a brand would not fix it. POD-360 found SIX produced arms, exactly
   *  ONE consumer that parses this string, and SEVEN that rebuild the template
   *  literal to compare, FIVE of them gating parent-session authorization: a
   *  tag-format change makes those five silently answer "not the parent" rather
   *  than failing. A brand still permits seven hand-built strings, so what this
   *  field needs is a shared CONSTRUCTOR and PARSER (POD-1133, `discovered-from`
   *  this issue) — and it is simultaneously an attribution site that gains an
   *  on-behalf-of value in POD-1075 (`docs/rearch-branded-id-flip.md` §4). */
  spawnedBy: z.string().optional(),
  /** OPTIONAL workflow-coordination pass-through metadata (#285 via #237
   *  [spec:SP-34d7 cross-harness]). Stamped at spawn/assignment by an external
   *  coordinator; the substrate never interprets them. Parent linkage rides
   *  spawnedBy ('session:<id>'), deliberately not duplicated.
   *
   *  UNBRANDED BY DECISION: "the substrate never interprets them" is exactly the
   *  correlation-id class — these name rows in an EXTERNAL coordinator's id
   *  space, and a brand would assert a namespace we do not own or mint. */
  workflowRunId: z.string().optional(),
  workflowStepId: z.string().optional(),
  executionProfileId: z.string().optional(),
  /** Explicit issue attachment (issue-as-workspace): the issue this session is
   *  working on. Wins over cwd-derived worktree grouping. Structured successor
   *  of the freeform `spawnedBy: 'issue:<id>'`. Absent = unattached (legacy /
   *  shells) — cwd fallback applies. */
  issueId: IssueIdField.optional(),
  /** Human-facing nice-name fields (#474). refIssueId/refLetter identify a
   *  birth issue (`POD-13-A`); refDraft is the issueless DRAFT ordinal
   *  (`POD-DRAFT-3`). The birth name is PERMANENT — re-attaching to another
   *  issue never renames (the current issue shows as secondary context). */
  refIssueId: IssueIdField.optional(),
  refLetter: z.string().optional(),
  refDraft: z.number().int().optional(),
  /** Server-DERIVED permanent birth nice name (`POD-13-A` / `POD-DRAFT-3`).
   *  Computed from the repo prefix + ref fields. Absent until named. */
  displayRef: z.string().optional(),
  /** True for a HEADLESS harness session (concierge unification): a persistent
   *  harness session driven turn-by-turn by the daemon with NO PTY. It renders
   *  via the normal transcript pipeline but has no terminal to attach to; the
   *  web hides it from the ordinary session lists (Phase C). Additive: absent =
   *  a normal PTY session. */
  headless: z.boolean().optional(),
  /** True for a session mirrored FROM this node's upstream hub (node⇄hub sync,
   *  docs/spec/node-hub-sync.md §2.3). Read-only surface in P7a: command paths
   *  reject it; P7b's push path excludes it (provenance — never echoed back).
   *  Additive: absent = a local session, today's behavior. */
  viaHub: z.boolean().optional(),
  /** True when this viaHub entry is last-known state from an UNREACHABLE hub —
   *  retained, not blanked (spec §2.3 staleness semantics). Only ever set
   *  alongside viaHub; local sessions never carry it. */
  upstreamStale: z.boolean().optional(),
})
export type SessionMeta = z.infer<typeof SessionMeta>
