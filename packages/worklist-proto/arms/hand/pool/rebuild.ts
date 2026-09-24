/**
 * POD-4578 (Ha1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh maps with a fresh relation engine (`PoolRelations`: one replay, so no
 * history), and derives
 * every row with the same rule table (`views.ts` `PART_RULES` through
 * `directParts`, then `buildRowView`) as the live cells, with the clock and
 * selection read as plain values. Only the memo differs (none here, a cell
 * per part there), which is what the checker holds the live pool to.
 *
 * VISIBILITY (POD-4582, Hb1). The rows are the VISIBLE issues in L1b rank
 * order, decided from scratch by the same rule table the live cells run
 * (`worklist/visible.ts` `VISIBLE_RULES` through `directVisibleParts`,
 * memoized for this one pass), over EVERY row the feed holds: a cold row's
 * `flat` is computed from its data here, where the live parts take it from
 * the shared cold rule's bound (schema doc §5.1), so a cold row the rule
 * should have kept shown is a row-set difference. The pinned ids follow in
 * rank order; no groups yet (Hb2). Residency no longer shapes the row set:
 * the live `snapshot()` loads what it reaches and settles first, and every
 * row here reads full data (`loading` is always false). `resident` is
 * accepted and unused (the checker's call shape).
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { sliceRowOf } from '../../../shared/src/row-view'
import { type ModelSchema, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import { PoolRelations } from './relations'
import { createTables, ingestOut, ingestRecord } from './tables'
import {
  buildRowView,
  directParts,
  type RepoRow,
  sessionActivityOf,
  type ViewInputs,
} from './views'
import {
  directSessionParts,
  directVisibleParts,
  type SessionVisibleParts,
  sortByRank,
  type VisibleInputs,
  type VisibleParts,
} from './worklist/visible'

export function rebuildSnapshot(
  source: RowSource,
  locals: LocalsSource,
  _resident?: ReadonlySet<string>,
  schema: ModelSchema = SCHEMA,
): SliceSnapshot {
  const tables = createTables()
  const relations = new PoolRelations({
    schema,
    rows: tables,
    roots: tables,
    present: (entity, id) => tables[entity].has(id),
  })
  const target = { read: tables, write: tables, relations }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)

  const { coarseNow, selectedIssueId } = locals.get()
  const inputs: ViewInputs = {
    relations,
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const memo = new Map<string, VisibleParts>()
  const sessions = new Map<string, SessionVisibleParts>()
  const visible: VisibleInputs = {
    relations,
    resident: (entity, id) => tables[entity].has(id),
    issueRow: inputs.issue,
    sessionRow: inputs.session,
    issue: (id) => (tables.issue.has(id) ? directVisibleParts(visible, id, memo) : undefined),
    session: (id) => {
      if (!tables.session.has(id)) return undefined
      let parts = sessions.get(id)
      if (parts === undefined) {
        parts = directSessionParts(visible, id)
        sessions.set(id, parts)
      }
      return parts
    },
    sessionActivity: inputs.sessionActivity,
    own: (id) => directParts(inputs, id).own,
    passed: inputs.passed,
  }
  const order = sortByRank(
    issues.map(({ id }) => id).filter((id) => directVisibleParts(visible, id, memo).visible),
    (id) => directVisibleParts(visible, id, memo).rank,
  )
  const rowsById: SliceSnapshot['rowsById'] = {}
  const pinnedIds: string[] = []
  for (const id of order) {
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view === undefined) continue
    rowsById[id] = sliceRowOf(view)
    if (view.pinned) pinnedIds.push(id)
  }
  return { order: { pinnedIds, groups: [] }, rowsById }
}
