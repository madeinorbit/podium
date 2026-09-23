/**
 * POD-4578 (Ha1) — the ENUMERATION MODULE (`arms/hand/fence.json`): the only
 * place in the pool that walks a whole table. The lint fence
 * (`no-table-walk`) refuses a table walk anywhere else in `pool/`.
 *
 * Three walks, each sized by what it must see:
 * - `issueIdsOf`: every issue id, for the a1 list and `snapshot()`, until
 *   Hb1 (POD-4582) builds the visible collection. It walks the fenced
 *   table's KEYS (the fence counts each id without reading its value,
 *   POD-4621) inside the list's cell, which records the table's membership
 *   as its one input: a rename does not re-run it; an add or a removal does.
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, as one
 *   event.
 * - `otherLaneOf`: a lane of a repo other than the one leaving, when the lane
 *   holding the repo's row leaves or moves (`tables.ts`). The worktree table
 *   holds one row per checkout (tens); Ha2 (POD-4579) answers it from the
 *   maintained `repo.worktrees` collection instead.
 */

import type { RowRecord } from '../../../shared/src/stats'
import {
  createTables,
  drop,
  ENTITIES,
  type IngestOut,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  laneRepoId,
  put,
  type ReadableTable,
  type StoredRow,
} from './tables'

/** Every issue id in `issue`, in table order; the fence counts each id. */
export function issueIdsOf(issue: { keys(): IterableIterator<string> }): string[] {
  return [...issue.keys()]
}

/**
 * Replace the pool's contents with `rows`, atomically (the caller drains and
 * notifies once afterwards). Routed through the same ingest as an update, into
 * fresh tables first, so a repo held by a lane arrives exactly as it would
 * incrementally; then every table keeps the rows named (unchanged objects are
 * not rewritten) and drops the rest.
 */
export function reseed(target: IngestTarget, rows: readonly RowRecord[], out: IngestOut): void {
  const incoming = createTables()
  const staging: IngestTarget = { read: incoming, write: incoming }
  const scratch = ingestOut()
  for (const record of rows) ingestRecord(staging, record, scratch)
  for (const entity of ENTITIES) {
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of target.write[entity].keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}

/** A lane of `repoId` other than `leaving`, or undefined. */
export function otherLaneOf(
  worktree: ReadableTable & { keys(): IterableIterator<string> },
  repoId: string,
  leaving: StoredRow,
): StoredRow | undefined {
  for (const path of worktree.keys()) {
    const lane = worktree.get(path) as StoredRow | undefined
    if (lane !== undefined && lane !== leaving && laneRepoId(lane) === repoId) return lane
  }
  return undefined
}
