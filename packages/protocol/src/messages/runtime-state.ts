import { z } from 'zod'
import { AgentKind, Geometry, ResumeRef, SessionStatus } from './terminal'

// ---- Agent runtime state (harness-observed, distinct from SessionStatus) ----
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

export const AgentRuntimeState = z.object({
  phase: AgentPhase,
  since: z.string(), // ISO 8601 of the last phase change
  openTaskCount: z.number().int().nonnegative(),
  idle: IdleVerdict.optional(), // present when phase === 'idle'
  need: AgentNeed.optional(), // present when phase === 'needs_user'
  error: AgentError.optional(), // present when phase === 'errored'
})
export type AgentRuntimeState = z.infer<typeof AgentRuntimeState>

export const SessionOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('spawn') }),
  z.object({ kind: z.literal('resume'), conversationId: z.string() }),
])
export type SessionOrigin = z.infer<typeof SessionOrigin>

// The state of the WORK a session carries (kanban column on the home board) —
// user-sorted, unlike AgentPhase which is harness-observed.
export const WorkState = z.enum(['planning', 'implementing', 'testing', 'done', 'icebox'])
export type WorkState = z.infer<typeof WorkState>

export const SessionMeta = z.object({
  sessionId: z.string(),
  agentKind: AgentKind,
  title: z.string(),
  /** User-set name. Wins over `title` (the live terminal title) wherever shown. */
  name: z.string().optional(),
  cwd: z.string(),
  status: SessionStatus,
  exitCode: z.number().int().optional(), // present only when status === 'exited'
  controllerId: z.string().nullable(),
  geometry: Geometry,
  epoch: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.string(), // ISO 8601
  lastActiveAt: z.string(), // ISO 8601 — recency signal for the home board
  origin: SessionOrigin,
  agentState: AgentRuntimeState.optional(),
  archived: z.boolean(),
  /** Email-style read state (issue #124). Global (single-operator) — the ISO time
   *  the operator last opened this session, or null if never opened. */
  readAt: z.string().nullable().catch(null).default(null),
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
  // The machine (daemon) this session runs on. machineId is the stable join key;
  // machineName is the display label (server-resolved from the machines table).
  // OPTIONAL during build-out so every task stays typecheck-green: Task 5 always
  // emits them, and the web treats absent as the local machine.
  machineId: z.string().optional(),
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
  /** Number of durable server-held messages waiting to be typed into this agent
   *  once it is back (docs/spec/outbox-write-path.md §2.2). Absent = none. Like
   *  snoozedUntil/draftUpdatedAt this is pending USER intent, orthogonal to the
   *  agent's phase; it drives the chat "queued" state on every client. */
  queuedMessageCount: z.number().int().positive().optional(),
  /** The stable Podium conversation identity this session is working in
   *  (docs/spec/conversation-registry.md) — survives resume-rolls and worktree
   *  moves, unlike the native resume ref. Absent until first known. */
  conversationPodiumId: z.string().optional(),
  /** WHO created this session (provenance, issue #60). Freeform; documented values:
   *  'user' | 'superagent:<threadId>' | 'steward' | 'issue:<issueId>' |
   *  'session:<sessionId>'. Absent = created before this field existed (unknown). */
  spawnedBy: z.string().optional(),
  /** OPTIONAL workflow-coordination pass-through metadata (#285 via #237
   *  [spec:SP-34d7 cross-harness]). Stamped at spawn/assignment by an external
   *  coordinator; the substrate never interprets them. Parent linkage rides
   *  spawnedBy ('session:<id>'), deliberately not duplicated. */
  workflowRunId: z.string().optional(),
  workflowStepId: z.string().optional(),
  executionProfileId: z.string().optional(),
  /** Explicit issue attachment (issue-as-workspace): the issue this session is
   *  working on. Wins over cwd-derived worktree grouping. Structured successor
   *  of the freeform `spawnedBy: 'issue:<id>'`. Absent = unattached (legacy /
   *  shells) — cwd fallback applies. */
  issueId: z.string().optional(),
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

// server -> browser client: full session-list snapshot.
export const SessionsChangedMessage = z.object({
  type: z.literal('sessionsChanged'),
  sessions: z.array(SessionMeta),
})

// One session's runtime phase changed. A dedicated message — not a full
// sessionsChanged rebroadcast — because hook events fire often (a TodoWrite
// mutation, every turn boundary, across all sessions) and re-serializing the
// whole list per event is O(sessions × clients) several times a second.
export const SessionAgentStateChangedMessage = z.object({
  type: z.literal('sessionAgentStateChanged'),
  sessionId: z.string(),
  state: AgentRuntimeState,
})

// Harness-observed agent state changed (hooks-driven). Low-frequency: phase
// transitions only, never per-frame. daemon -> server.
export const AgentStateMessage = z.object({
  type: z.literal('agentState'),
  sessionId: z.string(),
  state: AgentRuntimeState,
})
