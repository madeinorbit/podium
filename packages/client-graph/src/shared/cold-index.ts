/**
 * POD-5405 — THE COLD INDEX: the residency rule's inputs for every row the
 * feed carries, held outside the pool, behind declared questions.
 *
 * WHY. A pool's attach used to place every replica row by the rule
 * (`enumerate.ts` `reseed`), so its cost grew with history: 99% of the phone's
 * 11k rows are cold (POD-5391). To attach with the resident rows only, some
 * component must answer "is this row cold by the rule, now?" and "which rows
 * are not?" for rows the pool never placed. This is that component.
 *
 * WHAT IT HOLDS. Per row of a cold-capable entity, the RULE ROW: only the
 * declared fields `coldByRule` reads of it (`dependsOn`, `canShow.fields`,
 * the key, a lane's `through` key, a `via` foreign key and its `unbound`
 * fields, a lane member's keep fields), never the row. The indexes the rule
 * asks through: members' keeps by owner, a `via` entity's rows by target,
 * and the rows whose deadlines have not yet all passed. A lane's seats (the
 * `prefix` relation, its `alsoRoots` union and its subset) and the collapse
 * verdicts come from the RELATION INDEX it holds (POD-5407,
 * `relation-index.ts`): every declared relation over every row, kept once
 * here. The pool's relation reader is a view of that same index, so no
 * relation fact is kept twice.
 *
 * ONE RULE. Every answer evaluates the schema's own `coldByRule` against a
 * held rule row, through a `ColdContext` backed by these indexes. Nothing
 * here restates the rule: a rule change in `schema.ts` needs no change here
 * unless it reads a field its declaration does not list (the equality proof
 * against `tableColdContext` over whole rows catches that).
 *
 * WHAT IT CONSUMES. The row source's publications, exactly as a pool does:
 * one `replace` (or a seeding snapshot), then `update`s, record by record
 * (`value: undefined` removes). It therefore knows what a pool that placed
 * every row would know, and nothing it was not told.
 *
 * DECLARED QUESTIONS ONLY (POD-4286's cutoff rule). Readers receive
 * {@link ColdQueries}, never a map. A later memory cutoff can answer the
 * same questions from storage.
 *
 * COST. A publication costs O(its records) plus the bounded fan-out the rule
 * already implies: a member's owner, a lane root's owners, a collapse group,
 * a target's dependents. `residentCandidates` visits the rows that are open
 * or whose latest deadline is still ahead (a superset of the resident rows),
 * and the dependents of those, never the cold rest. The one exception is a
 * clock rewind below the highest clock it has answered for. Expiry is
 * monotone (deadlines only pass), so it then rescans every held row once.
 */

import {
  type ColdContext,
  type ColdSpec,
  coldByRule,
  coldFinishOf,
  coldFlatUntil,
  type EntityName,
  keeperOf,
  keepDeadline,
  keptByKey,
  type KeptBySpec,
  laneKeepOf,
  type LaneSource,
  laneSources,
  type MemberKeep,
  type ModelSchema,
  viaTargetOf,
} from './schema'
import type { RowRecord, RowSourceEvent } from './source'
import { createReaderIndex, type ReaderQuestion } from './reader-questions'
import { createSessionActivityIndex, type SessionActivityQuestion } from './session-activity'
import { createRelationIndex, type RelationDelta, type RelationQueries } from './relation-index'

type Row = Readonly<Record<string, unknown>>

/** The questions the cold index answers. The only surface readers get. */
export interface ColdQueries {
  /** Publications applied so far: a reader's memo key. */
  readonly version: number
  /** Whether the feed carries the row (any entity the index tracks). */
  known(entity: EntityName, id: string): boolean
  /** How many rows of `entity` the feed carries. */
  count(entity: EntityName): number
  /** `coldByRule` for the row at `now` (false for an unknown row or a never-cold entity). */
  coldByRule(entity: EntityName, id: string, now: number): boolean
  /**
   * POD-5407 — `coldByRule` for `row` (a value in hand, possibly newer than
   * the index's) at `now`, every other fact from the index.
   */
  coldRow(entity: EntityName, row: object, now: number): boolean
  /**
   * Every known row of a cold-capable entity that is NOT cold by rule at
   * `now`, in no particular order. Visits only rows that are open or have a
   * deadline at or after `now`, not the cold rest.
   */
  residentCandidates(entity: EntityName, now: number): string[]
  /** Membership/order changes relevant to history readers (not heartbeats). */
  readonly readerVersion: number
  readerRevision(question: ReaderQuestion): number
  readonly issueRepoRevision: number
  readonly sessionRevision: number
  readerIds(question: ReaderQuestion): string[]
  /** Membership of one changed identity, without reconstructing the answer. */
  readerContains(question: ReaderQuestion, id: string): boolean
  issueRepoIds(repoPath?: string): string[]
  sessionCollapsed(id: string): boolean
  sessionOrderKey(id: string): string
  readerActivity(question: SessionActivityQuestion): number
  readerActivityRevision(question: SessionActivityQuestion): number
  readonly readerActivityVisits: number
  /** POD-5407 — every declared relation over every row the feed carries. */
  readonly relations: RelationQueries
  /**
   * POD-5407 — what applying `event` moved in {@link relations}: the delta of
   * the publication the index applied last when it is `event`, else nothing
   * (an event that reached a reader without passing the index moved nothing
   * the index holds).
   */
  changes(event: RowSourceEvent): RelationDelta
  /** POD-5407 — the rows of the `via` entity `entity` that name `to:id` by their raw foreign key. */
  dependents(entity: EntityName, to: EntityName, id: string): Iterable<string>
  /**
   * POD-5407 — the latest instant anything could show a cold `unlessShown`
   * row before nesting (`coldFlatUntil`), from its held rule row; undefined
   * for an unknown row or another kind of entity.
   */
  flatUntil(entity: EntityName, id: string, now: number): number | undefined
  /** POD-5407 — how many rows of `entity` the feed carries with no `deletedAt`. */
  undeleted(entity: EntityName): number
  /**
   * POD-5407 — `fields` of a known row, when the index holds every one of
   * them (the rule's own inputs); undefined otherwise, and the caller reads
   * the row through the one per-row reader. Absent values are left out.
   */
  heldFields(entity: EntityName, id: string, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined
  /**
   * POD-5407 — a session's arrival position in the feed: its place in the
   * last `replace`, else after every row before it (the settings list's
   * legacy order). Undefined for an unknown row.
   */
  position(entity: 'session', id: string): number | undefined
  /** Bumped whenever a position is given or taken. */
  readonly positionVersion: number
}

export interface ColdIndex extends ColdQueries {
  apply(event: RowSourceEvent): void
  /** Whether every row it keeps holds these declared summary fields. */
  holds(summaries: HeldSummaries): boolean
}

/**
 * POD-5407 — declared summary fields the index also keeps per row, next to the
 * rule's own inputs, so a cold row's declared summary is answered from the
 * index (`heldFields`) and never costs a row read. A pool names them
 * (`PoolSummaryFields`); fields of an entity that is never cold are ignored.
 */
export type HeldSummaries = Partial<Record<EntityName, readonly string[]>>

function pick(row: Row, fields: readonly string[]): Row {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = row[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

const NO_IDS: readonly string[] = Object.freeze([])
const NO_KEEPS: readonly MemberKeep[] = Object.freeze([])

function fieldsDeclare(schema: ModelSchema, entity: EntityName, field: string): boolean {
  return Object.hasOwn(schema[entity].fields, field)
}

/** The fields `coldByRule` reads of a row of `entity`, from its declaration. */
function ruleFields(schema: ModelSchema, entity: EntityName, lanes: readonly LaneSource[]): string[] {
  const spec: ColdSpec = schema[entity].cold
  const fields = new Set<string>([schema[entity].key])
  if (spec.kind === 'own') for (const field of spec.dependsOn) fields.add(field)
  if (spec.kind === 'unlessShown') {
    for (const field of spec.dependsOn) fields.add(field)
    for (const field of spec.canShow?.fields ?? []) fields.add(field)
    for (const lane of lanes) if (lane.owner === entity) fields.add(lane.through.foreignKey)
  }
  if (spec.kind === 'via') {
    const relation = schema[entity].relations[spec.relation]
    if (relation?.kind === 'belongsTo') fields.add(relation.foreignKey)
    for (const field of spec.unbound?.dependsOn ?? []) fields.add(field)
  }
  // A lane member's keep is read from its rule row (`laneKeepOf`).
  for (const lane of lanes) {
    if (lane.member !== entity) continue
    for (const field of lane.subset.fields) fields.add(field)
    for (const field of lane.source.dependsOn) fields.add(field)
  }
  if (fieldsDeclare(schema, entity, 'deletedAt')) fields.add('deletedAt')
  return [...fields]
}

export function createColdIndex(schema: ModelSchema, summaries: HeldSummaries = {}): ColdIndex {
  const readers = createReaderIndex()
  const relations = createRelationIndex(schema)
  let collapseVersion = 0
  const noDelta: RelationDelta = { forwards: [], buckets: [], subsets: [], flips: [], orders: [], roots: [] }
  let delta = noDelta
  /** The publication `delta` belongs to. */
  let deltaOf: RowSourceEvent | null = null
  const lanes = laneSources(schema)
  const entities = (Object.keys(schema) as EntityName[]).filter(
    (entity) => schema[entity].cold.kind !== 'never',
  )
  const fieldsOf = new Map(entities.map((entity) => [entity, ruleFields(schema, entity, lanes)]))
  /**
   * The declared summary fields that are not rule inputs, per entity, in a
   * fixed order: each row keeps their values as one dense array (`extras`),
   * not as properties of its rule row. A row object grown property by
   * property over ~40 declared fields costs several times the array.
   */
  const extraOf = new Map(
    entities.map((entity) => {
      const rule = new Set(fieldsOf.get(entity))
      return [entity, [...new Set(summaries[entity] ?? [])].filter((field) => !rule.has(field))]
    }),
  )
  const extraAt = new Map(
    [...extraOf].map(([entity, fields]) => [entity, new Map(fields.map((field, at) => [field, at]))]),
  )
  const heldOf = new Map(
    entities.map((entity) => [entity, new Set([...fieldsOf.get(entity)!, ...extraOf.get(entity)!])]),
  )
  /** Cold-capable entity → id → rule row. */
  const rules = new Map<EntityName, Map<string, Row>>(entities.map((entity) => [entity, new Map()]))
  /** Cold-capable entity → id → its declared extra fields' values, in `extraOf` order. */
  const extras = new Map<EntityName, Map<string, unknown[]>>(
    entities.filter((entity) => extraOf.get(entity)!.length > 0).map((entity) => [entity, new Map()]),
  )
  /** Lane-target entities (`worktree`): ids only. */
  const plain = new Map<EntityName, Set<string>>()
  for (const lane of lanes) if (!plain.has(lane.prefix.to)) plain.set(lane.prefix.to, new Set())
  /** Per cold-capable entity declaring `deletedAt`: how many rows have none. */
  const undeleted = new Map<EntityName, number>()
  for (const entity of entities) if (fieldsDeclare(schema, entity, 'deletedAt')) undeleted.set(entity, 0)

  // Members sources: source → owner id → member id → keep; member → where it is filed.
  const byOwner = new Map<KeptBySpec, Map<string, Map<string, MemberKeep>>>()
  const memberOf = new Map<string, { readonly source: KeptBySpec; readonly owner: string }>()

  const activity = createSessionActivityIndex((id) => relations.collapsed('session', id))

  // `via` entities: target id → the ids naming it by the raw foreign key.
  const byTarget = new Map<EntityName, Map<string, Set<string>>>()
  for (const entity of entities) if (schema[entity].cold.kind === 'via') byTarget.set(entity, new Map())

  // Deadlines. `alive`: unlessShown rows whose predicate holds and whose latest
  // deadline (own or any keeper's, canShow aside) is at or after `high`.
  // `open`: rows whose predicate does not hold (never cold). `unboundAlive`:
  // `via` rows with no target that are not yet past their own decay.
  const open = new Map<EntityName, Set<string>>()
  const alive = new Map<EntityName, Map<string, number>>()
  const unboundAlive = new Map<EntityName, Map<string, number>>()
  for (const entity of entities) {
    const kind = schema[entity].cold.kind
    if (kind === 'unlessShown' || kind === 'own') {
      open.set(entity, new Set())
      alive.set(entity, new Map())
    }
    if (kind === 'via') unboundAlive.set(entity, new Map())
  }
  let high = Number.NEGATIVE_INFINITY
  let version = 0
  /** Sessions' arrival positions (`position`). */
  const positions = new Map<string, number>()
  let positionSeq = 0
  let positionVersion = 0
  /** Rows whose deadlines this publication may have moved, re-filed once its rows are in. */
  const dirty = new Map<string, readonly [EntityName, string]>()

  // ------------------------------------------------------------- context

  function context(now: number): ColdContext {
    const memo = new Map<string, boolean>()
    const ctx: ColdContext = {
      now,
      summary: (entity, id) => {
        const spec = schema[entity].cold
        const row = rules.get(entity)?.get(id)
        if (row === undefined || spec.kind !== 'unlessShown' || spec.canShow === undefined) return undefined
        return Object.fromEntries(spec.canShow.fields.map((field) => [field, row[field]]))
      },
      coldTarget: (to, id) => {
        const key = `${to}:${id}`
        const known = memo.get(key)
        if (known !== undefined) return known
        const row = rules.get(to)?.get(id)
        const cold = row !== undefined && coldByRule(schema, to, row, ctx)
        memo.set(key, cold)
        return cold
      },
      keeps: (_entity, source, key) => keepsAt(source, key),
    }
    return ctx
  }

  /**
   * The keeps `source` holds at `key`: a `members` source from its index; a
   * `lane` source from the relation index's subset at the lane named `key`
   * (its seated members, never a scan) and each one's keep.
   */
  function keepsAt(source: KeptBySpec, key: string): Iterable<MemberKeep> {
    if (source.kind === 'members') return byOwner.get(source)?.get(key)?.values() ?? NO_KEEPS
    const lane = lanes.find((found) => found.source === source)
    if (lane === undefined) return NO_KEEPS
    const out: MemberKeep[] = []
    for (const member of relations.subset(lane.lane, key, lane.relation, lane.subsetName)) {
      const row = rules.get(lane.member)?.get(member)
      const keep = row === undefined ? null : laneKeepOf(lane, row)
      if (keep !== null) out.push(keep)
    }
    return out
  }

  // ------------------------------------------------------------- deadlines

  /** The latest instant anything could show `id` (canShow aside), for an unlessShown row. */
  function latest(entity: EntityName, row: Row): number {
    const spec = schema[entity].cold
    if (spec.kind !== 'unlessShown') return Number.POSITIVE_INFINITY
    let until = spec.shownUntil(row)
    const finish = spec.finishOf(row)
    for (const source of spec.keptBy) {
      const key = keptByKey(schema, entity, row, source)
      if (key === null) continue
      for (const keep of keepsAt(source, key)) until = Math.max(until, keepDeadline(keep, finish))
    }
    return until
  }

  function mark(entity: EntityName, id: string): void {
    dirty.set(`${entity}:${id}`, [entity, id])
  }

  /** Re-file `id` of an unlessShown/own entity in `open` / `alive` from its current inputs. */
  function refile(entity: EntityName, id: string): void {
    const openSet = open.get(entity)
    const aliveMap = alive.get(entity)
    if (openSet === undefined || aliveMap === undefined) return
    openSet.delete(id)
    aliveMap.delete(id)
    const row = rules.get(entity)?.get(id)
    if (row === undefined) return
    const spec = schema[entity].cold
    if (spec.kind === 'own') {
      if (!spec.predicate(row)) openSet.add(id)
      return
    }
    if (spec.kind !== 'unlessShown') return
    if (!spec.predicate(row)) {
      openSet.add(id)
      return
    }
    const until = latest(entity, row)
    if (until > Number.NEGATIVE_INFINITY && until >= high) aliveMap.set(id, until)
  }

  function refileUnbound(entity: EntityName, id: string, row: Row | undefined): void {
    const map = unboundAlive.get(entity)
    if (map === undefined) return
    map.delete(id)
    const spec = schema[entity].cold
    if (row === undefined || spec.kind !== 'via' || viaTargetOf(schema, entity, row) !== null) return
    const until = spec.unbound === undefined || !spec.unbound.predicate(row)
      ? Number.POSITIVE_INFINITY
      : spec.unbound.shownUntil(row)
    if (until > Number.NEGATIVE_INFINITY && until >= high) map.set(id, until)
  }

  /** The owners whose lane key is `root` (their deadlines read its keeps). */
  function ownersAt(lane: LaneSource, root: string): void {
    for (const owner of relations.members(lane.lane, root, lane.owners)) mark(lane.owner, owner)
  }

  // ------------------------------------------------------------- members

  function setMember(entity: EntityName, id: string, row: Row | undefined): void {
    const key = `${entity}:${id}`
    const before = memberOf.get(key)
    const keeper = row === undefined ? null : keeperOf(schema, entity, row)
    if (before !== undefined) {
      const keeps = byOwner.get(before.source)?.get(before.owner)
      keeps?.delete(id)
      if (keeps?.size === 0) byOwner.get(before.source)?.delete(before.owner)
      memberOf.delete(key)
    }
    if (keeper !== null) {
      let owners = byOwner.get(keeper.source)
      if (owners === undefined) {
        owners = new Map()
        byOwner.set(keeper.source, owners)
      }
      let keeps = owners.get(keeper.id)
      if (keeps === undefined) {
        keeps = new Map()
        owners.set(keeper.id, keeps)
      }
      keeps.set(id, keeper.keep)
      memberOf.set(key, { source: keeper.source, owner: keeper.id })
    }
    if (before !== undefined) mark(ownerEntity(before.source), before.owner)
    if (keeper !== null) mark(keeper.to, keeper.id)
  }

  const ownerOfSource = new Map<KeptBySpec, EntityName>()
  for (const entity of entities) {
    const spec = schema[entity].cold
    if (spec.kind === 'unlessShown') for (const source of spec.keptBy) ownerOfSource.set(source, entity)
  }
  function ownerEntity(source: KeptBySpec): EntityName {
    return ownerOfSource.get(source)!
  }

  // ------------------------------------------------------------- via

  function setVia(entity: EntityName, id: string, row: Row | undefined, previous: Row | undefined): void {
    const index = byTarget.get(entity)
    if (index === undefined) return
    const before = previous === undefined ? null : viaTargetOf(schema, entity, previous)
    const after = row === undefined ? null : viaTargetOf(schema, entity, row)
    if (before !== null && before.id !== after?.id) {
      const ids = index.get(before.id)
      ids?.delete(id)
      if (ids?.size === 0) index.delete(before.id)
    }
    if (after !== null) {
      let ids = index.get(after.id)
      if (ids === undefined) {
        ids = new Set()
        index.set(after.id, ids)
      }
      ids.add(id)
    }
    refileUnbound(entity, id, row)
  }

  // ------------------------------------------------------------- apply

  function ingest(record: RowRecord): void {
    const entity = record.kind as EntityName
    const row = record.value as Row | undefined
    const roots = plain.get(entity)
    const held = rules.get(entity)
    const previous = held?.get(record.id)
    const existed = previous !== undefined || roots?.has(record.id) === true
    if (roots !== undefined) {
      if (row === undefined) roots.delete(record.id)
      else roots.add(record.id)
    }
    if (held !== undefined) {
      const next = row === undefined ? undefined : pick(row, fieldsOf.get(entity)!)
      if (next === undefined) held.delete(record.id)
      else held.set(record.id, next)
      const values = extras.get(entity)
      if (values !== undefined) {
        if (row === undefined) values.delete(record.id)
        else values.set(record.id, extraOf.get(entity)!.map((field) => row[field]))
      }
      const count = undeleted.get(entity)
      if (count !== undefined) {
        const was = previous !== undefined && previous['deletedAt'] == null
        const is = next !== undefined && next['deletedAt'] == null
        if (was !== is) undeleted.set(entity, count + (is ? 1 : -1))
      }
    }
    relations.changed(entity, record.id, existed, row)
    setMember(entity, record.id, row)
    setVia(entity, record.id, row, previous)
    mark(entity, record.id)
    // A lane member's keep may have moved where it sits: its owners re-file.
    for (const lane of lanes) {
      if (lane.member !== entity) continue
      const at = relations.forward(lane.member, record.id, lane.prefixName)
      if (at !== null) ownersAt(lane, at)
    }
  }

  function clear(): void {
    collapseVersion++
    relations.clear()
    for (const map of rules.values()) map.clear()
    for (const map of extras.values()) map.clear()
    for (const set of plain.values()) set.clear()
    for (const entity of undeleted.keys()) undeleted.set(entity, 0)
    byOwner.clear()
    memberOf.clear()
    for (const map of byTarget.values()) map.clear()
    for (const set of open.values()) set.clear()
    for (const map of alive.values()) map.clear()
    for (const map of unboundAlive.values()) map.clear()
    dirty.clear()
    high = Number.NEGATIVE_INFINITY
  }

  // ------------------------------------------------------------- queries

  /** Raise the expiry clock; a rewind below it re-files every held row once. */
  function advance(now: number): void {
    if (now >= high) {
      high = now
      return
    }
    high = now
    for (const entity of entities) {
      for (const [id, row] of rules.get(entity)!) {
        refile(entity, id)
        refileUnbound(entity, id, row)
      }
    }
  }

  function candidates(entity: EntityName, now: number, ctx: ColdContext): string[] {
    const spec = schema[entity].cold
    const held = rules.get(entity)
    if (held === undefined) return []
    const out: string[] = []
    const keep = (id: string): void => {
      const row = held.get(id)
      if (row !== undefined && !ctx.coldTarget(entity, id)) out.push(id)
    }
    if (spec.kind === 'own' || spec.kind === 'unlessShown') {
      for (const id of open.get(entity)!) out.push(id)
      const aliveMap = alive.get(entity)!
      for (const [id, until] of aliveMap) {
        if (until < now) aliveMap.delete(id)
        else keep(id)
      }
      return out
    }
    if (spec.kind !== 'via') return []
    const relation = schema[entity].relations[spec.relation]
    if (relation?.kind !== 'belongsTo') return []
    const index = byTarget.get(entity)!
    const targets = rules.get(relation.to)
    // Bound rows whose target is not cold by rule: the dependents of the
    // target's own candidates, never a cold target's history. A target the
    // feed does not carry is never cold either.
    for (const target of candidates(relation.to, now, ctx)) {
      for (const id of index.get(target) ?? NO_IDS) out.push(id)
    }
    for (const [target, ids] of index) {
      if (targets?.has(target) === true) continue
      for (const id of ids) out.push(id)
    }
    const unbound = unboundAlive.get(entity)!
    for (const [id, until] of unbound) {
      if (until < now) unbound.delete(id)
      else keep(id)
    }
    return out
  }

  return {
    readerActivity: (question) => activity.answer(question),
    readerActivityRevision: (question) => activity.revision(question),
    get readerActivityVisits() {
      return activity.visits
    },
    get readerVersion() {
      return readers.version + collapseVersion
    },
    readerRevision: (question) => readers.revision(question),
    get issueRepoRevision() {
      return readers.repoRevision
    },
    get sessionRevision() {
      return collapseVersion
    },
    readerIds: (question) => readers.ids(question),
    readerContains: (question, id) => readers.contains(question, id),
    issueRepoIds: (path) => readers.repoIds(path),
    sessionCollapsed: (id) => relations.collapsed('session', id),
    sessionOrderKey: (id) => relations.orderKey('session', id),
    relations,
    changes: (event) => (event === deltaOf ? delta : noDelta),
    dependents(entity, to, id) {
      const spec = schema[entity].cold
      if (spec.kind !== 'via' || schema[entity].relations[spec.relation]?.to !== to) return NO_IDS
      return byTarget.get(entity)?.get(id) ?? NO_IDS
    },
    flatUntil(entity, id, now) {
      const spec = schema[entity].cold
      const row = rules.get(entity)?.get(id)
      if (row === undefined || spec.kind !== 'unlessShown') return undefined
      const bound = { finish: coldFinishOf(schema, entity, row), shownUntil: spec.shownUntil(row) }
      return coldFlatUntil(schema, entity, id, row, bound, context(now))
    },
    undeleted: (entity) => undeleted.get(entity) ?? 0,
    holds(declared) {
      return entities.every((entity) =>
        (declared[entity] ?? []).every((field) => heldOf.get(entity)!.has(field)),
      )
    },
    heldFields(entity, id, fields) {
      const held = heldOf.get(entity)
      const row = rules.get(entity)?.get(id)
      if (held === undefined || row === undefined || !fields.every((field) => held.has(field))) return undefined
      const values = extras.get(entity)?.get(id)
      const at = extraAt.get(entity)!
      const out: Record<string, unknown> = {}
      for (const field of fields) {
        const index = at.get(field)
        const value = index === undefined ? row[field] : values?.[index]
        if (value !== undefined) out[field] = value
      }
      return out
    },
    position: (_entity, id) => positions.get(id),
    get positionVersion() {
      return positionVersion
    },
    get version() {
      return version
    },
    known(entity, id) {
      return rules.get(entity)?.has(id) ?? plain.get(entity)?.has(id) ?? false
    },
    count(entity) {
      return rules.get(entity)?.size ?? plain.get(entity)?.size ?? 0
    },
    coldByRule(entity, id, now) {
      const row = rules.get(entity)?.get(id)
      return row !== undefined && coldByRule(schema, entity, row, context(now))
    },
    coldRow(entity, row, now) {
      return coldByRule(schema, entity, row, context(now))
    },
    residentCandidates(entity, now) {
      advance(now)
      return candidates(entity, now, context(now))
    },
    apply(event) {
      version += 1
      if (event.type === 'replace') {
        clear()
        activity.clear()
        positions.clear()
        positionSeq = 0
        positionVersion += 1
      }
      for (const record of event.rows) {
        if (record.kind !== 'session') continue
        if (record.value === undefined) {
          if (positions.delete(record.id)) positionVersion += 1
        } else if (!positions.has(record.id)) {
          positions.set(record.id, ++positionSeq)
          positionVersion += 1
        }
      }
      relations.begin()
      for (const record of event.rows) ingest(record)
      delta = relations.flush()
      deltaOf = event
      // A lane subset that gained or lost a member moves its owners' deadlines.
      for (const [key, target] of delta.subsets) {
        for (const lane of lanes) {
          if (`${lane.lane}.${lane.relation}.${lane.subsetName}` === key) ownersAt(lane, target)
        }
      }
      for (const [entity, id] of dirty.values()) refile(entity, id)
      dirty.clear()
      if (delta.flips.length > 0 || delta.orders.length > 0) collapseVersion++
      readers.apply(event)
      for (const record of event.rows) {
        if (record.kind === 'session') activity.set(record.id, record.value as Row | undefined)
      }
      for (const [entity, id] of delta.flips) if (entity === 'session') activity.visibilityChanged(id)
    },
  }
}
