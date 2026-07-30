/**
 * The ISSUE VOCABULARY LAYER — the enums and issue-owned detail shapes that both
 * the entity projections (`./issue.ts`) and the shared field groups
 * (`../fields/issue.ts`) are built from.
 *
 * WHY THIS FILE EXISTS (POD-1141). These definitions used to live in
 * `./issue.ts`, and `../fields/issue.ts` imported them from there and re-exported
 * them. That made the two files MUTUALLY DEPENDENT the moment the entity tried to
 * compose a field group back — and because these are zod schema VALUES evaluated
 * at module load, the failure is at RUNTIME, not at lint or typecheck:
 *
 *     TypeError: Cannot read properties of undefined (reading 'shape')
 *
 * POD-367 measured that and reverted rather than working around it. Splitting the
 * shared vocabulary into this leaf module removes the cycle by making the
 * dependency one-directional: BOTH `./issue.ts` and `../fields/issue.ts` import
 * from here, and neither imports the other.
 *
 * This follows the pattern `./issue-color.ts` already set, and the layout table
 * in `../../README.md` already names: `entities/` holds "entity aggregates AND
 * their field vocabularies".
 *
 * Everything below is MOVED VERBATIM — same members, same order, same
 * optionality, same `.default()`s and `.catch()`es. The move is byte-identical on
 * the wire, and both former homes RE-EXPORT every name so no import site outside
 * this package changes (`packages/protocol/src/messages/wire-golden.json` and
 * POD-360's export-surface registry are the proof).
 */

import { z } from 'zod'
import { ArtifactIdField, IssueIdField } from '../ids'
import { ISSUE_COLOR_SLOTS } from './issue-color'

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

