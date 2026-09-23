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
 *
 * RESIDENCY (POD-4567). The live pool's output holds its RESIDENT issues, and
 * which cold rows it has loaded is the user's history, like the selection, so
 * it comes in as an input: `resident`, the pool's resident issue ids. The
 * rebuild's rows are every issue the schema's rule keeps hot (`coldByRule`
 * over the feed's rows, the function the pool partitions with) plus the
 * resident ones that still exist. A hot issue the pool failed to hold, or a
 * removed one it kept, is a row-set difference. Every row reads full data
 * (`loading` is always false): the live `snapshot()` settles its loads first.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { sliceRowOf } from '../../../shared/src/row-view'
import { coldByRule, type EntityName, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import { scanRelations } from './enumerate'
import { createPlainTables, ingestOut, ingestRecord } from './tables'
import {
  buildRowView,
  directParts,
  type RepoRow,
  sessionActivityOf,
  type ViewInputs,
} from './views'

export function rebuildSnapshot(
  source: RowSource,
  locals: LocalsSource,
  resident?: ReadonlySet<string>,
): SliceSnapshot {
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
    sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const coldTarget = (to: EntityName, id: string): boolean => {
    const row = tables[to].get(id)
    return row !== undefined && coldByRule(SCHEMA, to, row, coldTarget)
  }
  const rowsById: SliceSnapshot['rowsById'] = {}
  for (const { id } of issues) {
    if (resident !== undefined && !resident.has(id) && coldTarget('issue', id)) continue
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) rowsById[id] = sliceRowOf(view)
  }
  return { order: { pinnedIds: [], groups: [] }, rowsById }
}
