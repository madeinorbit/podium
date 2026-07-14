/**
 * Row/domain types shared by the per-aggregate repositories (store/*.ts) and
 * re-exported from `../store` so existing importers keep working.
 */

import type { Geometry } from '@podium/protocol'
import type { IssueColorSlot } from '@podium/domain'

export type PinKind = 'panel' | 'worktree' | 'repo'

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

/** sessionId → snooze deadline. `null` = until next message; ISO = timed. */
export type SnoozeMap = Record<string, string | null>

export type SessionStatusPersisted = 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
export type SessionDeletionSource = 'issue' | 'standalone'

/** One persisted session row. camelCase mirror of the snake_case `sessions` table. */
export interface SessionRow {
  id: string
  agentKind: string
  cwd: string
  title: string
  /** Curated display name; null = derive from title. Written by a human OR by the
   *  agent naming its own session (#490) — `nameSource` says which. */
  name: string | null
  /** WHO wrote `name` (#490): 'user' = a human (web rename / superagent rename tool)
   *  — an agent may NEVER overwrite it; 'agent' = self-named (it may re-title itself);
   *  null/absent = nobody named it (also every row from before the column existed). */
  nameSource?: 'user' | 'agent' | null
  originKind: 'spawn' | 'resume'
  conversationId: string | null
  resumeKind: string | null
  resumeValue: string | null
  status: SessionStatusPersisted
  exitCode: number | null
  durableLabel: string
  /** Last authoritative PTY grid. Optional only for legacy/test callers; repository
   * reads always materialize the migration defaults when no valid values exist. */
  geometry?: Geometry
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
  /** BIRTH issue for the permanent human-facing nice name (#474). Set once at
   *  naming time and never changed — re-attaching to a different issue does NOT
   *  rename. null/absent = named in the DRAFT namespace (see refDraft). */
  refIssueId?: string | null
  /** Column letter allocated within refIssueId (`A`, `B`, … `POD-13-A`). */
  refLetter?: string | null
  /** Per-repo DRAFT ordinal for a truly issueless session (`POD-DRAFT-3`). */
  refDraft?: number | null
  /** Email-style read state (issue #124): ISO time the operator last opened this
   *  session; null/absent = never opened. Optional so pre-existing row literals stay valid. */
  readAt?: string | null
  /** OPTIONAL workflow-coordination pass-through metadata (#285 via #237
   *  [spec:SP-34d7 cross-harness]): stamped at spawn/assignment by an external
   *  coordinator, never interpreted by the substrate. Parent linkage rides
   *  spawnedBy ('session:<id>') — deliberately NOT duplicated here. */
  workflowRunId?: string | null
  workflowStepId?: string | null
  executionProfileId?: string | null
  /** Issue-lifecycle tombstone. Tombstoned rows are excluded from active session loads. */
  deletedAt?: string | null
  /** User-facing path that created the tombstone. */
  deletionSource?: SessionDeletionSource | null
  /** The issue deletion that produced this tombstone. Kept separate from issueId
   *  because cwd-derived member sessions may not have been explicitly attached. */
  deletedByIssueId?: string | null
}

/** One row of the machines table (token_hash is internal — not included here). */
export interface MachineRecord {
  id: string
  name: string
  hostname: string
  createdAt: string
  lastSeenAt: string
  /** Parsed machines.inventory_json (#222); absent until the daemon reports
   *  (or when the stored blob fails to parse — defensive). */
  inventory?: import('@podium/protocol').Inventory
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
  /** Soft-delete tombstone. The row and its tracker history remain recoverable. */
  deletedAt?: string | null
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
  /** User-assigned colour SLOT NAME [spec:SP-b4d1] ('rose' … 'lime', the palette
   *  in @podium/domain); null/absent = no colour = the neutral slate flow.
   *  Optional so pre-existing row literals stay valid. */
  color?: IssueColorSlot | null
  estimateMin: number | null
  needsHuman: boolean
  humanQuestion: string | null
  /** Agent-published human-facing panel, stored as raw JSON (parsed in IssueService).
   *  Optional so pre-existing row literals (tests, ingest) stay valid; absent = none. */
  panel?: string | null
  /** Whose intent this issue captures ('human' | 'agent'). Optional so pre-existing
   *  row literals stay valid; absent = 'human'. */
  origin?: string
  /** Who this issue is FOR ('human' | 'agent') — parallel to origin (#198). 'human'
   *  = a top-level item the human tracks; 'agent' = the agent's internal working
   *  detail, hidden from the top-level board. Optional so pre-existing row literals
   *  stay valid; absent = 'human'. */
  audience?: string
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

// ---- unified agent messaging (#237) [spec:SP-34d7] ----

export type MessageFromKind = 'operator' | 'superagent' | 'agent' | 'system'
export type MessageToKind = 'issue' | 'session' | 'operator'
export type MessageKind = 'message' | 'ack' | 'notification' | 'question'
export type MessageUrgency = 'fyi' | 'next-turn' | 'interrupt'
export type MessageLifecycle = 'wait' | 'wake'
export type MessageStatus = 'queued' | 'delivered' | 'expired' | 'cancelled'

/** One row in the unified `messages` table: the message AND its delivery
 *  ledger (status, delivered_at/to, acked_by are the ledger columns). */
export interface MessageRow {
  id: string
  /** = id for a new thread; replies inherit the original's threadId. */
  threadId: string
  inReplyTo: string | null
  fromKind: MessageFromKind
  fromSession: string | null
  /** Named system producer (for example `workflow` or `steward`). */
  fromName?: string | null
  /** Sender's issue at send time (agent senders). */
  fromIssue: string | null
  toKind: MessageToKind
  toId: string | null
  kind: MessageKind
  urgency: MessageUrgency
  lifecycle: MessageLifecycle
  body: string
  expiresAt: string | null
  createdAt: string
  status: MessageStatus
  deliveredAt: string | null
  /** The session that actually received it. */
  deliveredTo: string | null
  /** Ack message id (denormalized for the steward's suppression check). */
  ackedBy: string | null
  /** Chain-depth counter [spec:SP-34d7 brakes]: messages sent from a
   *  message-triggered turn carry trigger.hop + 1; past 5 lifecycle clamps to wait. */
  hop: number
  /** JSON record of the sender's REQUESTED axes when a clamp/brake downgraded
   *  them (`{"urgency":…,"lifecycle":…,"reason":…}`); null = delivered as asked. */
  clampedFrom: string | null
  /** When the stop-hook's ONE unacked-message reminder was issued (never repeats). */
  remindedAt: string | null
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

/** One accepted-but-not-yet-finished superagent turn. The JSON payload mirrors
 * the restart-stable portion of a headlessTurnRequest. */
export interface PendingSuperagentTurnRow {
  turnId: string
  threadId: string
  podiumSessionId: string
  payload: {
    agent: string
    model?: string
    effort?: string
    cwd: string
    prompt: string
    contextPrompt?: string
    systemPrompt?: string
    mcpConfig?: string
    allowedTools?: string[]
    permissionMode?: string
    resumeValue?: string
    sessionUuid?: string
    timeoutMs?: number
  }
  firstTurn: boolean
  createdAt: string
}

/** Raw user input persisted synchronously before context/session preparation. */
export interface QueuedSuperagentInputRow {
  inputId: string
  threadId: string
  text: string
  focus?: {
    view?: string
    worktreePath?: string
    issueId?: string
    focusedSessionId?: string
    visibleSessionIds?: string[]
    filePath?: string
  }
  createdAt: string
}
