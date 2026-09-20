/**
 * POD-4446 — the rebuild oracle: from-scratch recompute for every derived
 * module, and the test that incremental output deep-equals it after every
 * scenario (methodology §5.2: this replaces dependency tracking as the
 * correctness guarantee).
 *
 * The rebuild shares the modules' pure `compute` functions but bypasses ALL
 * incremental caches: a fresh IndexSet is rebuilt from the tables in bulk,
 * then fresh derived modules run their full derives in topology order. What
 * the comparison checks is the delta plumbing — dirty sets, chain walks,
 * rescue refcounts, order maintenance, group placement — not the rules
 * themselves (parity against the legacy oracle checks the rules).
 */

import type { SliceOrder, SliceRow, SliceSnapshot } from '../../shared/src/slice-types'
import { GroupsModule, type SelectionState } from './groups'
import { IndexSet } from './indexes'
import { OrderModule } from './order'
import { RollupModule } from './rollup'
import { SummaryModule } from './summary'
import type { IssueTable, SessionTable, WorktreeTable } from './tables'
import { VisibleModule } from './visible'
import { RowsModule } from './rows'

export interface RebuildInput {
  issues: IssueTable
  sessions: SessionTable
  worktrees: WorktreeTable
  selection: SelectionState
  now: number
}

export interface RebuiltState {
  snapshot: SliceSnapshot
  summaries: Array<[string, unknown]>
  aggregates: Array<[string, unknown]>
  visible: string[]
  ordered: string[]
}

/** Full from-scratch derive over the current tables. No incremental state. */
export function rebuildFromScratch(input: RebuildInput): RebuiltState {
  const getNow = (): number => input.now
  const getSelection = (): SelectionState => input.selection
  const tables = { issues: input.issues, sessions: input.sessions, worktrees: input.worktrees }
  const indexes = new IndexSet(tables)
  indexes.rebuildAll(
    input.issues.rows.entries(),
    input.sessions.rows.entries(),
    input.worktrees.rows.keys(),
    (path) => {
      const lane = input.worktrees.rows.get(path)
      return { repoId: lane?.repoId, prefix: lane?.prefix }
    },
  )
  const summary = new SummaryModule(tables, indexes, getNow)
  summary.rebuildAll()
  const visible = new VisibleModule(tables, indexes, summary, getNow)
  visible.rebuildAll()
  const rollup = new RollupModule(tables, indexes, summary, visible, getNow)
  rollup.rebuildAll()
  const order = new OrderModule(tables, indexes, summary, visible, getNow)
  order.rebuildAll()
  const groups = new GroupsModule(tables, summary, rollup, order, getSelection, getNow)
  groups.rebuildAll()
  const rows = new RowsModule(summary, rollup, groups, visible)
  rows.rebuildAll()
  const rowsById: Record<string, SliceRow> = {}
  for (const id of order.ordered) {
    const row = rows.rows.get(id)
    if (row !== undefined) rowsById[id] = row
  }
  const sliceOrder: SliceOrder = {
    pinnedIds: [...groups.pinnedIds],
    groups: groups.groups.map((g) => ({
      key: g.key,
      label: g.label,
      rowIds: [...g.rowIds],
      closedIds: [...g.closedIds],
    })),
  }
  return {
    snapshot: { order: sliceOrder, rowsById },
    summaries: [...summary.summaries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    aggregates: [...rollup.aggregates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    visible: [...visible.visible].sort(),
    ordered: [...order.ordered],
  }
}
