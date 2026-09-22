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
 *
 * And one walk that is not the pool's: `scanRelations` (POD-4566) resolves
 * every declared relation FROM SCRATCH over whole tables — the declared
 * resolvers applied to every row, no maintenance — for the rebuild
 * (`rebuild.ts`) and as the oracle the relation tests hold the live engine
 * to. It shares with the engine only the schema, `relationRef` and the two
 * declared resolvers (`longestPrefixPath`, `collapseLosers`).
 */

import type { ReadFence, RelationReader } from '../../../shared/src/instrument/reads'
import {
  type CollapseMember,
  collapseLosers,
  type EntityName,
  longestPrefixPath,
  type ModelSchema,
  SCHEMA,
} from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import { isLinkSpec, relationRef } from './relations'
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
export function issueIdsOf(pool: {
  readonly tables: PoolTables
  readonly reads: ReadFence
}): string[] {
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

/** Whole tables, walkable (plain maps in the rebuild; the pool's maps in tests). */
export type ScannableTables = {
  readonly [E in EntityName]: {
    has(id: string): boolean
    entries(): IterableIterator<[string, unknown]>
    keys(): IterableIterator<string>
  }
}

const NO_IDS: readonly string[] = Object.freeze([])

/**
 * Every declared relation, resolved from scratch over `tables`: collapse
 * groups by `collapseLosers`, `belongsTo` and outgoing `edge` by
 * `relationRef`, `prefix` by `longestPrefixPath` over the target table's
 * keys; each collection is the sorted inverse. Answers as a `RelationReader`
 * (`one` checks the target's presence, as the engine does).
 */
export function scanRelations(
  tables: ScannableTables,
  schema: ModelSchema = SCHEMA,
): RelationReader & { readonly collapsed: ReadonlySet<string> } {
  const entities = Object.keys(schema) as EntityName[]
  const collapsed = new Set<string>()
  for (const entity of entities) {
    const rule = schema[entity].collapse
    if (rule === undefined) continue
    const groups = new Map<string, CollapseMember[]>()
    for (const [id, row] of tables[entity].entries()) {
      const key = rule.groupKey(row as Readonly<Record<string, unknown>>)
      if (key === null) continue
      const group = groups.get(key) ?? []
      group.push({ id, row: row as Readonly<Record<string, unknown>> })
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      for (const id of collapseLosers(rule, group)) collapsed.add(`${entity}:${id}`)
    }
  }
  const forward = new Map<string, Map<string, string>>()
  const inverse = new Map<string, Map<string, string[]>>()
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec)) continue
      const pointers = new Map<string, string>()
      const buckets = new Map<string, string[]>()
      for (const [id, value] of tables[from].entries()) {
        const row = value as Readonly<Record<string, unknown>>
        if (collapsed.has(`${from}:${id}`)) continue
        if (spec.where !== undefined && !spec.where.test(row)) continue
        let target: string | null
        if (spec.kind === 'prefix') {
          const path = row[spec.sourceField]
          target = typeof path === 'string' ? longestPrefixPath(path, tables[spec.to].keys()) : null
        } else {
          target = relationRef(from, name, row, schema)
        }
        if (target === null) continue
        pointers.set(id, target)
        buckets.set(target, [...(buckets.get(target) ?? []), id])
      }
      for (const members of buckets.values()) members.sort()
      forward.set(`${from}.${name}`, pointers)
      inverse.set(`${spec.to}.${spec.inverse}`, buckets)
    }
  }
  const bucketOf = (from: EntityName, id: string, relation: string): readonly string[] => {
    const buckets = inverse.get(`${from}.${relation}`)
    if (buckets === undefined) throw new Error(`[scan] ${from}.${relation} is not a collection`)
    return buckets.get(id) ?? NO_IDS
  }
  return {
    collapsed,
    one(from, id, relation) {
      const pointers = forward.get(`${from}.${relation}`)
      if (pointers === undefined) throw new Error(`[scan] ${from}.${relation} is not single-valued`)
      const target = pointers.get(id)
      const to = schema[from].relations[relation]?.to as EntityName
      return target !== undefined && tables[to].has(target) ? target : null
    },
    many: bucketOf,
    size: (from, id, relation) => bucketOf(from, id, relation).length,
  }
}
