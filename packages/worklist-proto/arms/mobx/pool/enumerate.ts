/**
 * POD-4565 (Ma1) — the ENUMERATION MODULE (`fence.json`): the only place in
 * the pool that walks a whole table. The lint fence (`no-table-walk`)
 * refuses a table walk anywhere else in `pool/`.
 *
 * Three walks, all membership-sized by nature:
 * - `issueIdsOf`: every RESIDENT issue id (`MobxPool.issueIds`: the
 *   rebuild's residency input and the tests). The worklist no longer reads it
 *   (POD-4569). It iterates the table's KEYS, touching membership only,
 *   so the enclosing computed subscribes to membership only and the walk
 *   costs what it walks.
 * - `builtIds`: the rows of one entity whose object the pool has built (a
 *   `replace` releases the ones it no longer knows, `MobxPool.followHeldOut`).
 *   Sized by what was built, never by the table.
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

/** Every issue id in the pool; tracked on membership. */
export function issueIdsOf(pool: { readonly tables: PoolTables }): string[] {
  return [...pool.tables.issue.keys()]
}

/** The ids whose object the pool has built for one entity (a `replace` releases the unknown ones). */
export function builtIds(models: ReadonlyMap<string, unknown>): string[] {
  return [...models.keys()]
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

/**
 * Every row a lazy pool KNOWS, in plain tables (POD-4567), read from the FEED
 * alone: its issues and sessions (cold ones included, which the engine links
 * by id though the pool's tables never hold them) and its worktree records,
 *   which give the lanes and the repos exactly as the pool's own ingest does
 *   (the shared `repo-from-lane.ts` composition). Until POD-4572 (Mb4) the never-cold
 * entities came from the pool's own tables, as Ma2's check read them; the
 * reason Ma2 gave (the feed never announced discovery-only lanes) closed with
 * POD-4606 (ca53a62d5), so the relation check no longer leans on the state it
 * checks. `pool` is kept for the callers' signature. What a relation check
 * holds a lazy pool's engine to.
 */
export function knownTables(
  _pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
): TableSet<Map<string, StoredRow>> {
  const tables = createPlainTables()
  const target: IngestTarget = { read: tables, write: tables }
  const out = ingestOut()
  for (const kind of ['session', 'issue', 'worktree'] as const) {
    for (const record of source.snapshot(kind)) ingestRecord(target, record, out)
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
 * keys PLUS every `alsoRoots` source (POD-4671: issue worktreePaths); each
 * collection is the sorted inverse. Answers as a `RelationReader` (`one`
 * checks the target's presence, as the engine does — for a prefix with
 * `alsoRoots` presence is the same union).
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
  // POD-4671: presence for a prefix with `alsoRoots` is the union, so the
  // scan holds it beside the forward slots (one() reads it, as the engine does).
  // A belongsTo onto the same target (issue.worktree) resolves in the same
  // union — an issue is checked out at its own path with no lane.
  const unionPresence = new Map<string, Set<string>>()
  const unionByTarget = new Map<EntityName, Set<string>>()
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (!isLinkSpec(spec)) continue
      const pointers = new Map<string, string>()
      const buckets = new Map<string, string[]>()
      // One resolution per distinct path: sessions share their lane's cwd.
      let roots: string[] = []
      if (spec.kind === 'prefix') {
        roots = [...tables[spec.to].keys()]
        const extra = extraRootsOf(spec, (entity) => {
          const table = (tables as Record<string, { entries(): IterableIterator<[string, unknown]> }>)[
            entity
          ]
          if (table === undefined) return undefined
          return (function* () {
            for (const [, row] of table.entries()) yield row
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
  // POD-4758: every declared subset, from scratch — the scanned bucket
  // filtered by the subset's own test over each member's row, the same
  // declaration the engines maintain at the delta (POD-4671 ruling Sep27).
  const subsets = new Map<string, Map<string, readonly string[]>>()
  for (const from of entities) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (spec.kind !== 'hasMany') continue
      for (const [subset, test] of Object.entries(spec.subsets ?? {})) {
        const rows = new Map(tables[spec.to].entries())
        const filtered = new Map<string, readonly string[]>()
        for (const [target, members] of inverse.get(`${from}.${name}`) ?? []) {
          const kept = members.filter((id) => {
            const row = rows.get(id) as Readonly<Record<string, unknown>> | undefined
            return row !== undefined && test.test(row)
          })
          if (kept.length > 0) filtered.set(target, kept)
        }
        subsets.set(`${from}.${name}.${subset}`, filtered)
      }
    }
  }
  const subsetOf = (
    from: EntityName,
    id: string,
    relation: string,
    subset: string,
  ): readonly string[] => {
    const buckets = subsets.get(`${from}.${relation}.${subset}`)
    if (buckets === undefined) throw new Error(`[scan] ${from}.${relation} declares no subset "${subset}"`)
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
    subset: subsetOf,
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
        // The live buckets are unordered (M3 F1); the scan's are sorted.
        const got = isLinkSpec(spec)
          ? live.one(from, id, name)
          : [...live.many(from, id, name)].sort()
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
  // POD-4758: hold every maintained subset to the scan too.
  for (const from of Object.keys(schema) as EntityName[]) {
    for (const [name, spec] of Object.entries(schema[from].relations)) {
      if (spec.kind !== 'hasMany') continue
      for (const subset of Object.keys(spec.subsets ?? {})) {
        const ids = new Set([...tables[from].keys(), ...(extra[from] ?? [])])
        for (const id of ids) {
          const got = [...live.subset(from, id, name, subset)].sort()
          const want = [...scan.subset(from, id, name, subset)]
          if (JSON.stringify(got) === JSON.stringify(want)) continue
          if (out.length < 12) {
            out.push(
              `${from}:${id}.${name}.${subset}: live ${JSON.stringify(got)}, scan ${JSON.stringify(want)}`,
            )
          }
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
  // The rule over the feed at the clock the pool reads it against: every
  // table, since the rule's lane source resolves lanes over the lanes too.
  const known = knownTables(pool, source)
  const ctx = tableColdContext(schema, (entity) => known[entity], residency.now())
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
