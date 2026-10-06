/**
 * POD-4945 — the MobX pool's harness-owned oracle: the from-scratch relation
 * resolution and the slice rebuild the gates and the relation/residency tests
 * hold the live pool to. Moved from `arms/mobx/pool/enumerate.ts`
 * (`knownTables`, `scanRelations`, `diffRelations`, `diffResidency`) and
 * `arms/mobx/pool/rebuild.ts` (all of it): none of it runs in production, so
 * it lives with the harness, which alone imports it. It reads the product
 * pool's tables, engine and views but never the reverse.
 */

import { runInAction } from 'mobx'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import type { RelationReader } from '../../../shared/src/instrument/reads'
import { relationLinks } from '@podium/client-graph/shared/links'
import {
  compareClosedFold,
  groupKeyOf,
  type RowView,
  sliceRowOf,
} from '@podium/client-graph/shared/row-view'
import type {
  SliceGroup,
  SliceIssue,
  SliceSession,
  SliceSnapshot,
} from '@podium/client-graph/shared/slice-types'
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
} from '@podium/client-graph/shared/schema'
import { isLinkSpec, relationRef } from '@podium/client-graph/relations'
import { relationTargets } from '@podium/client-graph/shared/links'
import type { Residency } from '@podium/client-graph/residency'
import type { ColdQueries } from '@podium/client-graph/shared/cold-index'
import {
  createPlainTables,
  ingestOut,
  ingestRecord,
  type PoolTables,
  type StoredRow,
  type TableSet,
} from '@podium/client-graph/tables'
import {
  activityMsOf,
  buildRowView,
  directParts,
  type RepoRow,
  type ViewInputs,
} from '@podium/client-graph/views'
import { repoLabelOf } from '@podium/client-graph/worklist/groups'
import {
  directNested,
  directSessionVisibility,
  directVisibility,
  type IssueVisibility,
  readAtOf,
  type SessionVisibility,
  sortByRank,
  type VisibleInputs,
} from '@podium/client-graph/worklist/visible'

/**
 * Every row a lazy pool KNOWS, in plain tables (POD-4567), read from the FEED
 * alone: its issues and sessions (cold ones included, which the engine links
 * by id though the pool's tables never hold them) and its worktree records,
 * which give the lanes and the repos exactly as the pool's own ingest does
 * (the shared `repo-from-lane.ts` composition). `pool` is kept for the
 * callers' signature. What a relation check holds a lazy pool's engine to.
 */
export function knownTables(
  _pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
): TableSet<Map<string, StoredRow>> {
  const tables = createPlainTables()
  const target = { read: tables, write: tables }
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
      const targetsBySource = new Map<string, string[]>()
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
        if (!spec.uncollapsed && collapsed.has(`${from}:${id}`)) continue
        if (spec.where !== undefined && !spec.where.test(row)) continue
        if (spec.kind === 'edge' && spec.many) {
          const targets = [...relationTargets(from, name, row, schema)].sort()
          targetsBySource.set(id, targets)
          for (const target of targets) buckets.set(target, [...(buckets.get(target) ?? []), id])
          continue
        }
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
      if (spec.kind === 'edge' && spec.many) inverse.set(`${from}.${name}`, targetsBySource)
      else forward.set(`${from}.${name}`, pointers)
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
        const single = isLinkSpec(spec) && !(spec.kind === 'edge' && spec.many)
        const got = single
          ? live.one(from, id, name)
          : [...live.many(from, id, name)].sort()
        const want = single ? scan.one(from, id, name) : [...scan.many(from, id, name)]
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
 * to 12 lines). POD-5407 restates it for a pool that holds no cold registry:
 * - every feed row of an entity that can be cold is resident XOR cold (known
 *   to the cold index and not in the tables), never both, never neither;
 * - a cold row is cold by the rule computed from scratch over the feed;
 * - the index's verdict equals that rule for EVERY feed row (the census of
 *   cold-by-rule rows is equal, row for row);
 * - `ids()` (the cold rows the pool has seen) are cold rows of the feed;
 * - nothing resident is gone from the feed.
 * A resident row that the rule calls cold is fine: it was looked at
 * (`residency.ts`). The gate's partition check.
 */
export function diffResidency(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null; coldIndex(): ColdQueries },
  source: RowSource,
  schema: ModelSchema = SCHEMA,
): string[] {
  // In an action: a check, not a derivation; it subscribes to nothing.
  return runInAction(() => residencyProblems(pool, source, schema))
}

function feedRows(source: RowSource, entity: 'issue' | 'session'): Map<string, object> {
  return new Map(
    source
      .snapshot(entity)
      .filter((record) => record.value !== undefined)
      .map((record) => [record.id, record.value as object]),
  )
}

function residencyProblems(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null; coldIndex(): ColdQueries },
  source: RowSource,
  schema: ModelSchema,
): string[] {
  const residency = pool.residency
  if (residency === null) return ['the pool has no residency']
  const out: string[] = []
  const say = (line: string): void => {
    if (out.length < 12) out.push(line)
  }
  // The rule over the feed at the clock the pool reads it against: every
  // table, since the rule's lane source resolves lanes over the lanes too.
  const known = knownTables(pool, source)
  const now = residency.now()
  const ctx = tableColdContext(schema, (entity) => known[entity], now)
  const index = pool.coldIndex()
  for (const entity of Object.keys(schema) as EntityName[]) {
    if (!residency.capable(entity)) continue
    if (entity !== 'issue' && entity !== 'session') {
      say(`${entity}: can be cold, but the feed has no per-row kind for it`)
      continue
    }
    const rows = feedRows(source, entity)
    for (const [id, row] of rows) {
      const hot = pool.tables[entity].has(id)
      const cold = residency.isCold(entity, id)
      const rule = coldByRule(schema, entity, row, ctx)
      if (hot && cold) say(`${entity}:${id} is both resident and cold`)
      else if (!hot && !cold) say(`${entity}:${id} is in the feed but neither resident nor cold`)
      else if (cold && !rule) say(`${entity}:${id} is cold but the rule keeps it resident`)
      if (index.coldByRule(entity, id, now) !== rule) {
        say(`${entity}:${id}: the index says ${rule ? 'not ' : ''}cold, the rule from scratch says ${rule ? '' : 'not '}cold`)
      }
    }
    for (const id of pool.tables[entity].keys()) {
      if (!rows.has(id)) say(`${entity}:${id} is resident but gone from the feed`)
    }
    for (const id of residency.ids(entity)) {
      if (!rows.has(id)) say(`${entity}:${id} is cold but gone from the feed`)
      else if (pool.tables[entity].has(id)) say(`${entity}:${id} is listed cold but resident`)
    }
  }
  return out
}

/** Every feed row of `entity` the pool does not hold (the cold rows), from the feed. */
export function coldIds(
  pool: { readonly tables: PoolTables },
  source: RowSource,
  entity: 'issue' | 'session',
): string[] {
  return [...feedRows(source, entity).keys()].filter((id) => !pool.tables[entity].has(id))
}

/**
 * POD-5407 — the attach's bound, against the rule computed from scratch: a
 * pool holds no more rows of a cold-capable entity than the feed has rows the
 * rule does not call cold, plus the rows it was asked for since (none, right
 * after an attach), and the attach placed no more than that. An attach that
 * places every row fails it whenever any row is cold.
 */
export function attachProblems(
  pool: { readonly tables: PoolTables; readonly residency: Residency | null },
  source: RowSource,
  schema: ModelSchema = SCHEMA,
): string[] {
  const residency = pool.residency
  if (residency === null) return []
  return runInAction(() => {
    const known = knownTables(pool, source)
    const ctx = tableColdContext(schema, (entity) => known[entity], residency.now())
    const out: string[] = []
    let allowed = 0
    let held = 0
    for (const entity of ['issue', 'session'] as const) {
      for (const row of feedRows(source, entity).values()) if (!coldByRule(schema, entity, row, ctx)) allowed += 1
      held += pool.tables[entity].size
    }
    if (held > allowed) out.push(`the pool holds ${held} rows, the rule keeps ${allowed} resident`)
    const placed = residency.attachStats.rowsPlaced
    if (placed > allowed) out.push(`the attach placed ${placed} rows, the rule keeps ${allowed} resident`)
    return out
  })
}

/**
 * POD-4565 (Ma1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh plain maps, resolves every relation FROM SCRATCH (`scanRelations`
 * above: the declared resolvers over whole tables, none of the live
 * engine's maintenance), and derives every row with the same `buildRowView`
 * as the live models, with the clock and selection read as plain values. So
 * the checker holds the live pool's incremental relation maintenance to a
 * from-scratch resolution, and its derivations to themselves.
 *
 * VISIBILITY (POD-4569). The rows are the VISIBLE issues, decided from
 * scratch by the same part functions the live nodes memoize
 * (`worklist/visible.ts` `directVisibility`, memoized per id for this one
 * pass), over every row the feed holds, cold ones included; the pinned ids
 * in L1b rank order. So the live collection's maintenance (its reactions,
 * its cold-row reads, its node syncing) is held to a from-scratch answer.
 * Residency no longer shapes the row set: the live `snapshot()` loads every
 * visible cold row and settles first, and every row here reads full data
 * (`loading` is always false).
 *
 * ROLL-UPS (POD-4571). The same part functions over the same parts object
 * (`directVisibility` memoizes them for this pass), composing over the nest
 * children inverted from scratch (`directNested`) and the scanned `children`
 * relation: the live pool's maintained nest index and its per-node memos are
 * held to a from-scratch answer. Every row is resident here, so nothing is
 * pending.
 *
 * WHOLE VIEWS (POD-4674, H3-F3). `rebuildSnapshot` projects each view to the
 * slice fields (`sliceRowOf`), so the checker never compares `activityAt`,
 * `originTick`, `selected` and the other view-only fields. `rebuildViews` is
 * the same run, keeping each whole `RowView`: the gate holds every visible
 * issue's live view to it at every compared step (`diffViews`, `check.ts`).
 *
 * GROUPS (POD-4570). The rebuild groups its own row views with L1b's pure
 * functions (`groupKeyOf`, `compareClosedFold`, `shared/src/row-view.ts`),
 * with no selection (the oracle's unselected baseline, spec §7), not with the
 * live layout's `layoutOf`: the live pool's placement parts and its layout
 * are held to the contract's own grouping.
 */
export function rebuildSnapshot(source: RowSource, locals: LocalsSource): SliceSnapshot {
  const { views, issue } = rebuild(source, locals)
  const rowsById: SliceSnapshot['rowsById'] = {}
  const pinnedIds: string[] = []
  const groups = new Map<string, { group: SliceGroup; closed: RowView[] }>()
  for (const [id, view] of views) {
    rowsById[id] = sliceRowOf(view)
    const placement = groupKeyOf({ ...view, selected: false }, {})
    if (placement.section === 'pinned') {
      pinnedIds.push(id)
      continue
    }
    let entry = groups.get(placement.repoKey)
    if (entry === undefined) {
      const label = repoLabelOf((issue(id) as SliceIssue).repoPath)
      entry = { group: { key: placement.repoKey, label, rowIds: [], closedIds: [] }, closed: [] }
      groups.set(placement.repoKey, entry)
    }
    if (placement.lane === 'closed') entry.closed.push(view)
    else entry.group.rowIds.push(id)
  }
  const sliceGroups = [...groups.values()].map(({ group, closed }) => ({
    ...group,
    closedIds: closed.sort(compareClosedFold).map((view) => view.id),
  }))
  return { order: { pinnedIds, groups: sliceGroups }, rowsById }
}

/** The rebuild's rows as whole views: the visible issues, keyed by id, in rank order. */
export function rebuildViews(source: RowSource, locals: LocalsSource): Map<string, RowView> {
  return rebuild(source, locals).views
}

function rebuild(
  source: RowSource,
  locals: LocalsSource,
): { views: Map<string, RowView>; issue: ViewInputs['issue'] } {
  const tables = createPlainTables()
  const target = { read: tables, write: tables }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)

  const { coarseNow, selectedIssueId } = locals.get()
  const inputs: ViewInputs = {
    links: relationLinks(scanRelations(tables)),
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    sessionActivity: (id) => activityMsOf(tables.session.get(id) as SliceSession | undefined),
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    rollup: (id) =>
      tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).rollup : undefined,
    retainedSeats: (id) =>
      tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).retainedSeatIds : [],
    // The maintained SORTED seat list, from scratch sorted (the live pool reads
    // its maintained SORTED mirror without iterating it).
    seatList: (id) => [...inputs.links.issue.sessions.ids(id)].sort(),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const memo = new Map<string, IssueVisibility>()
  const sessions = new Map<string, SessionVisibility>()
  let nested: ReadonlyMap<string, readonly string[]> | null = null
  const visibleInputs: VisibleInputs = {
    links: inputs.links,
    issueRow: inputs.issue,
    sessionRow: inputs.session,
    issue: (id) => (tables.issue.has(id) ? directVisibility(visibleInputs, id, memo) : undefined),
    session: (id) => {
      let parts = sessions.get(id)
      if (parts === undefined) {
        parts = directSessionVisibility(visibleInputs, id)
        sessions.set(id, parts)
      }
      return parts
    },
    passed: inputs.passed,
    reached: inputs.reached,
    loadedIssue: inputs.issue,
    issueRead: (id) => {
      const row = tables.issue.get(id) as SliceIssue | undefined
      return row === undefined ? undefined : readAtOf(row.readAt)
    },
    loadedSession: inputs.session,
    nested: (id) => {
      nested ??= directNested(
        issues.map((record) => record.id),
        (issueId) => directVisibility(visibleInputs, issueId, memo),
      )
      return nested.get(id) ?? []
    },
    // The scanned `children` relation, from scratch (the live pool files each node's parent slot).
    formalChildren: (id) =>
      tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).childIds : [],
    // From scratch, sorted (the live pool reads its maintained SORTED mirror
    // without iterating it).
    seatList: (id) => [...inputs.links.issue.sessions.ids(id)].sort(),
  }
  const visible = issues
    .map(({ id }) => id)
    .filter((id) => directVisibility(visibleInputs, id, memo).visible)
  const order = sortByRank(visible, (id) => directVisibility(visibleInputs, id, memo).rank)
  const views = new Map<string, RowView>()
  for (const id of order) {
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) views.set(id, view)
  }
  return { views, issue: inputs.issue }
}
