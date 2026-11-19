import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
/**
 * POD-4565 (Ma1) — the ENUMERATION MODULE (`fence.json`): the only place in
 * the pool that walks a whole table. The lint fence (`no-table-walk`)
 * refuses a table walk anywhere else in `pool/`.
 *
 * One walk, membership-sized by nature:
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, in the
 *   caller's single action. Every row the slice names is placed (POD-7094:
 *   history is not on the device).
 *
 * The from-scratch checks the gates hold the pool to are harness-owned
 * (`harness/src/adapters/mobx-rebuild.ts`, POD-4945), never product.
 */

import type { HeaderEntity } from './header-schema'
import type { MobxPool } from './pool'
import type { EntityName } from './shared/schema'
import type { RowRecord } from './shared/source'
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
  replaceRepoHolders,
} from './tables'

/** One startup seed for the reference reader; subsequent upkeep follows
 * individual table changes. */
export function seedIssueReferences(
  tables: Pick<PoolTables, 'issue'>,
  track: (id: string) => void,
): void {
  for (const id of tables.issue.keys()) track(id)
}

/** The ids of `entity` the pool holds. */
export function residentIds(pool: MobxPool, entity: 'issue' | 'session'): string[] {
  return [...pool.tables[entity].keys()]
}

/**
 * Replace the pool's contents (call inside one action, after the device
 * index holds the new slice). Every record is routed through the same
 * ingest as an update, into plain tables first, so a repo derived from a
 * lane arrives exactly as it would incrementally; then the tables keep the
 * rows named (unchanged objects are not rewritten) and drop the rest.
 */
export function reseed(
  target: IngestTarget,
  rows: readonly RowRecord[],
  out: IngestOut,
  ownsRecords?: (entity: EntityName) => boolean,
): void {
  const incoming = createPlainTables()
  const scratch = ingestOut()
  const staging: IngestTarget = { read: incoming, write: incoming }
  for (const record of rows) ingestRecord(staging, record, scratch)
  // The staged repo bookkeeping (holding lanes, replicated records) goes over
  // FIRST: a repo put composes its row from the record and the holding lane it
  // finds, so it must find this slice's, not the previous one's (POD-6246).
  replaceRepoHolders(incoming.repo, target.write.repo)
  for (const entity of ENTITIES) {
    const table = target.write[entity]
    const next = incoming[entity]
    const gone: string[] = []
    if (!ownsRecords?.(entity)) for (const id of table.keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}

/** Header key census stays in the pool's one enumeration module. Values are
 * read only through pool.row. */
export function headerIds(pool: MobxPool, entity: HeaderEntity): string[] {
  return [
    ...new Set([...(headerEntities(pool).orders.get(entity) ?? []), ...headerEntities(pool).tables[entity].keys()]),
  ]
}
export function residentSessionIds(pool: MobxPool): string[] {
  return headerEntities(pool).sessionOrder.get()
}
export function allResidentSessions(pool: MobxPool): [string, object][] {
  return [...pool.tables.session.keys()].flatMap((id) => {
    const row = omitGone(pool.row('session', id))
    return typeof row === 'object' && row !== null ? [[id, row] as [string, object]] : []
  })
}
export function residentWorktreeIds(pool: MobxPool): string[] {
  return [...pool.tables.worktree.keys()]
}
