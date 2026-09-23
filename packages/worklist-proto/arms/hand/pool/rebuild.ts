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
 * RESIDENCY (POD-4580). The live pool's output holds its RESIDENT issues, and
 * which cold rows it has loaded is the user's history, like the selection, so
 * it comes in as an input: `resident`, the pool's resident issue ids. The
 * rebuild's rows are every issue the schema's rule keeps hot (`coldByRule`
 * over the feed's rows, the rule the pool partitions with) plus the resident
 * ones that still exist. A hot issue the pool failed to hold, or a removed one
 * it kept, is a row-set difference. Every row reads full data (`loading` is
 * always false): the live `snapshot()` settles its loads first. The gate's
 * full-residency checkpoint calls it without `resident`: every row.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { sliceRowOf } from '../../../shared/src/row-view'
import { coldByRule, type EntityName, type ModelSchema, SCHEMA } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession, SliceSnapshot } from '../../../shared/src/slice-types'
import { PoolRelations } from './relations'
import { createTables, ingestOut, ingestRecord } from './tables'
import { buildRowView, directParts, type RepoRow, type ViewInputs } from './views'

export function rebuildSnapshot(
  source: RowSource,
  locals: LocalsSource,
  resident?: ReadonlySet<string>,
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
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const coldTarget = (to: EntityName, id: string): boolean => {
    const row = tables[to].get(id)
    return row !== undefined && coldByRule(schema, to, row, coldTarget)
  }
  const rowsById: SliceSnapshot['rowsById'] = {}
  for (const { id } of issues) {
    if (resident !== undefined && !resident.has(id) && coldTarget('issue', id)) continue
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) rowsById[id] = sliceRowOf(view)
  }
  return { order: { pinnedIds: [], groups: [] }, rowsById }
}
