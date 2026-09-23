/**
 * POD-4578 (Ha1) — the ENUMERATION MODULE (`arms/hand/fence.json`): the only
 * place in the pool that walks a whole table. The lint fence
 * (`no-table-walk`) refuses a table walk anywhere else in `pool/`.
 *
 * Each walk is sized by what it must see:
 * - `issueIdsOf`: every issue id, for the a1 list and `snapshot()`, until
 *   Hb1 (POD-4582) builds the visible collection. It walks the fenced
 *   table's KEYS (the fence counts each id without reading its value,
 *   POD-4621) inside the list's cell, which records the table's membership
 *   as its one input: a rename does not re-run it; an add or a removal does.
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, as one
 *   event.
 * - `scanRelations` / `diffRelations` (POD-4579): every declared relation
 *   resolved FROM SCRATCH by walking the tables — the collapse by grouping
 *   every row, the prefix relation by `longestPrefixPath` over every root —
 *   sharing nothing with the engine's maintenance but the declared resolvers
 *   and `relationRef`. The gate and `relations.test.ts` hold the engine to it
 *   after every step; the pool itself never calls it.
 *
 * Ha1's `otherLaneOf` (a walk of the worktree table when a repo's lane left)
 * is gone: the maintained `repo.worktrees` collection answers it (`tables.ts`).
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
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
  createTables,
  drop,
  ENTITIES,
  type IngestOut,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  put,
  type TableSet,
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
 * not rewritten) and drops the rest, each write maintaining the relations.
 * The staging tables keep no relations, so a record named twice is staged
 * once, as its last value: no lane in staging ever hands its repo over.
 */
export function reseed(target: IngestTarget, rows: readonly RowRecord[], out: IngestOut): void {
  const incoming = createTables()
  const staging: IngestTarget = { read: incoming, write: incoming }
  const scratch = ingestOut()
  const last = new Map<string, RowRecord>()
  for (const record of rows) {
    const key = `${record.kind}\u0000${record.id}`
    last.delete(key)
    last.set(key, record)
  }
  for (const record of last.values()) ingestRecord(staging, record, scratch)
  for (const entity of ENTITIES) {
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of target.write[entity].keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}

/** A table set the scan can walk. */
export type ScannableTables = TableSet<ReadonlyMap<string, unknown>>

const NO_IDS: readonly string[] = Object.freeze([])

/**
 * Every declared relation of every row, resolved from scratch over `tables`,
 * as a `RelationReader` (collections sorted). `collapsed` names the rows the
 * entity's collapse rule removes, as `entity:id`.
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
    for (const [id, row] of tables[entity]) {
      const key = rule.groupKey(row as Readonly<Record<string, unknown>>)
      if (key === null) continue
      groups.set(key, [
        ...(groups.get(key) ?? []),
        { id, row: row as Readonly<Record<string, unknown>> },
      ])
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
      const roots = spec.kind === 'prefix' ? [...tables[spec.to].keys()] : []
      for (const [id, value] of tables[from]) {
        const row = value as Readonly<Record<string, unknown>>
        if (collapsed.has(`${from}:${id}`)) continue
        if (spec.where !== undefined && !spec.where.test(row)) continue
        let target: string | null
        if (spec.kind === 'prefix') {
          const path = row[spec.sourceField]
          target = typeof path === 'string' ? longestPrefixPath(path, roots) : null
        } else {
          target = relationRef(spec, row, schema)
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
 * Every answer of `live` that differs from a from-scratch `scanRelations` of
 * `tables`, for every row in them plus the `extra` ids (targets that may have
 * left), up to 12 lines. Collections compare as sorted sets: a bucket has no
 * order (`relations.ts`).
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
        let got: unknown
        let want: unknown
        if (isLinkSpec(spec)) {
          got = live.one(from, id, name)
          want = scan.one(from, id, name)
        } else {
          const members = [...live.many(from, id, name)].sort()
          const size = live.size(from, id, name)
          got = size === members.length ? members : { members, size }
          want = [...scan.many(from, id, name)]
        }
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
