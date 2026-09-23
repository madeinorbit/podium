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
 *   caller's single action. In the live pool it re-partitions residency
 *   (POD-4567): a named row resident before stays; the rest follow the rule.
 *
 * And two walks that are not the pool's: `diffResidency` (POD-4567) holds the
 * pool's hot/cold partition to the feed (the gate runs it every step), and
 * `scanRelations` (POD-4566) resolves
 * every declared relation FROM SCRATCH over whole tables — the declared
 * resolvers applied to every row, no maintenance — for the rebuild
 * (`rebuild.ts`) and as the oracle the relation tests hold the live engine
 * to. It shares with the engine only the schema, `relationRef` and the two
 * declared resolvers (`longestPrefixPath`, `collapseLosers`).
 */

import { runInAction } from 'mobx'
import type { RowSource } from '../../../shared/src/arm'
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
import { coldByRule, type Residency, viaTargetOf } from './residency'
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
  type StoredRow,
  type TableSet,
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
  const residency = target.residency
  const staged = (to: EntityName, id: string): object | undefined => incoming[to].get(id)
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
      for (const [id, row] of next) residency.place(target, entity, id, row, staged, out)
      continue
    }
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}

/**
 * Every row a lazy pool KNOWS, in plain tables (POD-4567): for an entity that
 * can be cold, the feed's current rows (cold ones included, which the engine
 * links by id though the pool's tables never hold them); for one that is
 * never cold, the pool's own table, as Ma2's check read it (the feed's lanes
 * include discovery-only ones it never announces, POD-4606: not residency).
 * What a relation check holds a lazy pool's engine to.
 */
export function knownTables(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
): TableSet<Map<string, StoredRow>> {
  const tables = createPlainTables()
  const target: IngestTarget = { read: tables, write: tables }
  const out = ingestOut()
  for (const kind of ['session', 'issue'] as const) {
    if (pool.residency?.capable(kind) !== true) continue
    for (const record of source.snapshot(kind)) ingestRecord(target, record, out)
  }
  for (const entity of ENTITIES) {
    if (pool.residency?.capable(entity) === true) continue
    for (const [id, row] of pool.tables[entity]) tables[entity].set(id, row)
  }
  return tables
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
      // One resolution per distinct path: sessions share their lane's cwd.
      const roots = spec.kind === 'prefix' ? [...tables[spec.to].keys()] : []
      const owners = new Map<string, string | null>()
      for (const [id, value] of tables[from].entries()) {
        const row = value as Readonly<Record<string, unknown>>
        if (collapsed.has(`${from}:${id}`)) continue
        if (spec.where !== undefined && !spec.where.test(row)) continue
        let target: string | null
        if (spec.kind === 'prefix') {
          const path = row[spec.sourceField]
          if (typeof path !== 'string') target = null
          else {
            if (!owners.has(path)) owners.set(path, longestPrefixPath(path, roots))
            target = owners.get(path) ?? null
          }
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

/**
 * Every answer of `live` that differs from a from-scratch `scanRelations`
 * over the same `tables`, for every row of every table plus any `extra` ids
 * (absent targets, whose collections are kept by reference). Bounded to 12
 * lines. The relation tests' and the gate's check.
 */
export function diffRelations(
  live: RelationReader,
  tables: ScannableTables,
  schema: ModelSchema = SCHEMA,
  extra: Partial<Record<EntityName, Iterable<string>>> = {},
): string[] {
  const scan = scanRelations(tables, schema)
  const out: string[] = []
  for (const from of Object.keys(schema) as EntityName[]) {
    const ids = new Set([...tables[from].keys(), ...(extra[from] ?? [])])
    for (const id of ids) {
      for (const [name, spec] of Object.entries(schema[from].relations)) {
        const got = isLinkSpec(spec) ? live.one(from, id, name) : [...live.many(from, id, name)]
        const want = isLinkSpec(spec) ? scan.one(from, id, name) : [...scan.many(from, id, name)]
        if (JSON.stringify(got) === JSON.stringify(want)) continue
        if (out.length < 12) {
          out.push(
            `${from}:${id}.${name}: live ${JSON.stringify(got)}, scan ${JSON.stringify(want)}`,
          )
        }
      }
    }
  }
  return out
}

/**
 * The pool's residency against the feed's CURRENT rows, as problems (bounded
 * to 12 lines): every row of an entity that can be cold is resident or cold,
 * never both, never neither; a cold row is cold by the rule (over the feed's
 * rows) and registered under the row it inherits from; nothing resident or
 * cold is gone from the feed. A resident row that the rule calls cold is
 * fine: it was looked at (`residency.ts`). The gate's partition check.
 */
export function diffResidency(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
  schema: ModelSchema = SCHEMA,
): string[] {
  // In an action: a check, not a derivation; it subscribes to nothing.
  return runInAction(() => residencyProblems(pool, source, schema))
}

function residencyProblems(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
  schema: ModelSchema,
): string[] {
  const residency = pool.residency
  if (residency === null) return ['the pool has no residency']
  const out: string[] = []
  const say = (line: string): void => {
    if (out.length < 12) out.push(line)
  }
  const feed = new Map<EntityName, Map<string, object>>()
  for (const entity of ['issue', 'session'] as const) {
    feed.set(
      entity,
      new Map(
        source
          .snapshot(entity)
          .filter((record) => record.value !== undefined)
          .map((record) => [record.id, record.value as object]),
      ),
    )
  }
  const coldTarget = (to: EntityName, id: string): boolean => {
    const row = feed.get(to)?.get(id)
    return row !== undefined && coldByRule(schema, to, row, coldTarget)
  }
  for (const entity of Object.keys(schema) as EntityName[]) {
    if (!residency.capable(entity)) continue
    const rows = feed.get(entity)
    if (rows === undefined) {
      say(`${entity}: can be cold, but the feed has no per-row kind for it`)
      continue
    }
    for (const [id, row] of rows) {
      const hot = pool.tables[entity].has(id)
      const cold = residency.isCold(entity, id)
      if (hot && cold) say(`${entity}:${id} is both resident and cold`)
      else if (!hot && !cold) say(`${entity}:${id} is in the feed but neither resident nor cold`)
      else if (cold && !coldByRule(schema, entity, row, coldTarget)) {
        say(`${entity}:${id} is cold but the rule keeps it resident`)
      } else if (cold) {
        const want = viaTargetOf(schema, entity, row)?.id ?? null
        const got = residency.registeredTarget(entity, id) ?? null
        if (want !== got) say(`${entity}:${id} is registered under ${got}, its row names ${want}`)
      }
    }
    for (const id of pool.tables[entity].keys()) {
      if (!rows.has(id)) say(`${entity}:${id} is resident but gone from the feed`)
    }
    for (const id of residency.ids(entity)) {
      if (!rows.has(id)) say(`${entity}:${id} is cold but gone from the feed`)
    }
  }
  return out
}
