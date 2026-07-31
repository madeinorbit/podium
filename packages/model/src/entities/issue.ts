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
 * 4. PER-USER STATE (§3.3), RE-KEYED BY POD-1076 — and note what did NOT change.
 *    `readAt`, `unread`, `tuckedAt` and `pinned` are still fields HERE, because
 *    this is the wire and the wire is byte-identical: it was a RE-KEY, not a
 *    re-representation. What moved is where the values come FROM — one
 *    `(userId, issueId)` row in `issue_user_state` per reader, joined at
 *    projection time via `IssueUserOverlay` — and they are no longer columns on
 *    `issues` or fields on `IssueRow` for anyone.
 *
 *    THE REMAINING GAP IS THE FEED, NOT THE SHAPE. A value that differs per
 *    reader cannot honestly be a field of a payload BROADCAST to many readers
 *    (ADR 2 D2's unscoped feed), so today these four carry one named viewer's
 *    values to every client. POD-1077's scoped feed closes that; the rows
 *    already have owners, so nothing here changes when it does.
 *
 *    `deferUntil` is deliberately NOT in this list: it is a claim about the WORK
 *    ("this cannot start before Tuesday"), identical for every viewer, and the
 *    defer/snooze split is settled in `../predicates/issue-stage.ts`.
 */

import { ISSUE_FLAT_PROVENANCE_SHAPE } from '../provenance/envelope'
import { IssueIdField, machineIdBlockedOnPOD318, RepoIdField, SessionIdField, UserIdField } from '../ids'
import { z } from 'zod'
import { SessionMeta } from './session'
import {
  IssueColor,
  IssueComment,
  IssueDepWire,
  IssueGitState,
  IssuePanel,
  IssueSessionSummary,
  IssueStage,
  IssueType,
} from './issue-vocabulary'
// The SHARED FIELD GROUPS (POD-365) that `IssueWire` is now composed from rather
// than restating. Importable only since POD-1141 split the vocabulary layer out:
// before that, `fields/issue.ts` imported this module, so reaching back for a
// group threw at module load. See `./issue-vocabulary.ts`.
import {
  IssueAgentDefaults,
  IssueConcurrency,
  IssueCoordination,
  IssueDerived,
  IssueGraphRefs,
  IssueIdentity,
  IssueLifecycle,
  IssueLinear,
  IssuePanelGroup,
  IssueText,
  IssueTriage,
  IssueWorkspace,
  NeedsHuman,
} from '../fields/issue'

/**
 * THE VOCABULARY LAYER MOVED OUT (POD-1141) — see `./issue-vocabulary.ts` for
 * why. Re-exported here, unchanged, so this module's export surface is exactly
 * what it was: every consumer that imported a vocabulary from `entities/issue`
 * still can, and POD-360's export-surface registry sees the same names.
 */
export * from './issue-vocabulary'

// ---------------------------------------------------------------------------
// The issue wire/read projection
// ---------------------------------------------------------------------------

/** The issue fields that precede the provenance keys on today's wire (POD-304 —
 *  see `IssueWireEntity` / `IssueWire` below the shape). */
const IssueWireCore = z.object({
  id: IssueIdentity.shape.id,
  repoPath: z.string(),
  /** Stable repo identity (#74) — additive; consumers keep keying on repoPath. */
  repoId: IssueIdentity.shape.repoId,
  /** Human-facing repo prefix (#474), e.g. `POD`. Absent until backfilled. */
  prefix: IssueDerived.shape.prefix,
  /** Human-facing issue reference (#474): `POD-13` (or `#13` before a prefix
   *  exists). Derived server-side; the single source for every render site.
   *  Optional on the wire so legacy/mock payloads still parse — read it through
   *  `issueDisplayRef()` which falls back to `#seq`. */
  displayRef: IssueDerived.shape.displayRef,
  seq: IssueIdentity.shape.seq,
  title: IssueText.shape.title,
  description: z.string(),
  /** Technical handoff for agents; description remains the human summary. [spec:SP-6144] */
  brief: IssueText.shape.brief,
  stage: IssueLifecycle.shape.stage,
  worktreePath: IssueWorkspace.shape.worktreePath,
  branch: IssueWorkspace.shape.branch,
  parentBranch: IssueWorkspace.shape.parentBranch,
  defaultAgent: IssueAgentDefaults.shape.defaultAgent,
  // Model + reasoning-effort the issue's sessions launch with ('auto' = agent decides).
  defaultModel: IssueAgentDefaults.shape.defaultModel,
  defaultEffort: IssueAgentDefaults.shape.defaultEffort,
  // Machine (daemon) this issue's agents run on; absent = pick by repo affinity.
  // CARVED OUT of the brand flip (ADR 1 Amendment 2 D16.2): resolvable to
  // LOCAL_MACHINE_ID = 'local' today, and a length-only brand would launder that
  // sentinel rather than flag it. POD-318 retires it, then this becomes MachineIdField.
  machineId: IssueWorkspace.shape.machineId,
  linearId: IssueLinear.shape.linearId,
  linearIdentifier: IssueLinear.shape.linearIdentifier,
  linearUrl: IssueLinear.shape.linearUrl,
  activityNotes: IssueText.shape.activityNotes,
  notesUpdatedAt: IssueText.shape.notesUpdatedAt,
  suggestedStage: IssueLifecycle.shape.suggestedStage,
  suggestedReason: IssueText.shape.suggestedReason,
  blockedBy: z.array(IssueIdField),
  dependencyNote: IssueText.shape.dependencyNote,
  prUrl: IssueLinear.shape.prUrl,
  priority: IssueTriage.shape.priority,
  type: IssueTriage.shape.type,
  // COMPOSED (POD-362), was a bare `z.string().optional()` between two composed
  // neighbours. Byte-identical either way, so no golden fixture could see the
  // fork — only `toBe` against this instance can.
  assignee: IssueTriage.shape.assignee,
  parentId: IssueGraphRefs.shape.parentId,
  design: IssueText.shape.design,
  acceptance: IssueText.shape.acceptance,
  notes: z.string().optional(),
  dueAt: IssueTriage.shape.dueAt,
  deferUntil: IssueLifecycle.shape.deferUntil,
  closedReason: IssueLifecycle.shape.closedReason,
  /** When the closed-predicate last flipped true — the stable completion-decay
   *  anchor (updatedAt churns on any touch). [spec:SP-6144] */
  closedAt: IssueLifecycle.shape.closedAt,
  /** Tuck-away (POD-293/POD-333): ISO time THIS READER dismissed the finished
   *  issue into the sidebar's Closed fold, or null while they have not tucked it.
   *  SERVER-side and PER-USER since POD-1076, keyed `(userId, issueId)` — it was
   *  GLOBAL (single-operator) before that, and before THAT it lived in each
   *  client's local ui-state, so it did not survive a different browser and two
   *  clients disagreed. Server-side storage fixed the durability; the re-key
   *  fixed the part that only looked fixed, because one operator's fold was
   *  everyone's. Cleared when the issue reopens, so a later close offers Tuck
   *  away again. Optional + tolerant so a
   *  pre-field cached payload (or a malformed value from a newer peer) parses as
   *  "not tucked" rather than failing the whole issue; a current server always
   *  sends it, explicitly null when untucked. */
  tuckedAt: z.string().nullable().optional().catch(undefined),
  supersededBy: IssueGraphRefs.shape.supersededBy,
  duplicateOf: IssueGraphRefs.shape.duplicateOf,
  pinned: z.boolean(),
  /** Manual order (POD-168, POD-100 §4 R1): fractional sort key, lexicographic
   *  ASCENDING = top of the scope. One key space per sibling scope — a project
   *  group's top level, a parent's children, and PINNED sort independently.
   *  Absent = legacy row (sorts after keyed rows, in creation order). */
  sortKey: IssueTriage.shape.sortKey,
  /** User-assigned colour slot [spec:SP-b4d1]; absent = no colour = the neutral
   *  slate flow. Additive + tolerant (an unknown value from a newer peer parses
   *  as unset rather than failing the whole issue). */
  color: IssueColor.optional().catch(undefined),
  estimateMin: IssueTriage.shape.estimateMin,
  needsHuman: NeedsHuman.shape.needsHuman,
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
  panel: IssuePanelGroup.shape.panel,
  labels: IssueTriage.shape.labels,
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
  archived: IssueLifecycle.shape.archived,
  /** Soft-delete tombstone. Present means hidden from active work but recoverable. */
  deletedAt: IssueLifecycle.shape.deletedAt,
  /** Email-style read state (issue #124). PER-USER since POD-1076 — the ISO time
   *  THIS READER last opened the issue, or null if they never opened it. Read
   *  from their `(userId, issueId)` row, not from the issue. */
  readAt: z.string().nullable().catch(null).default(null),
  // `unread` IS GONE from the wire [POD-797, taken from main at the POD-1246
  // catch-up]. It was server-DERIVED from the issue's own `updatedAt` joined
  // against its member sessions' `lastActiveAt` — i.e. a function of OTHER
  // entities, which is what made every session change dirty every issue payload.
  // The reader derives it now: `readAt` (per-user, still here) against the
  // sessions the client already holds. Removed rather than made optional so a
  // consumer that still reads it fails to compile instead of silently reading
  // `undefined` as "read".
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
  // THE ENTITY-IN-ENTITY EMBED IS GONE [POD-797, taken from main at the POD-1246
  // catch-up] — `sessions: SessionMeta[]` and its `sessionSummary` rollup. This
  // file's header note 1 called it "the one ADR 4 D7's normalization law
  // deletes"; this is that deletion. A session's `lastActiveAt` no longer dirties
  // an issue payload, which is the O(issues x sessions) rebuild the normalized
  // feed exists to remove. Membership is read from the SESSION side (`issueId`)
  // by a client that already holds the session list.
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
  /** THE AUTHORITY-ASSIGNED REVISION (ADR 2 D3) — link 3 of the expected-revision
   *  chain, recovered from main at the POD-1246 catch-up. Optional so pre-field
   *  payloads still parse; the field schema is `IssueConcurrency`'s, never a
   *  restated `z.number()`. Carried on the transitional legacy wire as well as on
   *  `IssueProjection` because the commands that echo it back as
   *  `expectedRevision` are served to both, and a client reading the legacy shape
   *  with no token can only send writes with no precondition. */
  revision: IssueConcurrency.shape.revision,
  /** Designated coordinator session (bare session id) for actionable issue-addressed
   *  mail routing. Claimable/changeable; dangling-tolerant if the session is later
   *  deleted. Absent/undefined = unset (today's idle-else-most-recent heuristic). */
  coordinatorSessionId: IssueCoordination.shape.coordinatorSessionId,
  /** Bare session id of the agent session that created this issue (started-by
   *  provenance). Null/absent for operator/human creates. Additive so pre-field
   *  payloads still parse. */
  // Branded by POD-362: the store row types this `SessionId` and its own doc
  // calls it a session id. `SessionIdField` (brand-only) so what parses is
  // unchanged — the field is additive and must keep accepting what it accepts.
  startedBySession: SessionIdField.optional(),
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

/** `a`/`b` are ISSUE IDS and compose `IssueIdentity.shape.id` (POD-362) — they
 *  were bare `z.string()`s, which is what forced `service/reads.ts` to cast. */
export const DuplicateCandidate = z.object({
  a: IssueIdentity.shape.id,
  b: IssueIdentity.shape.id,
  score: z.number(),
})
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
  /** Cycles and dangling edges are lists of ISSUE IDS; composed, not restated
   *  (POD-362). `type` stays a free string — it is a dep KIND, not an id. */
  cycles: z.array(z.array(IssueIdentity.shape.id)),
  danglingDeps: z.array(
    z.object({
      from: IssueIdentity.shape.id,
      to: IssueIdentity.shape.id,
      type: z.string(),
    }),
  ),
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
/** Endpoints are ISSUE IDS and compose the shared instance (POD-362). `type` is
 *  a dep kind, not an id, and stays a free string. */
export const IssueGraphEdge = z.object({
  from: IssueIdentity.shape.id,
  to: IssueIdentity.shape.id,
  type: z.string(),
})
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
  assignee: UserIdField.optional(),
  label: z.string().optional(),
  parentId: IssueIdField.optional(),
})
export type IssueSearchFilter = z.infer<typeof IssueSearchFilter>
