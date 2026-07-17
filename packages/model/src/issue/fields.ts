import { z } from 'zod'
import { Revision, Timestamp } from '../fields'
import { IssueId, MachineId, RepoId, SessionId } from '../ids'

/**
 * THE Issue vocabulary [ADR 4 D1: "Every entity field/concept has exactly one
 * authoritative definition in `packages/model`"].
 *
 * Every field below is defined ONCE — name, type, brand, nullability, meaning —
 * and every Issue representation (R1 aggregate, R3 storage row, R4 wire
 * projection) is composed from these groups. Nothing downstream may redeclare an
 * issue field with a fresh `z.string()`; that is the drift class ADR 4 exists to
 * kill, and it is an audit failure "even 'just for this module'".
 *
 * ## Nullability convention
 *
 * A field that can be unset is declared `.nullable()` HERE, in the semantic
 * truth. `null` is the vocabulary's one spelling of "no value". The wire's
 * absent-key spelling is derived mechanically by `wireShape()` — it is an
 * encoding, not a second meaning. See `../shape.ts`.
 *
 * ## Group membership
 *
 * Groups are semantic, not alphabetical: they are the unit at which a
 * representation opts in or out (D3.1 "Related keys form field groups"), and the
 * unit at which a new field propagates. The needs-human group is the worked
 * example ADR 4 D3.1 names explicitly.
 */

// ---------------------------------------------------------------------------
// Enumerations and structured values
// ---------------------------------------------------------------------------

/** Ordered lifecycle stages an issue moves through. [spec:SP-0078] */
export const IssueStage = z.enum(['backlog', 'planning', 'in_progress', 'review', 'done'])
export type IssueStage = z.infer<typeof IssueStage>
export const ISSUE_STAGES: readonly IssueStage[] = IssueStage.options

/** What KIND of work the issue is. */
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

/**
 * The 10 user-pickable issue colour SLOTS [spec:SP-b4d1] — stored and transmitted
 * as the slot NAME, never a hex (the palette maps a slot to a full colouring
 * scheme client-side, so schemes retune without touching stored data). Unset = no
 * colour = the neutral slate flow.
 *
 * Spectrum order is frozen design data. `@podium/domain`'s `ISSUE_COLOR_SLOTS`
 * and `@podium/protocol`'s `IssueColor` mirror this list today; POD-796 collapses
 * them onto this one, at which point the apps/server drift test that pins the two
 * existing copies together retires.
 */
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

/** Whose INTENT an issue captures, and who it is FOR. */
export const IssueActor = z.enum(['human', 'agent'])
export type IssueActor = z.infer<typeof IssueActor>

/**
 * Agent-published, human-facing issue panel (the right-sidebar "Issue" tab).
 * Distinct from the agent's internal todo list: agents intentionally publish this
 * so the HUMAN can see what is left, review artifacts, and decide deferrals.
 *
 * A structured value OWNED by the issue (not a separate entity): it has no
 * identity of its own, is never referenced from elsewhere, and is only ever read
 * or written as a whole with its issue. That is what makes it aggregate payload
 * rather than a D7.1 cross-entity reference.
 */
export const IssuePanelTodo = z.object({ text: z.string(), done: z.boolean() })
export type IssuePanelTodo = z.infer<typeof IssuePanelTodo>

export const IssuePanelArtifact = z.object({
  /** Path to the artifact file — absolute, or relative to the issue worktree. */
  path: z.string(),
  title: z.string().optional(),
  addedAt: Timestamp,
  /** Permanent-store snapshot id [spec:SP-0fc9]. Present ⇒ bytes are served from
   *  `<state-dir>/artifacts/<issueId>/<artifactId>/`; absent ⇒ legacy live route
   *  against the worktree. */
  artifactId: z.string().optional(),
  /** Relpath of the primary file inside the snapshot bundle. */
  entry: z.string().optional(),
  /** Bundle manifest — relpaths + sizes of every snapshotted file. */
  files: z.array(z.object({ path: z.string(), size: z.number() })).optional(),
})
export type IssuePanelArtifact = z.infer<typeof IssuePanelArtifact>

export const IssuePanelDeferred = z.object({ text: z.string(), addedAt: Timestamp })
export type IssuePanelDeferred = z.infer<typeof IssuePanelDeferred>

export const IssuePanel = z.object({
  todos: z.array(IssuePanelTodo).default([]),
  artifacts: z.array(IssuePanelArtifact).default([]),
  deferred: z.array(IssuePanelDeferred).default([]),
})
export type IssuePanel = z.infer<typeof IssuePanel>

// ---------------------------------------------------------------------------
// Field groups
// ---------------------------------------------------------------------------

/** Identity: what this issue IS and where it lives. */
export const issueIdentityFields = {
  /** Primary key. */
  id: IssueId,
  /** Display/lookup path of the issue's repo, maintained by the repo registry. */
  repoPath: z.string(),
  /** Stable repo identity (#74/#164) — the issue's repo KEY; repo-scoped reads and
   *  seq allocation key on it (UNIQUE(repo_id, seq)). Nullable only as defence in
   *  depth: the boot heal re-fills NULLs and every write resolves it. */
  repoId: RepoId.nullable(),
  /** Per-repo monotonic number; the `13` in `POD-13`. The human-facing `displayRef`
   *  is DERIVED from (repo prefix, seq) — see `wire.ts` on why it is not a field. */
  seq: z.number().int(),
} as const

/** Content: the prose a human or agent writes. */
export const issueContentFields = {
  title: z.string(),
  description: z.string(),
  /** Long-form design notes. */
  design: z.string().nullable(),
  /** Acceptance criteria. */
  acceptance: z.string().nullable(),
  /** Free-form notes. */
  notes: z.string().nullable(),
} as const

/** Classification: how the issue sorts, groups and renders. */
export const issueClassificationFields = {
  stage: IssueStage,
  type: IssueType,
  /** Lower sorts first. */
  priority: z.number().int(),
  /** Sticks to the top of its list. */
  pinned: z.boolean(),
  /** User-assigned colour slot [spec:SP-b4d1]; null = no colour = neutral slate flow. */
  color: IssueColor.nullable(),
  /** Estimated minutes of work; null = unestimated. */
  estimateMin: z.number().int().nullable(),
} as const

/** Workspace: where and how this issue's agents run. */
export const issueWorkspaceFields = {
  /** Checkout the issue's work happens in; null = no worktree yet. */
  worktreePath: z.string().nullable(),
  /** Branch the issue owns (issues own branches; sessions never do); null = none yet. */
  branch: z.string().nullable(),
  /** Branch this issue's branch is cut from and lands back onto. */
  parentBranch: z.string(),
  /** Agent CLI the issue's sessions launch with. */
  defaultAgent: z.string(),
  /** Model the issue's sessions launch with ('auto' = the agent decides). */
  defaultModel: z.string(),
  /** Reasoning effort the issue's sessions launch with ('auto' = the agent decides). */
  defaultEffort: z.string(),
  /** Machine (daemon) this issue's agents run on; null = pick by repo affinity. */
  machineId: MachineId.nullable(),
} as const

/** Linear mirror: set only for issues mirrored to/from Linear. */
export const issueLinearFields = {
  linearId: z.string().nullable(),
  linearIdentifier: z.string().nullable(),
  linearUrl: z.string().nullable(),
} as const

/**
 * Assistant digest: LLM-authored, advisory, never load-bearing. Written by
 * `IssueService.refreshAssistant`.
 */
export const issueAssistantFields = {
  /** LLM-written activity summary. */
  activityNotes: z.string().nullable(),
  notesUpdatedAt: Timestamp.nullable(),
  /** Stage the assistant thinks the issue should be in; a SUGGESTION — the human
   *  or agent still moves it. */
  suggestedStage: IssueStage.nullable(),
  suggestedReason: z.string().nullable(),
  /**
   * LLM-authored soft-dependency NOTES — free-form strings, often BRANCH names
   * rather than issue ids, surfaced verbatim. Deliberately NOT `IssueId[]`: this
   * is not the dependency graph. Real edges live in `issue_deps` and are their own
   * relation (out of this slice — see `wire.ts`).
   */
  blockedBy: z.array(z.string()),
  dependencyNote: z.string().nullable(),
} as const

/**
 * The needs-human group [ADR 4 D3.1 names this group explicitly; POD-304 places
 * the attribution here rather than on an envelope].
 *
 * The agent is blocked and is asking the operator a question. All five keys move
 * together: raising the flag sets the question and its attribution; answering
 * clears the group.
 */
export const issueNeedsHumanFields = {
  /** The agent is blocked awaiting a human answer. */
  needsHuman: z.boolean(),
  /** The question asked; null = flag raised with no question (legacy callers). */
  humanQuestion: z.string().nullable(),
  /** Structured suggested answers — the Tray's answer chips; null = free-form. */
  humanQuestionOptions: z.array(z.string()).nullable(),
  /** The agent session that asked; null = unattributed (legacy flag, or a caller
   *  with no session identity). A cross-entity reference, and therefore a branded
   *  id and nothing more [ADR 4 D7.1]. */
  humanQuestionAskedBy: SessionId.nullable(),
  /** When the flag was raised. */
  humanQuestionAskedAt: Timestamp.nullable(),
} as const

/** The agent-published human-facing panel; null = nothing published yet. */
export const issuePanelFields = {
  panel: IssuePanel.nullable(),
} as const

/** Graph and lifecycle: the issue's place among other issues, and its resolution. */
export const issueLifecycleFields = {
  /** Who is working it; null = unassigned. Not an id: a human or agent name. */
  assignee: z.string().nullable(),
  /** Parent in the issue tree; null = top level. */
  parentId: IssueId.nullable(),
  /** Why it closed; null = open, or closed without a reason. */
  closedReason: z.string().nullable(),
  /** The issue that replaced this one; null = not superseded. */
  supersededBy: IssueId.nullable(),
  /** The issue this one duplicates; null = not a duplicate. */
  duplicateOf: IssueId.nullable(),
  /** Pull request for the issue's branch; null = none opened. */
  prUrl: z.string().nullable(),
  /** Due date; null = no due date. */
  dueAt: Timestamp.nullable(),
  /** Hidden from ready work until this instant; null = not deferred. */
  deferUntil: Timestamp.nullable(),
} as const

/** Intent: whose issue this is and who it is for. */
export const issueIntentFields = {
  /** Whose INTENT this issue captures (issue-as-workspace). */
  origin: IssueActor,
  /** Who this issue is FOR (#198) — parallel to `origin`. 'human' = a top-level
   *  item the human tracks (always on the board); 'agent' = the agent's internal
   *  working detail, hidden from the top level and nested under its nearest
   *  human-audience ancestor. */
  audience: IssueActor,
  /** Placeholder-titled vessel created by the low-friction spawn flow; retitling
   *  clears it. Drafts show in the sidebar but not on the board. */
  draft: z.boolean(),
} as const

/** Bookkeeping: creation, mutation, archival, read state. */
export const issueBookkeepingFields = {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Archived issues are hidden from active work but keep their history. */
  archived: z.boolean(),
  /** Soft-delete tombstone; null = live. The row and its tracker history remain
   *  recoverable. */
  deletedAt: Timestamp.nullable(),
  /** Email-style read state (#124). Global (single-operator): when the operator
   *  last opened this issue; null = never opened. Durable — the DERIVED `unread`
   *  that reads it is a replica-side view, see `wire.ts`. */
  readAt: Timestamp.nullable(),
} as const

/**
 * Sync metadata [ADR 2 D3]. Durable, authority-assigned, and carried on the wire:
 * "Every durable entity gains a monotonic `revision` … carried on the wire
 * projection and on the change payload", and "POD-305 adds `revision` to the
 * entity tables it owns via a drizzle migration".
 *
 * It is in the vocabulary — and therefore on R1/R3/R4 — as of this slice; the
 * authority-side assignment, the column, and the `revision = 1` backfill are
 * POD-792's / POD-305's to land.
 */
export const issueSyncFields = {
  revision: Revision,
} as const

/**
 * THE durable Issue field set: every group, merged. This is the one key list for
 * the entity; R1, R3 and R4 all derive from it, so a field added to a group above
 * reaches every representation by construction (D3.3).
 */
export const issueDurableShape = {
  ...issueIdentityFields,
  ...issueContentFields,
  ...issueClassificationFields,
  ...issueWorkspaceFields,
  ...issueLinearFields,
  ...issueAssistantFields,
  ...issueNeedsHumanFields,
  ...issuePanelFields,
  ...issueLifecycleFields,
  ...issueIntentFields,
  ...issueBookkeepingFields,
  ...issueSyncFields,
} as const
