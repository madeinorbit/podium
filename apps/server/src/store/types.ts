/**
 * Row/domain types shared by the per-aggregate repositories (store/*.ts) and
 * re-exported from `../store` so existing importers keep working.
 */

export type PinKind = 'panel' | 'worktree' | 'repo'

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

/** sessionId → snooze deadline. `null` = until next message; ISO = timed. */
export type SnoozeMap = Record<string, string | null>

export type SessionStatusPersisted = 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'

/** One persisted session row. camelCase mirror of the snake_case `sessions` table. */
export interface SessionRow {
  id: string
  agentKind: string
  cwd: string
  title: string
  /** User-set display name; null = derive from title. */
  name: string | null
  originKind: 'spawn' | 'resume'
  conversationId: string | null
  resumeKind: string | null
  resumeValue: string | null
  status: SessionStatusPersisted
  exitCode: number | null
  durableLabel: string
  createdAt: string
  lastActiveAt: string
  /** Last PTY output frame (ISO); null = none recorded. Hibernation signal only — not recency. */
  lastOutputAt: string | null
  /** Last controller input — any keys/mouse/paste (ISO); null = none. Hibernation signal only. */
  lastInputAt: string | null
  /** Last resume/resurrect (ISO); null = never. Hibernation signal only. */
  lastResumedAt: string | null
  /** WHO created the session (issue #60): 'user', 'issue:<id>', 'superagent:<threadId>', …
   *  null/absent = legacy row from before the field existed. Optional (like machineId)
   *  so pre-#60 row literals stay valid. */
  spawnedBy?: string | null
  archived: boolean
  /** Kanban column on the home board; null = unsorted. */
  workState: string | null
  /** The machine this session runs on. Optional during build-out (Task 5 always emits it). */
  machineId?: string
  /** True for a headless harness session (no PTY; superagent-driven turns).
   *  Optional so pre-existing row literals stay valid; absent = false. */
  headless?: boolean
  /** Explicit issue attachment (issue-as-workspace). null/absent = unattached
   *  (legacy / shells) — cwd-derived worktree grouping applies. */
  issueId?: string | null
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  session; null/absent = never opened. Optional so pre-existing row literals stay valid. */
  readAt?: string | null
}

/** One row of the machines table (token_hash is internal — not included here). */
export interface MachineRecord {
  id: string
  name: string
  hostname: string
  createdAt: string
  lastSeenAt: string
}

/** One row of the `issues` table (camelCase mirror; `blockedBy` stored as JSON text). */
export interface IssueRow {
  id: string
  repoPath: string
  /** Stable repo identity (#74/#164) — the issue's repo KEY: repo-scoped reads
   *  and seq allocation key on it (UNIQUE(repo_id, seq)). repoPath remains the
   *  display/lookup attribute maintained by the repo registry. Nullable only as
   *  defense in depth (the boot heal re-fills NULLs; every write resolves it). */
  repoId?: string | null
  seq: number
  title: string
  description: string
  stage: string
  worktreePath: string | null
  branch: string | null
  parentBranch: string
  defaultAgent: string
  defaultModel: string
  defaultEffort: string
  /** Machine (daemon) this issue's agents run on; null = pick by repo affinity. */
  machineId?: string | null
  linearId: string | null
  linearIdentifier: string | null
  linearUrl: string | null
  activityNotes: string | null
  notesUpdatedAt: string | null
  suggestedStage: string | null
  suggestedReason: string | null
  /** LLM-authored soft-dependency notes (assistant digest — IssueService.
   *  refreshAssistant writes the model's output here): free-form strings,
   *  often BRANCH names rather than issue ids, surfaced verbatim on the wire.
   *  NOT the dependency graph — real edges live in issue_deps. Audited for
   *  #164 step 4: still actively written/read, so the column stays (stored as
   *  JSON text, normalized to a clean string[] on write). */
  blockedBy: string[]
  dependencyNote: string | null
  prUrl: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
  priority: number
  type: string
  assignee: string | null
  parentId: string | null
  design: string | null
  acceptance: string | null
  notes: string | null
  dueAt: string | null
  deferUntil: string | null
  closedReason: string | null
  supersededBy: string | null
  duplicateOf: string | null
  pinned: boolean
  estimateMin: number | null
  needsHuman: boolean
  humanQuestion: string | null
  /** Agent-published human-facing panel, stored as raw JSON (parsed in IssueService).
   *  Optional so pre-existing row literals (tests, ingest) stay valid; absent = none. */
  panel?: string | null
  /** Whose intent this issue captures ('human' | 'agent'). Optional so pre-existing
   *  row literals stay valid; absent = 'human'. */
  origin?: string
  /** Placeholder-titled draft vessel (issue-as-workspace); retitling clears it.
   *  Optional so pre-existing row literals stay valid; absent = false. */
  draft?: boolean
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  issue; null/absent = never opened. Optional so pre-existing row literals stay valid. */
  readAt?: string | null
}

export interface IssueCommentRow {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
}

/** One "agent mail" message addressed to an ISSUE (issue #103). Status lifecycle:
 *  unread → read (inbox listing) → claimed (an agent committing to act on it). */
export interface IssueMessageRow {
  id: string
  issueId: string
  fromAuthor: string
  body: string
  createdAt: string
  status: 'unread' | 'read' | 'claimed'
  claimedBy: string | null
  readAt: string | null
  claimedAt: string | null
}

/** A durable event subscription (event-subscriptions design, Phase B). The steward
 *  matches enabled rows against every polled event; a match resolves `source` to the
 *  event's subject and delivers per `deliverNudge`/`deliverNotify`. */
export interface Subscription {
  id: string
  /** Who is notified: a session (in-session nudge) or an issue (its member sessions). */
  subscriberKind: 'session' | 'issue'
  subscriberId: string
  /** The subscription-event kind matched (e.g. 'issue.closed', 'session.finished'). */
  event: string
  /** What is watched: a dynamic relationship, or an explicit issue / session id. */
  sourceKind: 'relationship' | 'issue' | 'session'
  sourceRef: string
  deliverNudge: boolean
  deliverNotify: boolean
  origin: 'default' | 'custom'
  enabled: boolean
  createdAt: string
}

/** One row of the conversation index (camelCase mirror of `conversations`). */
export interface ConversationIndexRow {
  id: string
  agentKind: string
  providerId: string
  title?: string
  /** Command-center-set display name (curation; survives re-discovery). */
  name?: string
  /** Work-LLM state summary (curation; survives re-discovery). */
  summary?: string
  projectPath?: string
  resumeKind?: string
  resumeValue?: string
  createdAt?: string
  updatedAt?: string
  messageCount?: number
  /** Which machine owns this conversation; '__local__' for pre-multi-machine rows. */
  machineId?: string
  /** Set when this conversation is a subagent (sidechain) of another — the resume
   *  picker filters these out so only top-level sessions are offered. */
  parentConversationId?: string
}

export interface ToolCallRow {
  id: string
  name: string
  arguments: string
}

/** One message of a superagent thread (the 'global' orchestrator, or a 'btw_<id>' thread). */
export interface SuperagentMessageRow {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCalls?: ToolCallRow[]
  toolCallId?: string
  toolName?: string
  createdAt: string
}

/** A superagent conversation: the always-there 'global' thread, a per-session 'btw'
 *  thread, or a per-repo 'concierge' intake thread. */
export interface SuperagentThreadRow {
  id: string
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: string
  /** The repo this thread fronts (concierge threads only). */
  repoPath?: string
  title?: string
  /** High-water mark into the origin session's transcript (btw threads), or the
   *  issue event-log id already digested (concierge threads, stringified). */
  watermarkItemId?: string
  watermarkTs?: string
  /** Harness agent frozen onto the thread at its first headless turn — later
   *  turns keep the same agent even if the settings default changes. */
  agentKind?: string
  /** The Podium headless session rendering this thread (concierge unification). */
  podiumSessionId?: string
  /** The harness's own session id — the resume value for every later turn. */
  harnessSessionId?: string
  /** PTY session holding the "open in terminal" one-writer lock; sendTurn
   *  rejects while this session is live (lazily checked, lazily cleared). */
  terminalSessionId?: string
  createdAt: string
  updatedAt: string
  archived: boolean
}
