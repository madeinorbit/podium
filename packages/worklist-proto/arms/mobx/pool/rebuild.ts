/**
 * POD-4565 (Ma1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh plain maps, resolves every relation FROM SCRATCH (`scanRelations`,
 * `enumerate.ts`: the declared resolvers over whole tables, none of the live
 * engine's maintenance), and derives every row with the same `buildRowView`
 * as the live models, with the clock and selection read as plain values. So
 * the checker holds the live pool's incremental relation maintenance to a
 * from-scratch resolution, and its derivations to themselves.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { sliceRowOf } from '../../../shared/src/row-view'
import type { SliceIssue, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import { scanRelations } from './enumerate'
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
    relations: scanRelations(tables),
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    present: (entity, id) => tables[entity].has(id),
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
