/**
 * The issue aggregate, its vocabularies, and its read projections — relocated
 * verbatim from `@podium/protocol`'s `messages/issues.ts` at POD-300. Field
 * names, order, optionality, `.default()`s and `.catch()`es are unchanged; the
 * move is byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`.
 *
 * Per ADR 4's representation policy the projections here stay DISTINCT types —
 * `IssueWire`, `IssueGraph`, `IssueCount`, `IssueStats`, `OrphanIssue` are
 * different reads of the same entity and are deliberately not collapsed into
 * one universal record on the way over.
 *
 * ---------------------------------------------------------------------------
 * RECORDED FOR THE ISSUES QUEUED BEHIND THIS ONE (docs/multi-user-readiness.md,
 * human decisions 2026-07-29). Recorded here, not implemented here.
 * ---------------------------------------------------------------------------
 *
 * 1. ENTITY-IN-ENTITY EMBED — `IssueWire.sessions: SessionMeta[]`.
 *
 *    This is THE embed ADR 4 D7's normalization law deletes, and §2 of the
 *    readiness doc names it by name: O(world) per change with one user, O(world
 *    × N) with N users each holding a different slice — and a nested child
 *    cannot be independently suppressed from a scoped feed, so de-nesting is a
 *    PREREQUISITE for scoped feeds rather than a perf fix.
 *
 *    This move does not harden it. `sessions` is relocated exactly as it was,
 *    referencing `SessionMeta` from `entities/session.ts` — a plain
 *    cross-module reference the de-nesting issue deletes by replacing the array
 *    with session ids (or dropping it entirely in favour of a replica-side
 *    join, D7.3). Nothing here reaches into the embedded shape, spreads it, or
 *    derives from it, so no new call site has to change when it goes.
 *
 *    The sibling `sessionSummary` is the DERIVED counterpart of the same
 *    relation and is computed server-side at serialization, never stored — D7's
 *    derivation locality, already satisfied. Same for `ready` / `blocked` /
 *    `deferred` / `childCount` / `childDoneCount` / `unread` / `gitState`.
 *
 *    (The second, much smaller embed is `panel.artifacts[]`, which is issue-
 *    owned detail rather than an independent entity, and `comments[]`, already
 *    DEPRECATED off the wire in favour of `commentCount` — the de-nesting this
 *    programme wants, done once already.)
 *
 * 2. ATTRIBUTION IS HALF OF A PAIR — `humanQuestionAskedBy`.
 *
 *    Relocated UNCHANGED: still `z.string().optional()`, still a SessionId,
 *    still server-authoritative. Per §3.1.3 A3 attribution becomes a PAIR —
 *    actor (which agent) and on-behalf-of (which human) — precisely so "did a
 *    person or an agent ask this?" stays answerable, which is the property this
 *    field exists to preserve. The on-behalf-of half is POD-1075's work.
 *
 *    FLAGGED FORWARD TO POD-304 (provenance envelope) AND POD-643: the
 *    placement of this field is now a decision that must accommodate TWO
 *    values, not one. The same applies to its cohort — `startedBySession`,
 *    `coordinatorSessionId`, `assignee`, `origin` ('human' | 'agent') — each of
 *    which names one actor today.
 *
 * 3. NO OWNER / VISIBILITY / GRANT / instance_id FIELD WAS ADDED. Those are
 *    POD-1075's model types and POD-1071's normative matrix columns; adding one
 *    here would break the byte-identical contract. `IssueWire` is a flat
 *    aggregate with no positional encoding, so they are purely additive later
 *    and the golden fixtures still pass unchanged. Multi-user is not
 *    multi-tenancy (ADR 1 D5) — nothing here carries an instance partition.
 *
 * 4. PER-USER STATE (§3.3, POD-1076): `readAt`, `unread`, `tuckedAt` and
 *    `deferUntil` are singletons here because that is what they are on the wire
 *    today (their own doc comments say "Global (single-operator)"). They become
 *    rows keyed `(userId, issueId)` — a RE-KEY, not a re-representation.
 */

import { ISSUE_FLAT_PROVENANCE_SHAPE } from '../provenance/envelope'
import {
  ArtifactIdField,
  IssueIdField,
  machineIdBlockedOnPOD318,
  RepoIdField,
  SessionIdField,
} from '../ids'
import { z } from 'zod'
import { ISSUE_COLOR_SLOTS } from './issue-color'
import { SessionMeta } from './session'

// ---------------------------------------------------------------------------
// Issue vocabularies
// ---------------------------------------------------------------------------

// Ordered lifecycle stages an issue moves through. [spec:SP-0078]
// Agent-proposed work is deliberately inert until an operator accepts it. [spec:SP-6144]
export const IssueStage = z.enum([
  'proposed',
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
])
export type IssueStage = z.infer<typeof IssueStage>
export const ISSUE_STAGES: IssueStage[] = [
  'proposed',
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
]

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

/** The 10 user-pickable issue colour SLOTS [spec:SP-b4d1] — stored/transmitted
 *  as the slot NAME, never a hex (the palette maps slots to full colouring
 *  schemes client-side).
 *
 *  Built FROM {@link ISSUE_COLOR_SLOTS} rather than restating the list. Before
 *  POD-300 this enum was a second hand-maintained copy in `@podium/protocol`
 *  (protocol could not import the domain package) with a drift test in
 *  apps/server pinning the two; now that both live in L0 the drift is
 *  structurally impossible, which is the whole point of "every entity defined
 *  once". Same members, same order — byte-identical. */
export const IssueColor = z.enum(ISSUE_COLOR_SLOTS)
export type IssueColor = z.infer<typeof IssueColor>

// ---------------------------------------------------------------------------
// Issue-owned detail
// ---------------------------------------------------------------------------

export const IssueSessionSummary = z.object({
  total: z.number().int().nonnegative(),
  byPhase: z.record(z.number().int().nonnegative()),
})
export type IssueSessionSummary = z.infer<typeof IssueSessionSummary>

export const IssueDepWire = z.object({ id: IssueIdField, type: z.string() })
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
  artifactId: ArtifactIdField.optional(),
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

/** Git status of a task's checkout [POD-98] — derived server-side at
 *  serialization (like `sessions`), never persisted. Two axes: the MERGE axis
 *  (`ahead` vs parentBranch — only meaningful on a private issue branch) and
 *  the TASK axis (`commits`/`dirtyOwn` — harness-attributed, the only truthful
 *  counters on a shared checkout like main or a long-lived project branch).
 *  Tolerant so payloads from newer peers parse rather than failing the issue. */
export const IssueGitState = z.object({
  /** ISO time of the last completed probe. */
  updatedAt: z.string(),
  /** A probe is in flight — clients render the stamp's loading shimmer. */
  computing: z.boolean().optional(),
  /** Branch the checkout is actually on (may differ from issue.branch). */
  branch: z.string().nullable(),
  /** True = multi-task checkout (repo root / long-lived branch): the merge
   *  axis is suppressed and only attributed counters render. */
  shared: z.boolean(),
  /** Merge axis: commits on branch not on parentBranch. Absent when shared. */
  ahead: z.number().int().optional(),
  /** Working-tree dirty file count (whole checkout). */
  dirtyFiles: z.number().int(),
  /** Task axis: dirty files ∩ this task's harness-observed touched files.
   *  Absent when the harness has no touched-file set (fallback mode). */
  dirtyOwn: z.number().int().optional(),
  /** Task axis: commit shas attributed to this task's sessions. */
  commits: z.array(z.string()).optional(),
  /** ISO committer date of the checkout's last commit. */
  lastCommitAt: z.string().optional(),
  /** Commits not yet on the upstream (@{u}..HEAD). Absent = no upstream. */
  unpushed: z.number().int().optional(),
  /** Branch fully contained in parentBranch (merge axis only). */
  merged: z.boolean().optional(),
  /** True when counters come from checkout-level fallback (no harness
   *  attribution available) — the UI discloses this in the hover. */
  fallback: z.boolean().optional(),
})
export type IssueGitState = z.infer<typeof IssueGitState>

// ---------------------------------------------------------------------------
// The issue wire/read projection
// ---------------------------------------------------------------------------

/** The issue fields that precede the provenance keys on today's wire (POD-304 —
 *  see `IssueWireEntity` / `IssueWire` below the shape). */
const IssueWireCore = z.object({
  id: IssueIdField,
  repoPath: z.string(),
  /** Stable repo identity (#74) — additive; consumers keep keying on repoPath. */
  repoId: RepoIdField.optional(),
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
  /** Technical handoff for agents; description remains the human summary. [spec:SP-6144] */
  brief: z.string().optional(),
  stage: IssueStage,
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  parentBranch: z.string(),
  defaultAgent: z.string(),
  // Model + reasoning-effort the issue's sessions launch with ('auto' = agent decides).
  defaultModel: z.string(),
  defaultEffort: z.string(),
  // Machine (daemon) this issue's agents run on; absent = pick by repo affinity.
  // CARVED OUT of the brand flip (ADR 1 Amendment 2 D16.2): resolvable to
  // LOCAL_MACHINE_ID = 'local' today, and a length-only brand would launder that
  // sentinel rather than flag it. POD-318 retires it, then this becomes MachineIdField.
  machineId: machineIdBlockedOnPOD318.optional(),
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),
  activityNotes: z.string().optional(),
  notesUpdatedAt: z.string().optional(),
  suggestedStage: IssueStage.optional(),
  suggestedReason: z.string().optional(),
  blockedBy: z.array(IssueIdField),
  dependencyNote: z.string().optional(),
  prUrl: z.string().optional(),
  priority: z.number().int(),
  type: IssueType,
  assignee: z.string().optional(),
  parentId: IssueIdField.optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  notes: z.string().optional(),
  dueAt: z.string().optional(),
  deferUntil: z.string().optional(),
  closedReason: z.string().optional(),
  /** When the closed-predicate last flipped true — the stable completion-decay
   *  anchor (updatedAt churns on any touch). [spec:SP-6144] */
  closedAt: z.string().optional(),
  /** Tuck-away (POD-293/POD-333): ISO time the operator dismissed this finished
   *  issue into the sidebar's Closed fold, or null while it has not been tucked.
   *  SERVER-side and GLOBAL (single-operator, like `readAt`) — the state used to
   *  live in each client's local ui-state, so it did not survive a different
   *  browser and two clients disagreed. Cleared server-side when the issue
   *  reopens, so a later close offers Tuck away again. Optional + tolerant so a
   *  pre-field cached payload (or a malformed value from a newer peer) parses as
   *  "not tucked" rather than failing the whole issue; a current server always
   *  sends it, explicitly null when untucked. */
  tuckedAt: z.string().nullable().optional().catch(undefined),
  supersededBy: IssueIdField.optional(),
  duplicateOf: IssueIdField.optional(),
  pinned: z.boolean(),
  /** Manual order (POD-168, POD-100 §4 R1): fractional sort key, lexicographic
   *  ASCENDING = top of the scope. One key space per sibling scope — a project
   *  group's top level, a parent's children, and PINNED sort independently.
   *  Absent = legacy row (sorts after keyed rows, in creation order). */
  sortKey: z.string().optional(),
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
   *  (legacy flag or a caller with no session identity).
   *
   *  ONE HALF OF AN ATTRIBUTION PAIR — see this file's header note 2. Relocated
   *  unchanged; §3.1.3 A3 makes attribution (actor, on-behalf-of), and the
   *  placement decision belongs to POD-304 / POD-643. */
  humanQuestionAskedBy: SessionIdField.optional(),
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
  /** ENTITY-IN-ENTITY EMBED — the one ADR 4 D7's normalization law deletes. See
   *  this file's header note 1: relocated as-is, deliberately not hardened. */
  sessions: z.array(SessionMeta),
  sessionSummary: IssueSessionSummary,
  /** Git status of the task's checkout [POD-98]. Absent = no checkout to probe
   *  (or a pre-field peer). Tolerant: malformed from a newer peer parses as
   *  unset rather than failing the whole issue. */
  gitState: IssueGitState.optional().catch(undefined),
})

/** The issue fields that follow the provenance keys on today's wire. Split out
 *  so `IssueWire` can compose head + provenance + tail and keep the historical
 *  key ORDER — zod emits keys in shape order, so appending the provenance group
 *  at the end would change the encoded bytes (POD-304). */
const IssueWireTail = z.object({
  /** Designated coordinator session (bare session id) for actionable issue-addressed
   *  mail routing. Claimable/changeable; dangling-tolerant if the session is later
   *  deleted. Absent/undefined = unset (today's idle-else-most-recent heuristic). */
  coordinatorSessionId: SessionIdField.optional(),
  /** Bare session id of the agent session that created this issue (started-by
   *  provenance). Null/absent for operator/human creates. Additive so pre-field
   *  payloads still parse. */
  startedBySession: z.string().optional(),
})

/**
 * The issue entity — PROVENANCE-FREE (POD-304 / ADR 4 D3.8). `viaHub`,
 * `upstreamStale` and `pendingSync` describe how a row reached a replica, not
 * the issue, so they live on the envelope (`provenance/envelope.ts`) and are
 * declared there ONCE for both entities instead of twice.
 */
export const IssueWireEntity = IssueWireCore.extend(IssueWireTail.shape)
export type IssueWireEntity = z.infer<typeof IssueWireEntity>

/**
 * The wire/read projection: entity + the FLAT provenance encoding today's wire
 * carries, spread at its historical MID-SHAPE position so `wire-golden.json`
 * still passes byte-for-byte. POD-308 nests the carrier; replica read sites go
 * through `provenanceOf` / `isViaHub` / `isUpstreamStale` / `isPendingSync` and
 * therefore do not change when it does.
 */
export const IssueWire = IssueWireCore.extend(ISSUE_FLAT_PROVENANCE_SHAPE).extend(
  IssueWireTail.shape,
)
export type IssueWire = z.infer<typeof IssueWire>

// ---------------------------------------------------------------------------
// Read projections over the issue graph — distinct types by ADR 4, not one
// universal record.
// ---------------------------------------------------------------------------

export const DuplicateCandidate = z.object({ a: z.string(), b: z.string(), score: z.number() })
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>

/**
 * The issue-identity members every read projection below opens with. Picked from
 * `IssueWireCore`, not restated (POD-367): one home for `id`'s brand and `seq`'s
 * integer constraint, and the pick MASK fixes the emitted key order, which is
 * what keeps these projections' JSON byte-stable (zod emits in shape order).
 */
const IssueRefHead = IssueWireCore.pick({ id: true, seq: true, title: true })

export const LintFinding = IssueRefHead.omit({ title: true }).extend({
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

/**
 * A node of the dependency graph. Picked from `IssueWireCore` (POD-367) —
 * previously a hand-restated eight-field copy.
 *
 * CROSS-BOUNDARY EDGES (docs/multi-user-readiness.md §3.1.2, handed to POD-290
 * still OPEN): an edge may name an issue the reader cannot see. The two candidate
 * answers are hiding the edge and showing an opaque "blocked by an issue you
 * cannot see" reference. BOTH remain expressible through this ONE projection
 * function and neither is chosen here:
 *  - hide-the-edge needs no shape at all — the authority omits the node and its
 *    edges from `IssueGraph`, and every member below is required, so a hidden
 *    node cannot be half-emitted;
 *  - opaque-reference needs an edge whose endpoint is withheld, which works because
 *    `IssueGraph` enforces NO referential integrity between `edges` and `nodes`,
 *    plus an id-only node via `IssueGraphNode.pick({ id: true })`.
 * What would preclude the second answer is adding a cross-field REFINEMENT — either
 * one enforcing edge/node integrity, or any refinement at all, since a refined
 * schema is a ZodEffects with no `.pick`, so the id-only narrowing would have to be
 * written as a second projection. Keep these plain object schemas.
 * (`IssueRefHead` is a shared *ref* head — id, seq, title — not an identity-only
 * one; an earlier revision of this comment claimed otherwise.)
 */
export const IssueGraphNode = IssueRefHead.extend(
  IssueWireCore.pick({
    stage: true,
    priority: true,
    type: true,
    ready: true,
    blocked: true,
  }).shape,
)
export const IssueGraphEdge = z.object({ from: z.string(), to: z.string(), type: z.string() })
export const IssueGraph = z.object({
  nodes: z.array(IssueGraphNode),
  edges: z.array(IssueGraphEdge),
})
export type IssueGraph = z.infer<typeof IssueGraph>

export const EpicStatus = IssueRefHead.pick({ id: true })
  .extend(IssueWireCore.pick({ childCount: true, childDoneCount: true }).shape)
  .extend({ complete: z.boolean() })
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
/**
 * An issue with no parent. Picked from `IssueWireCore` (POD-367) plus `ref`,
 * which is projection-local ON PURPOSE: it is the DERIVED display ref (prefix +
 * seq, D-5), and it is spelled `ref` here while `IssueWire` spells the same fact
 * `displayRef` — one of the D-1 name collisions. The rename is not corrected
 * here because this key is on the wire; it belongs in the one toWire pair.
 */
export const OrphanIssue = IssueRefHead.extend({
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
