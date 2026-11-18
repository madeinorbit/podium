/**
 * WHAT THE DEVICE HOLDS, AND WHAT A CHANGE MEANS FOR IT (POD-7086, design
 * POD-7059 "The feed", "Memory, cache and leaving", "Comes with").
 *
 * The device holds INSTANCES of the declared collections (`@podium/model`
 * `records/`), each with a marker once complete. Every rule is data the
 * client evaluates in JavaScript over the record's own fields, so nothing
 * here needs the server to stamp a record with its collection.
 *
 * Three questions are answered here, and only here:
 *  - Does a record belong to an instance the device holds? One lookup per
 *    collection definition, not per instance: a keyed instance ("the
 *    sessions of issue X") is found by the value of its key field.
 *  - What does a held record come with that the device does not hold yet?
 *    Its declared links, as ordinary keyed instances.
 *  - What does the trim keep? The instances the policy and the open views
 *    hold, then cache instances newest-released first up to the cap; a
 *    record stays while an instance kept contains it or a kept record comes
 *    with it. An issue falls back to its stub; nothing else is kept partly.
 *
 * Holding is not visibility. The server decides what this viewer may see;
 * these rules only say which of the records it sent the device keeps.
 */

import {
  andWhere,
  type Clause,
  COLLECTIONS,
  type Collection,
  type ComesWith,
  clausesOf,
  instanceParams,
  isParam,
  matchesWhere,
  RECORD_KINDS,
  type RecordDeclaration,
  type RuleArgs,
  recordOf,
  type Where,
} from '@podium/model'
import { InstanceMap, instanceKey } from './cache-state'
import type { CachePolicy, EntityRecord, InstanceRecord, InstanceSpec } from './types'

/** The rows a decision reads, synchronously, from the store in memory. */
export interface HeldRows {
  /** The one row of a record, stub or whole. */
  readRow(entity: string, entityId: string): EntityRecord | undefined
}

// ---------------------------------------------------------------------------
// Instances, resolved against the declarations
// ---------------------------------------------------------------------------

/** An instance with its rule: the collection's, narrowed by its holder's comes-with. */
export interface ResolvedInstance {
  readonly key: string
  readonly spec: InstanceSpec
  readonly collection: Collection
  /** The record type the instance selects. */
  readonly of: string
  readonly where: Where | undefined
  readonly args: RuleArgs
  /** A paged instance's marker range; absent means complete in full. */
  readonly range: InstanceRecord['range'] | undefined
}

/** The policy's numbers, as rule arguments. */
export function policyArgs(policy: CachePolicy | null): RuleArgs {
  return policy === null ? {} : { recentDays: policy.recentDays }
}

/** The comes-with entry a holder (`via`: a collection id or a record kind) declares for a collection. */
export function comesWithEntry(via: string, collection: string): ComesWith | undefined {
  const holder = COLLECTIONS.get(via)?.comesWith ?? recordOf(via)?.comesWith
  return holder?.find((entry) => entry.collection === collection)
}

/** Resolve one instance; `undefined` for a collection this build does not declare. */
export function resolveInstance(
  spec: InstanceSpec & { readonly range?: InstanceRecord['range'] },
  args: RuleArgs,
): ResolvedInstance | undefined {
  const collection = COLLECTIONS.get(spec.collection)
  if (collection === undefined) return undefined
  let where = collection.where
  if (spec.via !== undefined) {
    const entry = comesWithEntry(spec.via, spec.collection)
    if (entry?.where !== undefined) where = andWhere(where, entry.where)
  }
  return {
    key: instanceKey(spec),
    spec,
    collection,
    of: collection.of,
    where,
    args: { ...args, ...(spec.args ?? {}) } as RuleArgs,
    range: spec.range,
  }
}

/** The stub fields of a record type; empty for a type without a stub. */
export const stubFieldsOf = (kind: string): readonly string[] => recordOf(kind)?.stub ?? []

/** The stub part picked from a record's value. */
export function stubOfValue(kind: string, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const record = (value ?? {}) as Record<string, unknown>
  for (const field of stubFieldsOf(kind))
    if (record[field] !== undefined) out[field] = record[field]
  return out
}

// ---------------------------------------------------------------------------
// Matching a record against instances
// ---------------------------------------------------------------------------

/** `{ field: { eq: param } }` on the instance's one argument: the key a keyed instance is found by. */
function keyFieldOf(collection: Collection): string | undefined {
  const params = instanceParams(collection)
  if (params.length !== 1 || collection.where === undefined) return undefined
  const clauses = clausesOf(collection.where)
  if (clauses.length !== 1) return undefined
  for (const [field, test] of Object.entries(clauses[0] as Clause)) {
    if (
      test !== null &&
      typeof test === 'object' &&
      'eq' in test &&
      isParam(test.eq) &&
      test.eq.param === params[0]
    )
      return field
  }
  return undefined
}

const keyFieldCache = new Map<string, string | null>()
function cachedKeyField(collection: Collection): string | undefined {
  let field = keyFieldCache.get(collection.id)
  if (field === undefined) {
    field = keyFieldOf(collection) ?? null
    keyFieldCache.set(collection.id, field)
  }
  return field ?? undefined
}

/** Compare two sort values in one direction; nulls sort last. */
function compareSort(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return (a as string | number) < (b as string | number) ? -1 : 1
}

/** Whether a record falls inside a paged instance's range (at or above `through`). */
function withinRange(
  collection: Collection,
  range: InstanceRecord['range'] | undefined,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (range === undefined || range.end || collection.page === undefined) return true
  const through = range.through
  if (through === undefined) return false
  for (let at = 0; at < collection.page.sort.length; at += 1) {
    const sort = collection.page.sort[at]!
    const order = compareSort(value[sort.field] ?? null, through[at] ?? null)
    if (order === 0) continue
    return sort.direction === 'asc' ? order < 0 : order > 0
  }
  return true
}

/** An instance as the index reads it: a marker (with its range) or a fetch in flight. */
export type HeldSpec = InstanceSpec & { readonly range?: InstanceRecord['range'] }

/** A keyed collection: the field its one argument equals, and every `via` an instance can name. */
interface KeyedShape {
  readonly collection: Collection
  readonly field: string
  readonly param: string
  readonly vias: readonly (string | undefined)[]
}

/** The holders (record kinds and collections) whose comes-with name each collection. */
let viasByCollection: Map<string, Set<string>> | undefined
function viasOf(collection: string): ReadonlySet<string> {
  if (viasByCollection === undefined) {
    const out = new Map<string, Set<string>>()
    const add = (via: string, entries: readonly ComesWith[] | undefined): void => {
      for (const entry of entries ?? []) {
        let set = out.get(entry.collection)
        if (set === undefined) {
          set = new Set()
          out.set(entry.collection, set)
        }
        set.add(via)
      }
    }
    for (const kind of RECORD_KINDS) add(kind, recordOf(kind)?.comesWith)
    for (const held of COLLECTIONS.values()) add(held.id, held.comesWith)
    viasByCollection = out
  }
  return viasByCollection.get(collection) ?? EMPTY_SET
}
const EMPTY_SET: ReadonlySet<string> = new Set()

/** A collection's keyed shape; `undefined` for one found by listing its instances. */
const keyedShapes = new Map<string, KeyedShape | null>()
function keyedShapeOf(collection: Collection): KeyedShape | undefined {
  let shape = keyedShapes.get(collection.id)
  if (shape === undefined) {
    const field = cachedKeyField(collection)
    shape =
      field === undefined
        ? null
        : {
            collection,
            field,
            param: instanceParams(collection)[0] as string,
            vias: [undefined, ...viasOf(collection.id)],
          }
    keyedShapes.set(collection.id, shape)
  }
  return shape ?? undefined
}

/** The keyed shapes of a record kind's collections, in declaration order. */
const keyedByKind = new Map<string, readonly KeyedShape[]>()
function keyedShapesOfKind(kind: string): readonly KeyedShape[] {
  let shapes = keyedByKind.get(kind)
  if (shapes === undefined) {
    const out: KeyedShape[] = []
    for (const collection of COLLECTIONS.values()) {
      if (collection.of !== kind) continue
      const shape = keyedShapeOf(collection)
      if (shape !== undefined) out.push(shape)
    }
    shapes = out
    keyedByKind.set(kind, shapes)
  }
  return shapes
}

/**
 * Whether a held instance can be found only by listing: a collection without
 * a key field, or a keyed one whose marker does not have the key a record's
 * field gives it (its one argument missing, others besides it, a `via` this
 * build does not declare). Such instances are few: the policy's, the trees
 * and pages a view opened.
 */
function listed(spec: HeldSpec): boolean {
  const collection = COLLECTIONS.get(spec.collection)
  if (collection === undefined) return false
  const shape = keyedShapeOf(collection)
  if (shape === undefined) return true
  if (spec.via !== undefined && spec.via !== '' && !viasOf(collection.id).has(spec.via)) return true
  const args = spec.args as Readonly<Record<string, unknown>> | undefined
  if (args === undefined || args[shape.param] === undefined || args[shape.param] === null)
    return true
  for (const name in args) if (name !== shape.param) return true
  return false
}

/** The listed instances of one base of markers, found once per base. */
const listedByBase = new WeakMap<ReadonlyMap<string, HeldSpec>, ReadonlyMap<string, HeldSpec>>()

function listedIn(markers: ReadonlyMap<string, HeldSpec>): Map<string, HeldSpec> {
  const layers = markers instanceof InstanceMap ? markers.layers() : undefined
  const base = layers?.base ?? markers
  let inBase = listedByBase.get(base)
  if (inBase === undefined) {
    const found = new Map<string, HeldSpec>()
    for (const [key, spec] of base) if (listed(spec)) found.set(key, spec)
    inBase = found
    listedByBase.set(base, inBase)
  }
  const out = new Map(inBase)
  for (const [key, spec] of layers?.changes ?? []) {
    if (spec !== undefined && listed(spec)) out.set(key, spec)
    else out.delete(key)
  }
  return out
}

/**
 * The instances a device holds, as one change asks about them (POD-7119).
 *
 * A keyed instance ("the sessions of issue X") is found by its key: the
 * record's field gives the argument, so each keyed collection of the record's
 * type costs one lookup per declared `via`, in the markers as they are. The
 * others (no arguments, a tree, a page of a stage) are listed and evaluated in
 * turn. Nothing is built per marker: the index used to resolve every marker
 * the device holds, which grows with history, on the first change after any
 * marker changed.
 */
export class HeldIndex {
  private readonly markers: ReadonlyMap<string, HeldSpec>
  private readonly fetching: ReadonlyMap<string, HeldSpec>
  /** The listed instances, markers then fetches. */
  private readonly listed: readonly HeldSpec[]
  private readonly resolved = new WeakMap<HeldSpec, ResolvedInstance | null>()

  /**
   * `instances` are the markers, as the store's map (read by key, never
   * copied) or any list of specs; `fetching` the instances in flight, copied.
   */
  constructor(
    instances: ReadonlyMap<string, HeldSpec> | Iterable<HeldSpec>,
    readonly args: RuleArgs,
    fetching: Iterable<HeldSpec> = [],
  ) {
    this.markers = isSpecMap(instances)
      ? instances
      : new Map([...instances].map((spec) => [instanceKey(spec), spec]))
    this.fetching = new Map([...fetching].map((spec) => [instanceKey(spec), spec]))
    const listedFetches = [...this.fetching.values()].filter(listed)
    this.listed = [...listedIn(this.markers).values(), ...listedFetches]
  }

  /** Every held instance the record belongs to, at the given part. */
  matching(
    kind: string,
    value: unknown,
    rows: HeldRows,
    now: number,
    part: 'stub' | 'main' = 'main',
  ): ResolvedInstance[] {
    const record = (value ?? {}) as Readonly<Record<string, unknown>>
    const ctx = matchContext(recordOf(kind), rows, now)
    const out: ResolvedInstance[] = []
    const found = new Set<string>()
    const consider = (spec: HeldSpec | undefined): void => {
      if (spec === undefined || spec.part !== part) return
      const instance = this.resolve(spec)
      if (instance === undefined || instance.of !== kind || found.has(instance.key)) return
      if (!belongs(instance, record, ctx)) return
      found.add(instance.key)
      out.push(instance)
    }
    for (const shape of keyedShapesOfKind(kind)) {
      const key = record[shape.field]
      if (key === undefined || key === null) continue
      const args = { [shape.param]: key } as InstanceSpec['args']
      for (const via of shape.vias) {
        const at = instanceKey({ collection: shape.collection.id, args, part, via })
        consider(this.markers.get(at))
        consider(this.fetching.get(at))
      }
    }
    for (const spec of this.listed) consider(spec)
    return out
  }

  private resolve(spec: HeldSpec): ResolvedInstance | undefined {
    let instance = this.resolved.get(spec)
    if (instance === undefined) {
      instance = resolveInstance(spec, this.args) ?? null
      this.resolved.set(spec, instance)
    }
    return instance ?? undefined
  }
}

const isSpecMap = (
  value: ReadonlyMap<string, HeldSpec> | Iterable<HeldSpec>,
): value is ReadonlyMap<string, HeldSpec> => value instanceof Map || value instanceof InstanceMap

function matchContext(
  declaration: RecordDeclaration | undefined,
  rows: HeldRows,
  now: number,
): (args: RuleArgs) => Parameters<typeof matchesWhere>[2] {
  const parentLink = declaration?.parentLink
  const key = declaration?.key
  const kind = declaration?.kind
  const parentOf =
    parentLink === undefined || kind === undefined
      ? undefined
      : (id: string): string | null | undefined => {
          const row = rows.readRow(kind, id)
          if (row === undefined) return undefined
          const parent = (row.value as Record<string, unknown> | null)?.[parentLink]
          return typeof parent === 'string' ? parent : null
        }
  return (args) => ({
    now,
    args,
    ...(parentOf === undefined ? {} : { parentOf }),
    ...(key === undefined
      ? {}
      : { idOf: (record: Readonly<Record<string, unknown>>) => record[key] as string | undefined }),
  })
}

/**
 * Whether a record belongs to an instance. For a tree, membership needs no
 * walk beyond the parent chain on the device: a complete tree holds all its
 * members, so a new issue belongs to it exactly when its parent does.
 */
function belongs(
  instance: ResolvedInstance,
  record: Readonly<Record<string, unknown>>,
  ctx: (args: RuleArgs) => Parameters<typeof matchesWhere>[2],
): boolean {
  if (instance.where !== undefined && !matchesWhere(instance.where, record, ctx(instance.args)))
    return false
  return withinRange(instance.collection, instance.range, record)
}

// ---------------------------------------------------------------------------
// Comes with
// ---------------------------------------------------------------------------

/** Whether a record belongs to one resolved instance, exactly as {@link HeldIndex.matching} decides it. */
export function holds(
  instance: ResolvedInstance,
  kind: string,
  value: unknown,
  rows: HeldRows,
  now: number,
): boolean {
  const record = (value ?? {}) as Readonly<Record<string, unknown>>
  return belongs(instance, record, matchContext(recordOf(kind), rows, now))
}

/** The keyed instance one comes-with entry names for one holder record, if any. */
export function comesWithInstance(
  holderKind: string,
  value: unknown,
  entry: ComesWith,
  via: string,
  now: number,
): InstanceSpec | undefined {
  const declaration = recordOf(holderKind)
  const target = COLLECTIONS.get(entry.collection)
  if (declaration === undefined || target === undefined) return undefined
  const record = (value ?? {}) as Readonly<Record<string, unknown>>
  if (entry.if !== undefined && !matchesWhere(entry.if, record, { now })) return undefined
  const keyField = entry.key ?? declaration.key
  if (keyField === undefined) return undefined
  const key = record[keyField]
  if (typeof key !== 'string' || key === '') return undefined
  const param = instanceParams(target)[0]
  if (param === undefined) return undefined
  return { collection: entry.collection, args: { [param]: key }, part: 'main', via }
}

/**
 * What a record held at its main part comes with: its type's declared links
 * (via the type) and the comes-with of each held instance it belongs to (via
 * that collection).
 */
export function comesWithOf(
  kind: string,
  value: unknown,
  memberOf: readonly ResolvedInstance[],
  now: number,
): InstanceSpec[] {
  const out: InstanceSpec[] = []
  const declaration = recordOf(kind)
  if (declaration === undefined) return out
  for (const entry of declaration.comesWith) {
    const spec = comesWithInstance(kind, value, entry, kind, now)
    if (spec !== undefined) out.push(spec)
  }
  const seen = new Set<string>()
  for (const instance of memberOf) {
    if (seen.has(instance.collection.id)) continue
    seen.add(instance.collection.id)
    for (const entry of instance.collection.comesWith ?? []) {
      const spec = comesWithInstance(kind, value, entry, instance.collection.id, now)
      if (spec !== undefined) out.push(spec)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The policy's instances
// ---------------------------------------------------------------------------

/** The instances the policy holds, in its order (the `view` step names none). */
export function policyInstances(policy: CachePolicy | null): InstanceSpec[] {
  if (policy === null) return []
  const out: InstanceSpec[] = []
  for (const step of policy.steps) {
    for (const id of step.collections) {
      const collection = COLLECTIONS.get(id)
      out.push({ collection: id, part: collection?.part ?? 'main' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The trim
// ---------------------------------------------------------------------------

/** What a trim does: the markers it drops, the issues it takes back to their stub, the rows it removes. */
export interface TrimPlan {
  readonly dropInstances: readonly string[]
  readonly toStub: readonly EntityRecord[]
  readonly remove: readonly EntityRecord[]
  /** Records held only as cache after the trim. */
  readonly cacheRecords: number
}

const rowKeyOf = (row: Pick<EntityRecord, 'entity' | 'entityId'>): string =>
  `${row.entity}\u0000${row.entityId}`

/**
 * Plan a trim. `held` are the keys the policy and the open views hold (and
 * fetches in flight); every other instance is cache. Instances that arrived
 * because another record is held (`via`) are kept exactly while that record is.
 *
 * POD-7115: linear in what it keeps. A keyed instance finds its members
 * through an index by its key field, not by testing every record of its type,
 * and each cache instance is tried in a layer over what is kept so far: kept
 * if it fits under the cap, forgotten if not, never copying what is kept.
 * The trim runs after every fetch, so a first download used to pay for every
 * instance times every record, and again per cache instance while the cache
 * stayed under its cap.
 */
export function planTrim(input: {
  readonly rows: readonly EntityRecord[]
  readonly instances: ReadonlyMap<string, InstanceRecord>
  readonly held: ReadonlySet<string>
  readonly policy: CachePolicy | null
  readonly cap: number
  readonly now: number
  readonly store: HeldRows
}): TrimPlan {
  const args = policyArgs(input.policy)
  const main = input.rows.filter((row) => row.part !== 'stub')
  const byKind = new Map<string, EntityRecord[]>()
  for (const row of main) {
    const list = byKind.get(row.entity) ?? []
    list.push(row)
    byKind.set(row.entity, list)
  }
  const resolved = new Map<string, ResolvedInstance>()
  for (const [key, record] of input.instances) {
    const instance = resolveInstance(record, args)
    if (instance !== undefined) resolved.set(key, instance)
  }
  /** kind → key field → value → the records with that value: a keyed instance's candidates. */
  const byField = new Map<string, Map<string, Map<unknown, EntityRecord[]>>>()
  const candidatesOf = (instance: ResolvedInstance): readonly EntityRecord[] => {
    const rows = byKind.get(instance.of) ?? []
    const field = cachedKeyField(instance.collection)
    if (field === undefined) return rows
    let fields = byField.get(instance.of)
    if (fields === undefined) {
      fields = new Map()
      byField.set(instance.of, fields)
    }
    let index = fields.get(field)
    if (index === undefined) {
      index = new Map()
      for (const row of rows) {
        const value = ((row.value ?? {}) as Record<string, unknown>)[field] ?? null
        const list = index.get(value)
        if (list === undefined) index.set(value, [row])
        else list.push(row)
      }
      fields.set(field, index)
    }
    const param = instanceParams(instance.collection)[0]
    return index.get(param === undefined ? null : (instance.args[param] ?? null)) ?? []
  }

  /** What is kept: instances, rows, and the collections each kept row belongs to. */
  const kept = {
    instances: new Set<string>(),
    rows: new Set<string>(),
    memberships: new Map<string, ResolvedInstance[]>(),
  }
  /** One cache instance on trial: what it would add over `kept`. */
  type Layer = typeof kept
  const ctxFor = new Map<string, (args: RuleArgs) => Parameters<typeof matchesWhere>[2]>()
  const ctxOf = (kind: string) => {
    let ctx = ctxFor.get(kind)
    if (ctx === undefined) {
      ctx = matchContext(recordOf(kind), input.store, input.now)
      ctxFor.set(kind, ctx)
    }
    return ctx
  }
  const membershipsOf = (key: string, trial: Layer | undefined): readonly ResolvedInstance[] => {
    const base = kept.memberships.get(key) ?? []
    const more = trial?.memberships.get(key)
    return more === undefined ? base : [...base, ...more]
  }
  const keepRows = (
    rows: readonly EntityRecord[],
    via: ResolvedInstance | undefined,
    work: EntityRecord[],
    into: Layer,
    trial: Layer | undefined,
  ) => {
    for (const row of rows) {
      const key = rowKeyOf(row)
      if (via !== undefined) {
        const list = into.memberships.get(key)
        if (list === undefined) into.memberships.set(key, [via])
        else list.push(via)
      }
      if (kept.rows.has(key) || trial?.rows.has(key) === true) {
        // A row already kept may now belong to one more collection, whose
        // comes-with it must bring along too.
        if (via !== undefined && (via.collection.comesWith?.length ?? 0) > 0) work.push(row)
        continue
      }
      into.rows.add(key)
      work.push(row)
    }
  }
  const keepInstance = (
    key: string,
    work: EntityRecord[],
    into: Layer,
    trial: Layer | undefined,
  ): void => {
    if (kept.instances.has(key) || trial?.instances.has(key) === true) return
    const instance = resolved.get(key)
    into.instances.add(key)
    if (instance === undefined || instance.spec.part === 'stub') return
    const ctx = ctxOf(instance.of)
    const members = candidatesOf(instance).filter((row) =>
      belongs(instance, (row.value ?? {}) as Record<string, unknown>, ctx),
    )
    keepRows(members, instance, work, into, trial)
  }
  /** Close over comes-with; stops early once `over()` says the layer cannot fit. */
  const settle = (
    work: EntityRecord[],
    into: Layer,
    trial: Layer | undefined,
    over: () => boolean = () => false,
  ): void => {
    for (let guard = 0; work.length > 0; guard += 1) {
      if (guard > 10_000_000) throw new Error('trim closure did not settle')
      if (over()) return
      const row = work.pop()!
      const memberOf = membershipsOf(rowKeyOf(row), trial)
      for (const spec of comesWithOf(row.entity, row.value, memberOf, input.now)) {
        const key = instanceKey(spec)
        if (input.instances.has(key)) keepInstance(key, work, into, trial)
      }
    }
  }

  const work: EntityRecord[] = []
  for (const key of input.held)
    if (input.instances.has(key)) keepInstance(key, work, kept, undefined)
  settle(work, kept, undefined)
  const base = kept.rows.size
  const cache = [...input.instances.values()]
    .filter((record) => record.via === undefined && !kept.instances.has(record.key))
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0) || (a.key < b.key ? -1 : 1))
  let cacheRecords = 0
  for (const record of cache) {
    if (kept.instances.has(record.key)) continue
    // Tried in a layer: it is kept only if the cache stays under the cap.
    const trial: Layer = { instances: new Set(), rows: new Set(), memberships: new Map() }
    const next: EntityRecord[] = []
    const over = () => kept.rows.size - base + trial.rows.size > input.cap
    keepInstance(record.key, next, trial, trial)
    settle(next, trial, trial, over)
    // Released longest ago go first: this one and every older one are dropped.
    if (over()) break
    for (const key of trial.instances) kept.instances.add(key)
    for (const key of trial.rows) kept.rows.add(key)
    for (const [key, list] of trial.memberships) {
      const held = kept.memberships.get(key)
      if (held === undefined) kept.memberships.set(key, list)
      else held.push(...list)
    }
    cacheRecords = kept.rows.size - base
  }
  const keptInstances = kept.instances
  const keptRows = kept.rows

  const dropInstances = [...input.instances.keys()].filter((key) => !keptInstances.has(key))
  const toStub: EntityRecord[] = []
  const remove: EntityRecord[] = []
  for (const row of main) {
    if (keptRows.has(rowKeyOf(row))) continue
    if (stubFieldsOf(row.entity).length > 0) toStub.push(row)
    else remove.push(row)
  }
  return { dropInstances, toStub, remove, cacheRecords }
}
