import { z } from 'zod'
import { SessionMeta } from './runtime-state'

// ---------------------------------------------------------------------------
// Issue tracker
// ---------------------------------------------------------------------------

// Ordered lifecycle stages an issue moves through. [spec:SP-0078]
export const IssueStage = z.enum(['backlog', 'planning', 'in_progress', 'review', 'done'])
export type IssueStage = z.infer<typeof IssueStage>
export const ISSUE_STAGES: IssueStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done']

export const IssueSessionSummary = z.object({
  total: z.number().int().nonnegative(),
  byPhase: z.record(z.number().int().nonnegative()),
})
export type IssueSessionSummary = z.infer<typeof IssueSessionSummary>

export const IssueType = z.enum([
  'task',
  'bug',
  'feature',
  'chore',
  'epic',
  'decision',
  'spike',
  'story',
  'milestone',
  'automation',
])
export type IssueType = z.infer<typeof IssueType>

export const ISSUE_DEP_TYPES = [
  'blocks',
  'related',
  'parent-child',
  'discovered-from',
  'tracks',
  'supersedes',
  'caused-by',
  'validates',
] as const

export const IssueDepWire = z.object({ id: z.string(), type: z.string() })
export type IssueDepWire = z.infer<typeof IssueDepWire>

export const IssueComment = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
export type IssueComment = z.infer<typeof IssueComment>

/** Agent-published, human-facing issue panel (right-sidebar "Issue" tab).
 *  Distinct from the agent's internal todo list: agents intentionally update
 *  this so the HUMAN can see what's left, review artifacts, decide deferrals. */
export const IssuePanelTodo = z.object({ text: z.string(), done: z.boolean() })
export type IssuePanelTodo = z.infer<typeof IssuePanelTodo>
export const IssuePanelArtifact = z.object({
  /** Path to the artifact file — absolute, or relative to the issue worktree. */
  path: z.string(),
  title: z.string().optional(),
  addedAt: z.string(),
  /** Permanent-store snapshot id ([spec:SP-0fc9] #441). Present ⇒ the bytes are
   *  served from `<state-dir>/artifacts/<issueId>/<artifactId>/` via the
   *  server-local /files/artifact route; absent (pre-existing entries) ⇒ legacy
   *  live /files/asset route against the worktree. */
  artifactId: z.string().optional(),
  /** Relpath of the primary file inside the snapshot bundle. */
  entry: z.string().optional(),
  /** Bundle manifest — relpaths + sizes of every snapshotted file. */
  files: z.array(z.object({ path: z.string(), size: z.number() })).optional(),
})
export type IssuePanelArtifact = z.infer<typeof IssuePanelArtifact>
export const IssuePanelDeferred = z.object({ text: z.string(), addedAt: z.string() })
export type IssuePanelDeferred = z.infer<typeof IssuePanelDeferred>
export const IssuePanel = z.object({
  todos: z.array(IssuePanelTodo).default([]),
  artifacts: z.array(IssuePanelArtifact).default([]),
  deferred: z.array(IssuePanelDeferred).default([]),
})
export type IssuePanel = z.infer<typeof IssuePanel>

/** The 10 user-pickable issue colour SLOTS [spec:SP-b4d1] — stored/transmitted
 *  as the slot NAME, never a hex (the palette maps slots to full colouring
 *  schemes client-side). Mirrors @podium/domain's ISSUE_COLOR_SLOTS (protocol
 *  stays dependency-free; a drift test in apps/server pins the two lists). */
export const IssueColor = z.enum([
  'rose',
  'pink',
  'fuchsia',
  'violet',
  'indigo',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
])
export type IssueColor = z.infer<typeof IssueColor>

export const IssueWire = z.object({
  id: z.string(),
  repoPath: z.string(),
  /** Stable repo identity (#74) — additive; consumers keep keying on repoPath. */
  repoId: z.string().optional(),
  /** Human-facing repo prefix (#474), e.g. `POD`. Absent until backfilled. */
  prefix: z.string().optional(),
  /** Human-facing issue reference (#474): `POD-13` (or `#13` before a prefix
   *  exists). Derived server-side; the single source for every render site.
   *  Optional on the wire so legacy/mock payloads still parse — read it through
   *  `issueDisplayRef()` which falls back to `#seq`. */
  displayRef: z.string().optional(),
  seq: z.number().int(),
  title: z.string(),
  description: z.string(),
  stage: IssueStage,
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  parentBranch: z.string(),
  defaultAgent: z.string(),
  // Model + reasoning-effort the issue's sessions launch with ('auto' = agent decides).
  defaultModel: z.string(),
  defaultEffort: z.string(),
  // Machine (daemon) this issue's agents run on; absent = pick by repo affinity.
  machineId: z.string().optional(),
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),
  activityNotes: z.string().optional(),
  notesUpdatedAt: z.string().optional(),
  suggestedStage: IssueStage.optional(),
  suggestedReason: z.string().optional(),
  blockedBy: z.array(z.string()),
  dependencyNote: z.string().optional(),
  prUrl: z.string().optional(),
  priority: z.number().int(),
  type: IssueType,
  assignee: z.string().optional(),
  parentId: z.string().optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  notes: z.string().optional(),
  dueAt: z.string().optional(),
  deferUntil: z.string().optional(),
  closedReason: z.string().optional(),
  supersededBy: z.string().optional(),
  duplicateOf: z.string().optional(),
  pinned: z.boolean(),
  /** User-assigned colour slot [spec:SP-b4d1]; absent = no colour = the neutral
   *  slate flow. Additive + tolerant (an unknown value from a newer peer parses
   *  as unset rather than failing the whole issue). */
  color: IssueColor.optional().catch(undefined),
  estimateMin: z.number().int().optional(),
  needsHuman: z.boolean(),
  humanQuestion: z.string().optional(),
  /** Structured suggested answers for `humanQuestion` (issue #53) — the Tray's
   *  answer chips. Absent = free-form question. Tolerant so a malformed value
   *  from a newer peer parses as unset rather than failing the whole issue. */
  humanQuestionOptions: z.array(z.string()).optional().catch(undefined),
  /** sessionId of the agent session that asked (issue #53); absent = unattributed
   *  (legacy flag or a caller with no session identity). */
  humanQuestionAskedBy: z.string().optional(),
  /** ISO time the needs-human flag was raised (issue #53). */
  humanQuestionAskedAt: z.string().optional(),
  /** Agent-published human-facing panel; absent = nothing published yet. */
  panel: IssuePanel.optional(),
  labels: z.array(z.string()),
  deps: z.array(IssueDepWire),
  dependents: z.array(IssueDepWire),
  /** DEPRECATED (#175): comment bodies left the wire — fetch them lazily via the
   *  `issues.comments` proc. Kept optional (never populated by a current server)
   *  so pre-#175 payloads (cached snapshots, older hubs) still parse; consumers
   *  treat absence as "no embedded comments" and read `commentCount` instead. */
  comments: z.array(IssueComment).optional(),
  /** Number of comments on the issue (#175) — the cheap wire stand-in for the
   *  removed `comments` array. Optional so pre-#175 payloads parse; absent ⇒
   *  fall back to `comments?.length ?? 0`. */
  commentCount: z.number().int().optional(),
  ready: z.boolean(),
  blocked: z.boolean(),
  deferred: z.boolean(),
  childCount: z.number().int(),
  childDoneCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  /** Soft-delete tombstone. Present means hidden from active work but recoverable. */
  deletedAt: z.string().optional(),
  /** Email-style read state (issue #124). Global (single-operator) — the ISO time
   *  the operator last opened this issue, or null if never opened. */
  readAt: z.string().nullable().catch(null).default(null),
  /** Server-DERIVED: there is activity newer than `readAt` — the issue's most
   *  recent activity (latest of updatedAt / member-session lastActiveAt) postdates
   *  `readAt`, or `readAt` is null and the issue has ever had activity. Defaulted so
   *  a pre-field cached payload still validates (unread → false). */
  unread: z.boolean().catch(false).default(false),
  /** Whose INTENT this issue captures (issue-as-workspace). Defaulted at parse
   *  so pre-field cached payloads still validate. */
  origin: z.enum(['human', 'agent']).catch('human').default('human'),
  /** Who this issue is FOR (issue #198) — parallel to `origin`. 'human' = a
   *  top-level item the human tracks (always on the board); 'agent' = the agent's
   *  internal working detail, hidden from the top level and nested under its
   *  nearest human-audience ancestor. Defaulted at parse so pre-field cached
   *  payloads still validate (→ 'human', i.e. visible — nothing vanishes). */
  audience: z.enum(['human', 'agent']).catch('human').default('human'),
  /** Draft = placeholder-titled vessel created by the low-friction spawn flow;
   *  retitling clears it. Drafts show in the sidebar but not on the board. */
  draft: z.boolean().catch(false).default(false),
  // Derived server-side at serialization (not persisted):
  sessions: z.array(SessionMeta),
  sessionSummary: IssueSessionSummary,
  /** True for an issue mirrored FROM this node's upstream hub (node⇄hub issues,
   *  docs/spec/node-hub-issues.md §2.1) — stamped at ingest, never on local
   *  issues. Derived fields (ready/blocked/deps) arrive hub-computed. Additive:
   *  absent = a local issue, today's behavior. */
  viaHub: z.boolean().optional(),
  /** True when this viaHub entry is last-known state from an UNREACHABLE hub —
   *  retained, not blanked (same semantics as SessionMeta.upstreamStale). Only
   *  ever set alongside viaHub. */
  upstreamStale: z.boolean().optional(),
  /** True while a node-side edit of this viaHub issue sits queued in the node's
   *  upstream outbox (hub unreachable) — the value shown is the node's optimistic
   *  patch; the hub's next delta/snapshot overwrites with truth and clears this
   *  (docs/spec/node-hub-issues.md §2.2). Only ever set alongside viaHub. */
  pendingSync: z.boolean().optional(),
  /** Designated coordinator session (bare session id) for actionable issue-addressed
   *  mail routing. Claimable/changeable; dangling-tolerant if the session is later
   *  deleted. Absent/undefined = unset (today's idle-else-most-recent heuristic). */
  coordinatorSessionId: z.string().optional(),
  /** Bare session id of the agent session that created this issue (started-by
   *  provenance). Null/absent for operator/human creates. Additive so pre-field
   *  payloads still parse. */
  startedBySession: z.string().optional(),
})
export type IssueWire = z.infer<typeof IssueWire>

export const DuplicateCandidate = z.object({ a: z.string(), b: z.string(), score: z.number() })
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>

export const LintFinding = z.object({
  id: z.string(),
  seq: z.number().int(),
  findings: z.array(z.string()),
})
export type LintFinding = z.infer<typeof LintFinding>

export const DoctorReport = z.object({
  cycles: z.array(z.array(z.string())),
  danglingDeps: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
  lintCount: z.number().int(),
  staleCount: z.number().int(),
})
export type DoctorReport = z.infer<typeof DoctorReport>

export const IssueGraphNode = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  stage: IssueStage,
  priority: z.number().int(),
  type: IssueType,
  ready: z.boolean(),
  blocked: z.boolean(),
})
export const IssueGraphEdge = z.object({ from: z.string(), to: z.string(), type: z.string() })
export const IssueGraph = z.object({
  nodes: z.array(IssueGraphNode),
  edges: z.array(IssueGraphEdge),
})
export type IssueGraph = z.infer<typeof IssueGraph>

export const EpicStatus = z.object({
  id: z.string(),
  childCount: z.number().int(),
  childDoneCount: z.number().int(),
  complete: z.boolean(),
})
export type EpicStatus = z.infer<typeof EpicStatus>

export const IssueCount = z.object({
  byStage: z.record(z.number()),
  byPriority: z.record(z.number()),
  byType: z.record(z.number()),
  byAssignee: z.record(z.number()),
})
export type IssueCount = z.infer<typeof IssueCount>
export const IssueStats = z.object({
  total: z.number().int(),
  open: z.number().int(),
  closed: z.number().int(),
  ready: z.number().int(),
  blocked: z.number().int(),
  deferred: z.number().int(),
})
export type IssueStats = z.infer<typeof IssueStats>
export const OrphanIssue = z.object({
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  ref: z.string(),
})
export type OrphanIssue = z.infer<typeof OrphanIssue>
export const IssueSearchFilter = z.object({
  repoPath: z.string().optional(),
  text: z.string().optional(),
  status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
  stage: IssueStage.optional(),
  priority: z.number().int().optional(),
  type: IssueType.optional(),
  assignee: z.string().optional(),
  label: z.string().optional(),
  parentId: z.string().optional(),
})
export type IssueSearchFilter = z.infer<typeof IssueSearchFilter>

export const IssuesChangedMessage = z.object({
  type: z.literal('issuesChanged'),
  issues: z.array(IssueWire),
})
export const IssueUpdatedMessage = z.object({
  type: z.literal('issueUpdated'),
  issue: IssueWire,
})

// Agent relay: an agent's daemon forwards a router/proc op (a tRPC-style call for
// issues, messages, sessions, specs, workflows, locks, approvals, …) up to the
// server, which runs it against the shared backend and returns the result.
// Request is daemon→server; result is server→daemon.
export const AgentRelayRequestMessage = z.object({
  type: z.literal('agentRelayRequest'),
  requestId: z.string(),
  sessionId: z.string(),
  router: z.string(),
  proc: z.string(),
  input: z.unknown().optional(),
  outsideScope: z.boolean().optional(),
})
export const AgentRelayResultMessage = z.object({
  type: z.literal('agentRelayResult'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

/** How long the loopback agent-relay hub holds a request open for procs that
 *  legitimately BLOCK server-side, before giving up with `agent relay timed out`
 *  [POD-854]. The urgency-gated blocking send waits up to the server's
 *  INTERRUPT_DELIVERY_CEILING_MS (90s) for a transcript-observed confirmation; if
 *  the transport gives up first, the agent's `podium mail send` THROWS before the
 *  gate can return its honest `delivered`/`accepted`, the sender resends, and we
 *  get the duplicate delivery the milestone exists to kill. This must exceed that
 *  ceiling with margin (the normal-RPC hub timeout stays 30s). Shared here so the
 *  daemon transport and the server's budget invariant agree on one number. */
export const AGENT_RELAY_BLOCKING_TIMEOUT_MS = 120_000
