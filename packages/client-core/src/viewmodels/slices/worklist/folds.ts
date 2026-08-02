/**
 * POD-330/POD-1496 — worklist row PLACEMENT: which lane a row occupies once it
 * exists and has been ordered — the PINNED section, a project group, or one of
 * the two folds (snoozed, closed).
 *
 * The invariant: rows in, rows bucketed out. Never constructs a row and never
 * changes sibling order — the incoming order is preserved in every bucket
 * except the closed fold, which is history ordered by the moment of closing.
 */
import { isIssueDeferred, type IssueWire } from '@podium/model'
import {
  isClosedTopLevelIssue,
  issueAwaitingMerge,
  issueFinishedAt,
} from '../issues'
import { rowWaitingCount } from './row-attention'
import type { UnifiedIssueRow, UnifiedWorkRow } from './row-types'
import { SIDEBAR_FINISHED_GRACE_MS } from './visibility'

export interface PinnedWorkSplit {
  /** Pinned issue rows, in banded order — the PINNED section above all groups. */
  pinned: UnifiedWorkRow[]
  /** Everything else, ready for {@link groupUnifiedWorkRows}. */
  rest: UnifiedWorkRow[]
}

/**
 * PINNED section split (POD-166, R3): pinned issues MOVE out of their project
 * group into one section above all groups — Linear-favorites style, move not
 * copy. Unpinning drops the row back into its group's banded order. Input
 * order is preserved on both sides (pinned rows already float via band 0, so
 * the pinned list reads in the same banded creation order).
 */
export function splitPinnedWork(rows: UnifiedWorkRow[]): PinnedWorkSplit {
  const pinned: UnifiedWorkRow[] = []
  const rest: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'issue' && row.issue.pinned) pinned.push(row)
    else rest.push(row)
  }
  return { pinned, rest }
}

export interface UnifiedWorkGroup {
  key: string
  label: string
  rows: UnifiedWorkRow[]
  /** Actively deferred issues hidden behind the project's local disclosure. */
  snoozedRows: UnifiedIssueRow[]
  /** Settled top-level closures hidden behind the project's local disclosure. */
  closedRows: UnifiedIssueRow[]
}

/** Snoozed issues decay into the project-local fold. Pinned rows have already
 * been removed before grouping, and a returned-from-defer issue is not
 * currently snoozed, so both keep their existing top-of-list treatment. */
export function rowInSnoozedFold(row: UnifiedWorkRow, now: number): row is UnifiedIssueRow {
  return row.kind === 'issue' && isIssueDeferred(row.issue, now)
}

/** POD-183 / POD-293 fold membership. Live asks outrank structure: needs-you
 * and awaiting-merge keep their full row. Finished top-level closures offer
 * "Tuck away" without requiring a read stamp or idle sessions — those gates
 * were for auto-fold-on-read / auto-bury; manual tuck is the dismiss path.
 * A selected open finished row stays open until tuck, grace, or focus moves.
 * Pinned rows are removed before grouping, so pinning also wins. */

/** Has the operator dismissed this finished row into the fold? Read straight off
 *  the issue (POD-333): `tuckedAt` is SERVER state delivered to every client,
 *  so a second browser hydrates the same fold and a tuck here folds the row
 *  there. It used to be a per-browser ui-state key the server never saw. The
 *  pressing client sees it instantly through the outbox overlay, which paints
 *  `tuckedAt` over server truth until the mutation lands. */
function issueTucked(issue: IssueWire): boolean {
  return issue.tuckedAt != null
}

/** Finished-issue facts shared by fold membership and the tuck-away control.
 *  Selection is intentionally NOT here: selecting a done row must keep
 *  "Tuck away" visible; only fold placement cares about selection. Read and
 *  working-session state are also not here — closing the issue is enough to
 *  offer dismiss; an agent still winding down must not hide the control. */
function finishedIssueSettled(row: UnifiedWorkRow): row is UnifiedIssueRow {
  if (row.kind !== 'issue') return false
  const { issue } = row
  return (
    isClosedTopLevelIssue(issue) &&
    !issue.needsHuman &&
    !issueAwaitingMerge(issue) &&
    rowWaitingCount(row) === 0
  )
}

/** Eligibility for the closed fold BEFORE the operator's dismissal is consulted:
 *  a settled top-level closure with nothing still asked of the human. */
function closedFoldEligible(
  row: UnifiedWorkRow,
  selectedIssueId: string | null,
  selectedIssueWasFolded: boolean,
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  const { issue } = row
  // A selected closure keeps the lane it occupied when clicked: a settled folded
  // row stays folded, while an open finished row stays open until focus moves.
  return issue.id !== selectedIssueId || selectedIssueWasFolded
}

export function rowInClosedFold(
  row: UnifiedWorkRow,
  selectedIssueId: string | null,
  selectedIssueWasFolded = false,
  now: number = Date.now(),
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  // Explicit tuck always folds — even while the row is selected. Lane stickiness
  // ("selected open stays open until focus moves") only applies to passive
  // placement (grace auto-fold), not operator dismissal.
  if (issueTucked(row.issue)) return true
  if (!closedFoldEligible(row, selectedIssueId, selectedIssueWasFolded)) return false
  // POD-293: a freshly finished issue no longer drops into the fold the instant
  // it finishes — it stays a live "done" row carrying the tuck-away control, and
  // folds only once the operator dismisses it, or after the finished-grace
  // window tidies it away on its own so the live list can't accrete history.
  return now - issueFinishedAt(row.issue) > SIDEBAR_FINISHED_GRACE_MS
}

/** A finished issue held OPEN in the live list for the operator to dismiss
 *  (POD-293): settled and still inside the grace window, not yet tucked.
 *  Selection and read state do not hide the control — only tuck or grace does. */
export function rowAwaitsTuck(
  row: UnifiedWorkRow,
  _selectedIssueId: string | null = null,
  _selectedIssueWasFolded = false,
  now: number = Date.now(),
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  return !issueTucked(row.issue) && now - issueFinishedAt(row.issue) <= SIDEBAR_FINISHED_GRACE_MS
}

/**
 * Bucket unified WORK rows by repo (stable repoId when known, repoPath
 * otherwise — so the same repo on two machines/paths merges into one group).
 * Open-row and group order follow the incoming fixed creation order. Closed
 * rows deliberately ignore manual sort keys: the fold is a small history list,
 * ordered by the moment of closing, newest first.
 */
export function groupUnifiedWorkRows(
  rows: UnifiedWorkRow[],
  selectedIssueId: string | null = null,
  selectedIssueWasFolded = false,
  now: number = Date.now(),
): UnifiedWorkGroup[] {
  const groups: UnifiedWorkGroup[] = []
  const byKey = new Map<string, UnifiedWorkGroup>()
  for (const row of rows) {
    const key =
      row.kind === 'issue'
        ? (row.issue.repoId ?? row.issue.repoPath)
        : (row.worktree.repoId ?? row.worktree.repoPath)
    let group = byKey.get(key)
    if (!group) {
      const label =
        row.kind === 'worktree'
          ? row.worktree.repoName
          : row.issue.repoPath.split('/').pop() || row.issue.repoPath
      group = { key, label, rows: [], snoozedRows: [], closedRows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    if (rowInClosedFold(row, selectedIssueId, selectedIssueWasFolded, now)) {
      group.closedRows.push(row)
    } else if (rowInSnoozedFold(row, now)) {
      group.snoozedRows.push(row)
    } else group.rows.push(row)
  }
  for (const group of groups) {
    group.closedRows.sort((a, b) => issueFinishedAt(b.issue) - issueFinishedAt(a.issue))
  }
  return groups
}
