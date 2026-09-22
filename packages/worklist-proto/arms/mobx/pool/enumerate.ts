/**
 * POD-4565 (Ma1) — the ENUMERATION MODULE (`fence.json`): the only place in
 * the pool that walks a whole table. The lint fence (`no-table-walk`)
 * refuses a table walk anywhere else in `pool/`.
 *
 * Two walks, both membership-sized by nature:
 * - `issueIdsOf`: every issue id, for the Ma1 list and `snapshot()`. Mb1
 *   (POD-4569) replaces it with the visible collection. It iterates KEYS of
 *   the raw table, so the enclosing computed subscribes to membership only (a
 *   rename does not re-run it), and records each id with the reads fence
 *   (`reads.touch`): the walk costs what it walks, where the fence can see
 *   it. (The fenced table's own `keys()` reads every VALUE, which under MobX
 *   would subscribe the list to every row: see NOTES.md.)
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, in the
 *   caller's single action.
 */

import type { ReadFence } from '../../../shared/src/instrument/reads'
import type { RowRecord } from '../../../shared/src/stats'
import {
  createPlainTables,
  drop,
  ENTITIES,
  type IngestOut,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  type PoolTables,
  put,
} from './tables'

/** Every issue id in the pool; tracked on membership, counted per id. */
export function issueIdsOf(pool: { readonly tables: PoolTables; readonly reads: ReadFence }): string[] {
  const ids: string[] = []
  for (const id of pool.tables.issue.keys()) {
    pool.reads.touch('issue', id, 'iterate')
    ids.push(id)
  }
  return ids
}

/**
 * Replace the pool's contents with `rows`, atomically (call inside one
 * action). Routed through the same ingest as an update, into plain tables
 * first, so a repo derived from a lane arrives exactly as it would
 * incrementally; then every table keeps the rows named (unchanged objects are
 * not rewritten) and drops the rest.
 */
export function reseed(target: IngestTarget, rows: readonly RowRecord[], out: IngestOut): void {
  const incoming = createPlainTables()
  const scratch = ingestOut()
  const staging: IngestTarget = { read: incoming, write: incoming }
  for (const record of rows) ingestRecord(staging, record, scratch)
  for (const entity of ENTITIES) {
    const table = target.write[entity]
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of table.keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}
