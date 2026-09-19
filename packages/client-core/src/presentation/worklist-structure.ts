import { issueReturnedFromDefer, isIssueDeferred, type IssueId } from '@podium/model'
import {
  issueClosedFoldAt,
  rowInClosedFold,
  rowInSnoozedFold,
  splitPinnedWork,
  type UnifiedWorkGroup,
} from '../viewmodels/slices/worklist/folds'
import { unifiedRowBand } from '../viewmodels/slices/worklist/row-order'
import { rowWaitingCount } from '../viewmodels/slices/worklist/row-attention'
import type { UnifiedWorkRow } from '../viewmodels/slices/worklist/row-types'
import {
  isClosedTopLevelIssue,
  issueAbandoned,
  issueAwaitingMerge,
} from '../viewmodels/slices/issues'

/**
 * E4 — WORKLIST STRUCTURE (pilot only, no consumer, no dependency).
 *
 * Stable row ids and group membership SEPARATELY from per-row display values
 * and from selection/focus state. The legacy arm (`groupUnifiedWorkRows` over
 * the whole list) rebuilds every group object on any change, including a pure
 * selection change; this layer reuses per-group identity so a selection change
 * rebuilds no sections and a non-ranking row change regenerates no groups.
 *
 * MEMBERSHIP/ORDER FIELDS (a change here MAY move the row; everything else is
 * display-only and must not regenerate any group):
 * - group key: issue `repoId ?? repoPath`, worktree `repoId ?? repoPath`
 * - band/order: `pinned`, `deferUntil` vs now (deferred band 2,
 *   returned-from-defer band 0), manual `sortKey`, `createdAt`, `seq`, id tiebreak
 * - snoozed fold: `deferUntil` vs now (strict `until > now`; at exact equality
 *   the row is NOT snoozed — it is returned-from-defer)
 * - closed fold: `stage`, `closedReason`, `tuckedAt`, `closedAt`, `updatedAt`,
 *   `needsHuman`, awaiting-merge state, waiting count (row sessions), the
 *   finished-grace window vs now, abandoned (cancelled) outcomes, AND the
 *   transient selection latch (`selectedIssueId`, `selectedIssueWasFolded`)
 * - pinned split: `pinned`
 * DISPLAY-ONLY (must never regenerate a group): `title`, description, prefix /
 * displayRef, status words, attention/motion, unread emphasis, timers.
 *
 * The selection latch is a transient property of one interaction, deliberately
 * not store state (see worklist/published.ts). It is passed through per call,
 * never retained.
 *
 * TIME IS AN EXPLICIT INPUT. `updateTime(now)` advances the clock; nothing
 * reads the clock otherwise, so a quiet snooze lapses only from an explicit
 * time advance (same contract as E3).
 *
 * RETAINED PER-GROUP WORK, MEASURED: the closed fold is history ordered by
 * tuck/finish moment, newest first. That per-group sort runs ONLY for groups
 * whose closed membership changed; `stats.closedSorts` counts it. Input row
 * order is otherwise preserved exactly (band/manual order is the caller's;
 * this layer never re-sorts open rows).
 */
export interface WorklistSelection {
  selectedIssueId: IssueId | null
  selectedIssueWasFolded?: boolean
}

export const EMPTY_SELECTION: WorklistSelection = { selectedIssueId: null, selectedIssueWasFolded: false }

/** Stable row identity. Never a display value, never selection. */
export function stableRowId(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? `issue:${row.issue.id}` : `worktree:${row.worktree.path}`
}

function groupKeyOf(row: UnifiedWorkRow): string {
  return row.kind === 'issue'
    ? (row.issue.repoId ?? row.issue.repoPath)
    : (row.worktree.repoId ?? row.worktree.repoPath)
}

function groupLabelOf(row: UnifiedWorkRow): string {
  return row.kind === 'worktree'
    ? row.worktree.repoName
    : row.issue.repoPath.split('/').pop() || row.issue.repoPath
}

/** Display values, kept out of placement. Changing any field read here must
 * regenerate zero groups; the test pins that. */
export function rowDisplayOf(row: UnifiedWorkRow): { title: string } {
  return { title: row.kind === 'issue' ? row.issue.title : row.worktree.repoName }
}

function sameLane(a: readonly UnifiedWorkRow[], b: readonly UnifiedWorkRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (stableRowId(a[i]!) !== stableRowId(b[i]!)) return false
  return true
}

/** Whether the selection latch can change this row's closed lane. Abandoned
 * (cancelled) rows fold regardless of selection and tucked rows fold on the
 * operator's dismissal; only a settled-but-unremarked closure keeps the lane
 * it occupied when clicked. Every other row ignores selection entirely, so a
 * pure selection change re-places only these rows and rebuilds no sections. */
function laneNeedsSelection(row: UnifiedWorkRow): boolean {
  if (row.kind !== 'issue') return false
  const { issue } = row
  if (issueAbandoned(issue) || issue.tuckedAt != null) return false
  return (
    isClosedTopLevelIssue(issue) &&
    !issue.needsHuman &&
    !issueAwaitingMerge(issue) &&
    rowWaitingCount(row) === 0
  )
}

type Placement = {
  rowRef: UnifiedWorkRow
  placedNow: number
  placedSel: IssueId | null
  placedFoldLatch: boolean
  groupKey: string
  snoozed: boolean
  closed: boolean
}

export interface WorklistStructure {
  pinned: UnifiedWorkRow[]
  groups: UnifiedWorkGroup[]
}

export function createWorklistStructure() {
  let now: number | undefined
  const placements = new Map<string, Placement>()
  let last: WorklistStructure = { pinned: [], groups: [] }
  const stats = { placementsEvaluated: 0, groupsRegenerated: 0, closedSorts: 0, places: 0 }

  function place(row: UnifiedWorkRow, selection: WorklistSelection): Placement {
    const id = stableRowId(row)
    const prev = placements.get(id)
    const sel = selection.selectedIssueId
    const latch = selection.selectedIssueWasFolded ?? false
    if (
      prev && prev.rowRef === row && prev.placedNow === now &&
      (!laneNeedsSelection(row) || (prev.placedSel === sel && prev.placedFoldLatch === latch))
    ) {
      return prev
    }
    stats.placementsEvaluated++
    const closed = rowInClosedFold(row, sel, latch, now!)
    const snoozed = !closed && rowInSnoozedFold(row, now!)
    const placement: Placement = {
      rowRef: row, placedNow: now!, placedSel: sel, placedFoldLatch: latch,
      groupKey: groupKeyOf(row), snoozed, closed,
    }
    placements.set(id, placement)
    return placement
  }

  function closedOrdered(rows: readonly UnifiedWorkRow[]): UnifiedWorkGroup['closedRows'] {
    if (rows.length < 2) return [...rows] as UnifiedWorkGroup['closedRows']
    stats.closedSorts++
    // Same comparator as groupUnifiedWorkRows (newest tuck/finish first);
    // descending directly so stable ties keep incoming order exactly as legacy.
    return [...rows].sort(
      (a, b) =>
        (Date.parse(b.kind === 'issue' ? issueClosedFoldAt(b.issue) : '') || 0) -
        (Date.parse(a.kind === 'issue' ? issueClosedFoldAt(a.issue) : '') || 0),
    ) as UnifiedWorkGroup['closedRows']
  }

  return {
    updateTime(time: number) {
      if (!Number.isFinite(time)) throw new Error('Invalid worklist structure time')
      if (time === now) return
      now = time
    },
    place(rows: readonly UnifiedWorkRow[], selection: WorklistSelection = EMPTY_SELECTION): WorklistStructure {
      if (now === undefined) throw new Error('Worklist structure requires updateTime(now) before placing rows')
      stats.places++
      const { pinned, rest } = splitPinnedWork([...rows])
      const priorGroups = new Map(last.groups.map(g => [g.key, g]))
      const next = new Map<string, { label: string; rows: UnifiedWorkRow[]; snoozedRows: UnifiedWorkRow[]; closedRows: UnifiedWorkRow[] }>()
      const order: string[] = []
      for (const row of rest) {
        const p = place(row, selection)
        let group = next.get(p.groupKey)
        if (!group) {
          group = { label: groupLabelOf(row), rows: [], snoozedRows: [], closedRows: [] }
          next.set(p.groupKey, group)
          order.push(p.groupKey)
        }
        if (p.closed) group.closedRows.push(row)
        else if (p.snoozed) group.snoozedRows.push(row)
        else group.rows.push(row)
      }
      // Drop placements for rows no longer present (bounded lifecycle).
      if (placements.size > rows.length * 2 + 16) {
        const live = new Set(rows.map(stableRowId))
        for (const id of [...placements.keys()]) if (!live.has(id)) placements.delete(id)
      }
      const groups: UnifiedWorkGroup[] = []
      for (const key of order) {
        const built = next.get(key)!
        const prior = priorGroups.get(key)
        const rowsKept = prior && sameLane(prior.rows, built.rows)
        const snoozedKept = prior && sameLane(prior.snoozedRows, built.snoozedRows)
        const closedKept = prior && sameLane(prior.closedRows, built.closedRows)
        const closedRows = closedKept ? prior!.closedRows : closedOrdered(built.closedRows)
        if (prior && prior.label === built.label && rowsKept && snoozedKept && closedKept) {
          groups.push(prior)
          continue
        }
        stats.groupsRegenerated++
        groups.push({
          key,
          label: built.label,
          rows: rowsKept ? prior!.rows : [...built.rows],
          snoozedRows: snoozedKept ? prior!.snoozedRows : [...built.snoozedRows] as UnifiedWorkGroup['snoozedRows'],
          closedRows,
        })
      }
      const nextPinned = sameLane(last.pinned, pinned) ? last.pinned : [...pinned]
      if (nextPinned !== last.pinned) stats.groupsRegenerated++
      const result: WorklistStructure = { pinned: nextPinned, groups }
      last = result
      return result
    },
    stats: () => ({ ...stats, livePlacements: placements.size }),
    /** Test-only: placement inputs for one row, to pin the membership/display boundary. */
    placementInputs(row: UnifiedWorkRow): { deferred: boolean; returned: boolean; band: number } {
      if (now === undefined) throw new Error('Worklist structure requires updateTime(now) before reading inputs')
      if (row.kind !== 'issue') return { deferred: false, returned: false, band: unifiedRowBand(row, now) }
      return {
        deferred: isIssueDeferred({ deferUntil: row.issue.deferUntil }, now),
        returned: issueReturnedFromDefer({ deferUntil: row.issue.deferUntil }, now),
        band: unifiedRowBand(row, now),
      }
    },
  }
}
