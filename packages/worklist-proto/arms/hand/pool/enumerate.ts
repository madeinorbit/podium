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
 * - `knownIssueIds`: every issue id the pool knows, hot or cold, which the
 *   pool re-files at a `replace`.
 * - `reseed`: a `replace` publication (bootstrap, principal switch, rescope)
 *   installs the new slice and removes every row it does not name, as one
 *   event. With residency (POD-4580) it re-partitions: it walks the cold
 *   registry for the ids the slice no longer names.
 * - `scanRelations` / `diffRelations` (POD-4579): every declared relation
 *   resolved FROM SCRATCH by walking the tables — the collapse by grouping
 *   every row, the prefix relation by `longestPrefixPath` over every root —
 *   sharing nothing with the engine's maintenance but the declared resolvers
 *   and `relationRef`. The gate and `relations.test.ts` hold the engine to it
 *   after every step; the pool itself never calls it.
 *
 * - `knownTables` / `diffResidency` (POD-4580): every row a lazy pool KNOWS,
 *   from the feed, for the relation check; and the hot/cold partition held to
 *   the feed's rows. The gate's, never the pool's.
 *
 * Ha1's `otherLaneOf` (a walk of the worktree table when a repo's lane left)
 * is gone: the maintained `repo.worktrees` collection answers it (`tables.ts`).
 */

import type { RowSource } from '../../../shared/src/arm'
import type { RelationReader } from '../../../shared/src/instrument/reads'
import {
  type CollapseMember,
  coldByRule,
  collapseLosers,
  type EntityName,
  extraRootsOf,
  longestPrefixPath,
  type ModelSchema,
  SCHEMA,
  tableColdContext,
  viaTargetOf,
} from '../../../shared/src/schema'
import type { RowRecord } from '../../../shared/src/stats'
import { isLinkSpec, relationRef } from './relations'
import type { Residency } from './residency'
import {
  createTables,
  drop,
  ENTITIES,
  type IngestOut,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  put,
  type StoredRow,
  type TableSet,
  type Tables,
} from './tables'

/** Every issue id in `issue`, in table order; the fence counts each id. */
export function issueIdsOf(issue: { keys(): IterableIterator<string> }): string[] {
  return [...issue.keys()]
}

/**
 * Every issue id the pool KNOWS: the resident ones (the table's keys) plus
 * the cold registry's. The pool re-files all of them at a `replace`; an
 * update re-files only the ids it names. (Mirrors the MobX pool's
 * `knownIssueIds`.)
 */
export function knownIssueIds(pool: {
  readonly tables: Tables
  readonly residency: Residency | null
}): string[] {
  return [...pool.tables.issue.keys(), ...(pool.residency?.ids('issue') ?? [])]
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
export function reseed(
  target: IngestTarget,
  rows: readonly RowRecord[],
  out: IngestOut,
  residency?: Residency,
  pinned?: (entity: EntityName, id: string) => boolean,
): void {
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
  const staged = (to: EntityName, id: string): object | undefined => incoming[to].get(id)
  residency?.reindex((entity) => incoming[entity])
  for (const entity of ENTITIES) {
    const next = incoming[entity]
    const gone: string[] = []
    for (const id of target.write[entity].keys()) if (!next.has(id)) gone.push(id)
    for (const id of gone) drop(target, entity, id, out)
    if (residency?.capable(entity) === true) {
      // POD-4580: re-partition. Cold rows the slice no longer names are
      // forgotten; every named row is placed by the rule over the new slice
      // (POD-4706: a resident row the rule calls cold is evicted, except a
      // row the caller pins — a pending edit holds its row).
      for (const id of residency.ids(entity))
        if (!next.has(id)) residency.forget(target, entity, id)
      for (const [id, row] of next)
        residency.place(target, entity, id, row, staged, out, pinned?.(entity, id) ?? false)
      continue
    }
    for (const [id, row] of next) put(target, entity, id, row, out)
  }
}

/** A table set the scan can walk. */
export type ScannableTables = TableSet<ReadonlyMap<string, unknown>>

const NO_IDS: readonly string[] = Object.freeze([])

/**
 * Every declared relation of every row, resolved from scratch over `tables`,
 * as a `RelationReader` (collections sorted). `collapsed` names the rows the
 * entity's collapse rule removes, as `entity:id`. A `prefix` with `alsoRoots`
 * (POD-4671) resolves over the target keys PLUS every listed source's values,
 * and `one()` holds to that same union.
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
  const unionPresence = new Map<string, Set<string>>()
  const unionByTarget = new Map<EntityName, Set<string>>()
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec)) continue
      const pointers = new Map<string, string>()
      const buckets = new Map<string, string[]>()
      let roots: string[] = []
      if (spec.kind === 'prefix') {
        roots = [...tables[spec.to].keys()]
        const extra = extraRootsOf(spec, (entity) => {
          const table = (tables as Record<string, ReadonlyMap<string, unknown> | undefined>)[entity]
          if (table === undefined) return undefined
          return (function* () {
            for (const [, row] of table) yield row
          })()
        })
        if (extra.length > 0) {
          const seen = new Set(roots)
          for (const root of extra) {
            if (!seen.has(root)) {
              seen.add(root)
              roots.push(root)
            }
          }
          const union = new Set(roots)
          unionPresence.set(`${from}.${name}`, union)
          const prev = unionByTarget.get(spec.to)
          if (prev === undefined) unionByTarget.set(spec.to, new Set(union))
          else for (const root of union) prev.add(root)
        }
      }
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
  // POD-4671 ruling Sep27: the scan's issueless sets, from scratch — the same
  // filter the engines maintain at the delta (members with no `issueId`).
  const issuelessByCollection = new Map<string, Map<string, string[]>>()
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec)) continue
      if (spec.kind !== 'prefix') continue
      if ((schema[from].fields as Record<string, unknown>).issueId === undefined) continue
      const buckets = inverse.get(`${spec.to}.${spec.inverse}`)
      if (buckets === undefined) continue
      const filtered = new Map<string, string[]>()
      for (const [target, members] of buckets) {
        const kept = members.filter((id) => {
          const row = tables[from].get(id) as Readonly<Record<string, unknown>> | undefined
          return row !== undefined && row.issueId === undefined
        })
        if (kept.length > 0) filtered.set(target, kept)
      }
      issuelessByCollection.set(`${spec.to}.${spec.inverse}`, filtered)
      void name
    }
  }
  const issuelessOf = (from: EntityName, id: string, relation: string): readonly string[] => {
    const buckets = issuelessByCollection.get(`${from}.${relation}`)
    if (buckets === undefined) throw new Error(`[scan] ${from}.${relation} has no issueless index`)
    return buckets.get(id) ?? NO_IDS
  }
  return {
    collapsed,
    one(from, id, relation) {
      const pointers = forward.get(`${from}.${relation}`)
      if (pointers === undefined) throw new Error(`[scan] ${from}.${relation} is not single-valued`)
      const target = pointers.get(id)
      if (target === undefined) return null
      const union = unionPresence.get(`${from}.${relation}`)
      if (union !== undefined) return union.has(target) ? target : null
      const to = schema[from].relations[relation]?.to as EntityName
      if (tables[to].has(target)) return target
      const byTarget = unionByTarget.get(to)
      return byTarget?.has(target) === true ? target : null
    },
    many: bucketOf,
    size: (from, id, relation) => bucketOf(from, id, relation).length,
    issueless: issuelessOf,
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
  // POD-4671 ruling Sep27: hold the maintained issueless sets to the scan too.
  for (const from of Object.keys(schema) as EntityName[]) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec) || spec.kind !== 'prefix') continue
      if ((schema[from].fields as Record<string, unknown>).issueId === undefined) continue
      const ids = new Set([...tables[spec.to].keys(), ...(extra[spec.to] ?? [])])
      for (const id of ids) {
        const got = [...live.issueless(spec.to, id, spec.inverse)].sort()
        const want = [...scan.issueless(spec.to, id, spec.inverse)]
        if (JSON.stringify(got) === JSON.stringify(want)) continue
        if (out.length < 12) {
          out.push(
            `${spec.to}:${id}.${spec.inverse}.issueless: live ${JSON.stringify(got)}, scan ${JSON.stringify(want)}`,
          )
        }
      }
      void name
    }
  }
  return out
}

/**
 * Every row a lazy pool KNOWS, in plain tables (POD-4580): for an entity that
 * can be cold, the feed's current rows (cold ones included, which the engine
 * links by id though the pool's tables never hold them); for one that never
 * is, the feed's rows too, routed through the same ingest (a lane carries its
 * repo), so nothing here leans on the pool's own state. What the gate's
 * relation check holds the live engine to.
 */
export function knownTables(source: RowSource): Tables {
  const tables = createTables()
  const target: IngestTarget = { read: tables, write: tables }
  const out = ingestOut()
  for (const kind of ['session', 'issue', 'worktree'] as const) {
    for (const record of source.snapshot(kind)) ingestRecord(target, record, out)
  }
  return tables
}

/**
 * The pool's residency against the feed's CURRENT rows, as problems (up to
 * 12 lines): every row of a cold-capable entity is resident or cold, never
 * both, never neither; a cold row is cold by the rule (over the feed's rows)
 * and registered under the row it inherits from; nothing resident or cold is
 * gone from the feed. A resident row the rule calls cold is fine: it was
 * looked at (`residency.ts`). The gate's partition check.
 */
export function diffResidency(
  pool: { readonly tables: Tables; readonly residency: Residency | null },
  source: RowSource,
  schema: ModelSchema = SCHEMA,
): string[] {
  const residency = pool.residency
  if (residency === null) return ['the pool has no residency']
  const out: string[] = []
  const say = (line: string): void => {
    if (out.length < 12) out.push(line)
  }
  const feed = new Map<EntityName, Map<string, StoredRow>>()
  for (const kind of ['issue', 'session'] as const) {
    const rows = new Map<string, StoredRow>()
    for (const record of source.snapshot(kind)) {
      if (record.value !== undefined) rows.set(record.id, record.value as StoredRow)
    }
    feed.set(kind, rows)
  }
  // The rule over the feed at the clock the pool reads it against.
  const ctx = tableColdContext(schema, (entity) => feed.get(entity), residency.now())
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
      else if (cold && !coldByRule(schema, entity, row, ctx)) {
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
