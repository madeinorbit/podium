import {
  type IssueRow as CoreIssueRow,
  flattenRowGroups as coreFlattenRowGroups,
  issueRowsByStage as coreIssueRowsByStage,
  partitionIssueTree as corePartitionIssueTree,
} from '@podium/client-core/viewmodels'
import { ISSUE_STAGES, type IssueId, type IssueStage } from '@podium/model/browser'
import type { IssueViewModel } from '@/app/store'
import type { IssuesOrdering } from './issues-display'

/**
 * The hierarchical issue-tracker view (#85), typed for this app.
 *
 * THE DERIVATION ITSELF NOW LIVES IN CLIENT-CORE (POD-724). `partitionByParent`,
 * `partitionIssueTree`, `issueRowsByStage` and `flattenRowGroups` moved to
 * `@podium/client-core/viewmodels/issue-board-rows` unchanged, because the phone's
 * Tasks tab has to show the same rows in the same order and could not while they
 * were typed over `IssueViewModel`. What stays here is the `IssueViewModel`-shaped
 * façade — same names, same signatures, so no call site or test in this app
 * changed — plus the two derivations that genuinely read desktop-only fields.
 */

export { partitionByParent } from '@podium/client-core/viewmodels'

/** An issue reads as an epic when it's typed as one OR it actually has children. */
export function isEpic(issue: IssueViewModel): boolean {
  return issue.type === 'epic' || issue.childCount > 0
}

/** One visible list row for this app — the shared row shape at our issue type. */
export type IssueRow = CoreIssueRow<IssueViewModel>

/** Partition issues into top-level roots + children keyed by parent id. */
export function partitionIssueTree(issues: IssueViewModel[]): {
  roots: IssueViewModel[]
  childrenByParent: Map<string, IssueViewModel[]>
} {
  return corePartitionIssueTree(issues)
}

/**
 * Stage-grouped visible rows for the list view. Nested mode groups ROOTS by
 * their stage; an expanded root's children follow it, indented, regardless of
 * the child's own stage (its stage glyph disambiguates). `flatten` reproduces
 * the old flat view: every issue at depth 0 in its own stage group.
 */
export function issueRowsByStage(
  issues: IssueViewModel[],
  ordering: IssuesOrdering,
  opts: { flatten: boolean; expanded: ReadonlySet<string> },
): { stage: IssueStage; rows: IssueRow[] }[] {
  return coreIssueRowsByStage(issues, ordering, opts)
}

/** Flatten row groups into ids in visual order — the keyboard-nav basis. */
export function flattenRowGroups(groups: { rows: IssueRow[] }[]): IssueId[] {
  return coreFlattenRowGroups(groups)
}

/**
 * Per-parent counts of DIRECT children by stage, in `ISSUE_STAGES` order, only
 * stages with a count > 0. Feeds the board's epic-card stage chips: with
 * roots-only lanes an in-progress child appears in no lane, so the parent card
 * itself must say where its children stand.
 */
export function childStageCounts(
  issues: IssueViewModel[],
): Map<string, { stage: IssueStage; count: number }[]> {
  const { childrenByParent } = partitionIssueTree(issues)
  const out = new Map<string, { stage: IssueStage; count: number }[]>()
  for (const [parent, children] of childrenByParent) {
    const counts = ISSUE_STAGES.map((stage) => ({
      stage,
      count: children.filter((c) => c.stage === stage).length,
    })).filter((c) => c.count > 0)
    if (counts.length > 0) out.set(parent, counts)
  }
  return out
}

/**
 * The prev/next order for the issue page: the visible rows when the open issue
 * is among them, else the full flat order — a deep-linked issue whose parent is
 * collapsed (or a child opened from the roots-only board) still gets a working
 * navigator instead of a dead one.
 */
export function issuePageOrderIds(
  visibleIds: IssueId[],
  allIds: IssueId[],
  openId: IssueId,
): IssueId[] {
  return visibleIds.includes(openId) ? visibleIds : allIds
}
