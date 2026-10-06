import { headerEntities } from './header-entities'
/**
 * POD-4565 (Ma1) — the ENUMERATION MODULE (`fence.json`): the only place in
 * the pool that walks a whole table. The lint fence (`no-table-walk`)
 * refuses a table walk anywhere else in `pool/`.
 *
 * One walk, membership-sized by nature:
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, in the
 *   caller's single action. In the live pool the cold-capable entities are
 *   placed by residency (POD-5407): the index's resident candidates; a named
 *   row resident before stays.
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
  type StoredRow,
} from './tables'

/** One startup seed for the reference reader. Only resident slots participate;
 * subsequent upkeep follows individual table changes, never cold summaries. */
export function seedIssueReferences(
  tables: Pick<PoolTables, 'issue'>,
  track: (id: string) => void,
): void {
  for (const id of tables.issue.keys()) track(id)
}

/** Header attachment seeds once; all subsequent session upkeep is by id. */
export function seedHeaderSessions(
  pool: MobxPool,
  resident: (id: string) => void,
  cold: (id: string) => void,
): void {
  for (const id of pool.queries.ids({ kind: 'headerSessions' })) {
    if (pool.tables.session.has(id)) resident(id)
    else cold(id)
  }
}

/** Resident half of a declared history question. No cold registry walk. */
export function residentIds(pool: MobxPool, entity: 'issue' | 'session'): string[] {
  return [...pool.tables[entity].keys()]
}

/**
 * Replace the pool's contents (call inside one action, after the cold index
 * holds the new slice). The entities that are never cold (lanes, repos) are
 * routed through the same ingest as an update, into plain tables first, so a
 * repo derived from a lane arrives exactly as it would incrementally; then
 * those tables keep the rows named (unchanged objects are not rewritten) and
 * drop the rest. The cold-capable entities are placed by residency
 * (POD-5407, `Residency.attach`): the index's resident candidates only, read
 * from `rows` when they carry them, else once by id. A cold row is never
 * visited.
 */
export function reseed(
  target: IngestTarget,
  rows: readonly RowRecord[],
  out: IngestOut,
  /** The index was built from other publications than `rows` (a source's own): rows it may not know. */
  external = false,
): void {
  const incoming = createPlainTables()
  const scratch = ingestOut()
  const staging: IngestTarget = { read: incoming, write: incoming }
  const residency = target.residency
  // Only a feed without its own index hands the cold-capable rows over here.
  let carried: Map<string, StoredRow> | null = null
  for (const record of rows) {
    if (record.kind === 'machine') continue
    if (residency?.capable(record.kind) === true) {
      if (record.value === undefined) continue
      carried ??= new Map()
      carried.set(`${record.kind}:${record.id}`, record.value as StoredRow)
      continue
    }
    ingestRecord(staging, record, scratch)
  }
  for (const entity of ENTITIES) {
    if (residency?.capable(entity) === true) continue
    const table = target.write[entity]
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of table.keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
  replaceRepoHolders(incoming.repo, target.write.repo)
  // Only rows the index does not know need visiting beyond the candidates: an
  // index built from these very rows knows them all, and a feed with its own
  // index hands none over.
  const unknown = function* (): Generator<readonly [EntityName, string, StoredRow]> {
    if (!external) return
    for (const [key, row] of carried ?? []) {
      const colon = key.indexOf(':')
      yield [key.slice(0, colon) as EntityName, key.slice(colon + 1), row]
    }
  }
  residency?.attach(
    target,
    carried === null ? null : (entity, id) => carried?.get(`${entity}:${id}`),
    out,
    unknown(),
  )
}

/** Header key census stays in the pool's one enumeration module. Values are
 * read only through pool.row; unloaded rows use their declared summaries. */
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
    const row = pool.row('session', id)
    return typeof row === 'object' && row !== null ? [[id, row] as [string, object]] : []
  })
}
/**
 * Every id of `entity` the feed carries, resident or cold, through the cold
 * index's catalog question. For diagnostics and tests that compare a reader
 * with a whole-catalog control; no product reader enumerates history.
 */
export function knownIds(pool: MobxPool, entity: 'issue' | 'session'): string[] {
  const all = pool
    .coldIndex()
    .readerIds({ kind: entity === 'issue' ? 'commandIssues' : 'commandSessions' })
  return [...new Set([...pool.tables[entity].keys(), ...all])].sort()
}
export function residentWorktreeIds(pool: MobxPool): string[] {
  return [...pool.tables.worktree.keys()]
}
