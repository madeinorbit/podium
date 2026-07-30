/**
 * Row/domain types shared by the per-aggregate repositories (store/*.ts) and
 * re-exported from `../store` so existing importers keep working.
 */

import type {
  Geometry,
  IssueColorSlot,
  IssueId,
  PinKind as ModelPinKind,
  RepoId,
  SessionId,
  UserId,
} from '@podium/model'
import type { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'

/** ALIASES @podium/model's PinKind (POD-380). The three literals had four
 *  declarations — here, router.ts, the presence contract and the model family — and
 *  a set of literals is exactly the kind of vocabulary that drifts silently when one
 *  copy gains a member. L0 owns it; this is the name the server reads it by. */
export type PinKind = ModelPinKind

export interface PinState {
  panels: string[]
  worktrees: string[]
  repos: string[]
}

/** sessionId → snooze deadline. `null` = until next message; ISO = timed. */
export type SnoozeMap = Record<string, string | null>

/** One agent action offer [spec:SP-c7f1] — decoded from the `offers` row. */
export interface OfferRecord {
  message: string
  actions: { label: string; prompt: string; input?: boolean }[]
  /** Issue-artifact paths the offer names as evidence [POD-120]; absent = none. */
  artifacts?: string[]
  createdAt: string
}
/** sessionId → its live offer. */
export type OfferMap = Record<string, OfferRecord>

export type SessionStatusPersisted = 'starting' | 'live' | 'reconnecting' | 'hibernated' | 'exited'
export type SessionDeletionSource = 'issue' | 'standalone'

/** Durable observer lease plus the last accepted causal checkpoint. */
export interface ObservationLeaseRecord {
  sessionId: string
  provider: ObservationProvider
  providerSessionId: string | null
  bindingVersion: number
  observationGeneration: number
  checkpoint: SessionObservationCheckpointV1 | null
  updatedAt: string
}

export interface TerminalCandidateFacts {
  schemaVersion: 1
  sessionId: string
  terminalTransitionId: string
  terminalTurnEpoch: number
  provider: ObservationProvider
  providerSessionId: string | null
  bindingVersion: number
  observerGeneration: number
  providerCursor: import('@podium/protocol').ProviderCursor
  lastLiveReceiptAt: string | null
  lastTransitionId: string | null
  lastActiveAt: string
  lastInputAtMs: number
  lastOutputAtMs: number
  lastResumedAtMs: number
  inputCount: number
  outputCount: number
  activityCount: number
  queuedInputCount: number
  pendingMessages: Array<{
    id: string
    status: string
    deliveredAt: string | null
    injectedAt: string | null
    ackedBy: string | null
  }>
  autoContinueActive: boolean
  activeWork: {
    nativeSubagentCount: number
    nativeSubagentIds: string[]
    awaitingSubagents: boolean
    childSessions: Array<{ sessionId: string; status: string; activityCount: number }>
    queueDrainActive: boolean
    draftPending: boolean
    draftVersion: string | null
    offerPending: boolean
  }
  resumable: boolean
  machineId: string
}

export interface TerminalCandidateRecord {
  facts: TerminalCandidateFacts
  firstLivePollSequence: number
  lastLivePollSequence: number
  confirmedAt: string | null
  consumedAt: string | null
  updatedAt: string
}

/** One persisted session row. camelCase mirror of the snake_case `sessions` table. */
export interface SessionRow {
  id: string
  agentKind: string
  /** Resolved launch configuration captured on the session at spawn [spec:SP-dae6]. */
  model?: string | null
  effort?: string | null
  /** Account selection, not credential material. */
  accountId?: string | null
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
  /** Daemon-reported reason a spawn never started; null for ordinary exits. */
  spawnFailure?: string | null
  durableLabel: string
  /** Last authoritative PTY grid. Optional only for legacy/test callers; repository
   * reads always materialize the migration defaults when no valid values exist. */
  geometry?: Geometry
  createdAt: string
  lastActiveAt: string
  /** Completed working/compacting time in milliseconds; absent for legacy rows. */
  workingMsTotal?: number | null
  inputCount?: number
  outputCount?: number
  activityCount?: number
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
  /** Durable terminal-transition metadata for completion decay. [spec:SP-6144] */
  stoppedAt?: string | null
  stopReason?: 'self' | 'parent' | 'forced' | 'exited' | null
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
  inventory?: import('@podium/model').Inventory
}

/**
 * One row of the `issues` table (camelCase mirror; `blockedBy` stored as JSON text).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HAND-WRITTEN, AND WHAT NOW BRIDGES IT — inventory §3 #2.
 * ---------------------------------------------------------------------------
 *
 * This is R3: the encoding, not the vocabulary. It is bridged to R1 by the ONE
 * documented `toStorage` / `fromStorage` pair in `./issue-storage.ts` (ADR 4
 * §4.1), landed by POD-1151 — which is what the analysis below (measured at
 * POD-1141) asked for. Read that file before changing a member here: adding a
 * column without a mapping is what the pair exists to make impossible, and
 * `issue-storage.test.ts` is what fails when you do.
 *
 * A `Pick` of the aggregate does not typecheck, and neither does a mapped-type
 * derivation, because the divergence is not a uniform transform:
 *
 *   - `stage`, `type` are `string` here, `IssueStage` / `IssueType` enums on the
 *     group — the row deliberately stores unvalidated text.
 *   - `panel` is `string | null` here (RAW JSON), `IssuePanel` (an object) there.
 *   - the aggregate RENAMES three facts this row predates: `blockedBy` ->
 *     `blockedByNotes`, `origin` -> `intentOrigin`, `draft` -> `isDraftVessel`.
 *   - `description` / `notes` are plain strings here and `IssueDocuments`
 *     op-stream documents there.
 *   - optionality is historical, not derivable: `linearId: string | null` is a
 *     required key while `brief?: string | null` is optional, for no reason a
 *     transform could infer.
 *
 * A per-key transform table encoding all of that would be as long as this
 * interface and harder to read — a restatement in a worse form, not a deletion
 * of one. And it would protect nothing: a mapped type is checked structurally,
 * so it cannot notice two type-identical members being DIFFERENT FACTS.
 *
 * So the answer was the mapper, and it exists: `StoredIssue` in
 * `./issue-storage.ts` composes the R1 side from `IssueAggregate` (every retained
 * key is the SHARED SCHEMA INSTANCE, asserted with `toBe`), and the pair maps it
 * to and from this shape PER KEY. Its callers are `IssueService.toWire` (which
 * decodes a row once and projects R1 -> R4, instead of performing every split
 * inline) and `IssueService.create` (which builds R1 and encodes once).
 *
 * WHAT THIS ROW STILL IS THAT R1 IS NOT, and who owns closing it:
 *   - `readAt` / `tuckedAt` / `pinned` are PER-USER state. POD-1076 moves them to
 *     `(userId, issueId)` rows; the aggregate's `registry.test.ts` fails if one
 *     reappears on R1, so they cannot simply be added there.
 *   - `repoPath` is DERIVED (inventory D-1) and lives on `IssueDerived`.
 *   - there is no column for `owner`, `visibility`, `createdBy`,
 *     `lastLifecycleActor` or the `attribution` half of the needs-human `asked`
 *     group. POD-1075 owns those; `docs/multi-user-readiness.md` is explicit that
 *     they are a table migration plus a wire change plus a replica migration.
 *
 * Until BOTH land, `IssueAggregate` cannot be the service's in-memory type —
 * `Map<string, IssueRow>` in `service/core.ts` reads all four of the excluded
 * classes. That is a measured blocker, not a deferral.
 *
 * THE MUTANT THAT PROVES THE PAIR, and its result: swapping `origin` and
 * `audience` in `toStorage` (both `string`, both 'human' | 'agent', type-
 * identical and byte-identical — the class no golden fixture can see) reddens
 * "round-trips intentOrigin and audience to their OWN columns". Re-derive the
 * pattern from the current file before re-running it.
 */
export interface IssueRow {
  id: IssueId
  repoPath: string
  /** Stable repo identity (#74/#164) — the issue's repo KEY: repo-scoped reads
   *  and seq allocation key on it (UNIQUE(repo_id, seq)). repoPath remains the
   *  display/lookup attribute maintained by the repo registry. Nullable only as
   *  defense in depth (the boot heal re-fills NULLs; every write resolves it). */
  repoId?: RepoId | null
  seq: number
  title: string
  description: string
  /** Agent-facing technical handoff, separate from the human summary. [spec:SP-6144] */
  brief?: string | null
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
  assignee: UserId | null
  parentId: IssueId | null
  design: string | null
  acceptance: string | null
  notes: string | null
  dueAt: string | null
  deferUntil: string | null
  closedReason: string | null
  /** When the closed-predicate last flipped true; null while open. [spec:SP-6144] */
  closedAt: string | null
  /** Tuck-away (POD-333): ISO time the operator dismissed this finished issue into
   *  the sidebar's Closed fold; null/absent = not tucked. Global like readAt, and
   *  cleared whenever the closed predicate flips back open. Optional so
   *  pre-existing row literals stay valid. */
  tuckedAt?: string | null
  supersededBy: IssueId | null
  duplicateOf: IssueId | null
  pinned: boolean
  /** Manual order (POD-168): fractional sort key, ascending = top of the row's
   *  sibling scope. Optional so pre-existing row literals stay valid; null/
   *  absent = legacy row (sorts after keyed siblings). */
  sortKey?: string | null
  /** User-assigned colour SLOT NAME [spec:SP-b4d1] ('rose' … 'lime', the palette
   *  in @podium/model); null/absent = no colour = the neutral slate flow.
   *  Optional so pre-existing row literals stay valid. */
  color?: IssueColorSlot | null
  estimateMin: number | null
  needsHuman: boolean
  humanQuestion: string | null
  /** Structured suggested answers for `humanQuestion` (issue #53) — the Tray's
   *  answer chips. Optional so pre-existing row literals stay valid; null/absent
   *  = free-form question (no chips). */
  humanQuestionOptions?: string[] | null
  /** sessionId of the agent session that asked (issue #53); null/absent =
   *  unattributed (legacy flag or non-session caller). */
  humanQuestionAskedBy?: SessionId | null
  /** ISO time the needs-human flag was raised (issue #53). */
  humanQuestionAskedAt?: string | null
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
  /** Designated coordinator session (bare session id) — actionable issue-addressed
   *  mail prefers this when live. Claimable/changeable; dangling-tolerant (no FK).
   *  Optional so pre-existing row literals stay valid; null/absent = unset. */
  coordinatorSessionId?: SessionId | null
  /** Bare session id of the agent that created this issue (started-by provenance).
   *  Null for operator/human creates. Dangling-tolerant. Optional so pre-existing
   *  row literals stay valid. */
  startedBySession?: SessionId | null
}

export interface IssueCommentRow {
  id: string
  issueId: IssueId
  author: string
  body: string
  createdAt: string
}

/** One "agent mail" message addressed to an ISSUE (issue #103). Status lifecycle:
 *  unread → read (inbox listing) → claimed (an agent committing to act on it). */
export interface IssueMessageRow {
  id: string
  issueId: IssueId
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
/** The message delivery lifecycle [spec:SP-34d7, POD-834] — an honest, sender-
 *  queryable position, NOT "did the CLI accept it":
 *   - `queued`      captured + durably waiting for a valid, reachable target;
 *   - `delivered`   its envelope appeared as a turn in the target's transcript
 *                   (PUSH confirmed by transcript echo) — the agent has it in context;
 *   - `read`        the recipient opened its inbox and consumed it (PULL confirmed);
 *   - `dead_letter` the target was gone before it could land (told the sender once);
 *   - `expired`     the queued TTL passed without delivery;
 *   - `cancelled`   withdrawn.
 *  `delivered` used to fire on mere enqueue — that lie (POD-495 defect B, 70 lost
 *  POD-279 messages) is what this redefinition kills. */
export type MessageStatus =
  | 'queued'
  | 'delivered'
  | 'read'
  | 'dead_letter'
  | 'expired'
  | 'cancelled'

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
  /** When status reached `delivered` — the transcript echo, NOT the enqueue. */
  deliveredAt: string | null
  /** The session that actually received it (set on inject; confirmed at delivered). */
  deliveredTo: string | null
  /** When status reached `read` — the recipient opened its inbox (PULL path). */
  readAt?: string | null
  /** When the message was last dispatched toward a live PTY (bytes typed). An
   *  INTERNAL cursor, not a sender-facing state: the row stays `queued` until an
   *  echo confirms `delivered`. Drives auto-requeue — an injected row with no echo
   *  within the window was a ghost push and is re-attempted [POD-834]. */
  injectedAt?: string | null
  /** When status reached `dead_letter` — the target was gone. */
  deadLetteredAt?: string | null
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
  /** Notification-arbiter identity [spec:SP-ba61]. Reading or dismissing a
   *  message with both fields retires its live fact; ordinary messages are null. */
  factKey?: string | null
  factTarget?: string | null
  /** A response is OPT-IN [POD-835 §04b]: true only for a `--expect-response` send
   *  or a `question`. Receipt is mechanically proven by the ledger (POD-834), so an
   *  ordinary message owes no reply and generates no ack traffic; this flag is the
   *  SOLE trigger for the stop-hook reminder and the steward settle-nag. `ack` and
   *  `notification` never set it — an ack is never itself ackable. Optional in TS
   *  (the column is NOT NULL DEFAULT 0; a missing field reads as false). */
  expectsResponse?: boolean
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
