/**
 * POD-4565 (Ma1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh plain maps, resolves relations with the same `PoolRelations`, and
 * derives every row with the same `buildRowView` as the live models, with
 * the clock and selection read as plain values. Only the containers differ
 * (plain maps instead of observable ones), which is what the checker holds
 * the live pool to.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { SliceIssue, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import { PoolRelations } from './relations'
import { createPlainTables, ingestOut, ingestRecord } from './tables'
import { buildRowView, directParts, type RepoRow, type ViewInputs } from './views'

export function rebuildSnapshot(source: RowSource, locals: LocalsSource): SliceSnapshot {
  const tables = createPlainTables()
  const target = { read: tables, write: tables }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)

  const { coarseNow, selectedIssueId } = locals.get()
  const inputs: ViewInputs = {
    relations: new PoolRelations(tables),
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const rowsById: SliceSnapshot['rowsById'] = {}
  for (const { id } of issues) {
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) rowsById[id] = sliceRowOf(view)
  }
  return { order: { pinnedIds: [], groups: [] }, rowsById }
}
