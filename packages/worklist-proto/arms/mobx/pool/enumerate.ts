/**
 * POD-4565 (Ma1) — the ENUMERATION MODULE (`fence.json`): the only place in
 * the pool that walks a whole table. The lint fence (`no-table-walk`)
 * refuses a table walk anywhere else in `pool/`.
 *
 * One walk, membership-sized by nature:
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, in the
 *   caller's single action. In the live pool it re-partitions residency
 *   (POD-4567): a named row resident before stays; the rest follow the rule.
 *
 * The from-scratch checks the gates hold the pool to are harness-owned
 * (`harness/src/adapters/mobx-rebuild.ts`, POD-4945), never product.
 */

import type { RowRecord } from '../../../shared/src/stats'
import {
  createPlainTables,
  drop,
  ENTITIES,
  type IngestOut,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  put,
} from './tables'

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
  const residency = target.residency
  residency?.reindex((entity) => incoming[entity])
  for (const entity of ENTITIES) {
    const table = target.write[entity]
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of table.keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    if (residency?.capable(entity)) {
      // POD-4567: re-partition. Cold rows the slice no longer names leave;
      // every named row is placed by the rule (a resident row stays).
      for (const id of residency.ids(entity)) {
        if (!next.has(id)) residency.forget(target, entity, id, out)
      }
      for (const [id, row] of next) residency.place(target, entity, id, row, out)
      continue
    }
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
  residency?.replaced(target, out)
}
