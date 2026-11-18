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
  type RecordDeclaration,
  type RuleArgs,
  recordOf,
  type Where,
} from '@podium/model'
import { instanceKey } from './cache-state'
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

/**
 * The instances a device holds, indexed so one change costs one lookup per
 * collection definition: keyed instances by their key value, the others
 * (no arguments, a tree, a stage page) evaluated in turn, which are few.
 */
export class HeldIndex {
  /** kind → collection id|via|part → key field and instances by key value, or a list. */
  private readonly byKind = new Map<
    string,
    Map<
      string,
      {
        readonly field?: string
        readonly byValue: Map<unknown, ResolvedInstance[]>
        readonly all: ResolvedInstance[]
      }
    >
  >()
  readonly instances: ReadonlyMap<string, ResolvedInstance>

  constructor(
    instances: Iterable<InstanceSpec & { readonly range?: InstanceRecord['range'] }>,
    readonly args: RuleArgs,
  ) {
    const resolved = new Map<string, ResolvedInstance>()
    for (const spec of instances) {
      const instance = resolveInstance(spec, args)
      if (instance === undefined) continue
      resolved.set(instance.key, instance)
      let groups = this.byKind.get(instance.of)
      if (groups === undefined) {
        groups = new Map()
        this.byKind.set(instance.of, groups)
      }
      const groupKey = `${instance.collection.id}|${spec.via ?? ''}|${spec.part}`
      let group = groups.get(groupKey)
      if (group === undefined) {
        const field = cachedKeyField(instance.collection)
        group = { ...(field === undefined ? {} : { field }), byValue: new Map(), all: [] }
        groups.set(groupKey, group)
      }
      if (group.field !== undefined) {
        const value = spec.args?.[instanceParams(instance.collection)[0]!]
        const list = group.byValue.get(value ?? null) ?? []
        list.push(instance)
        group.byValue.set(value ?? null, list)
      } else group.all.push(instance)
    }
    this.instances = resolved
  }

  /** Every held instance the record belongs to, at the given part. */
  matching(
    kind: string,
    value: unknown,
    rows: HeldRows,
    now: number,
    part: 'stub' | 'main' = 'main',
  ): ResolvedInstance[] {
    const groups = this.byKind.get(kind)
    if (groups === undefined) return []
    const record = (value ?? {}) as Readonly<Record<string, unknown>>
    const declaration = recordOf(kind)
    const ctx = matchContext(declaration, rows, now)
    const out: ResolvedInstance[] = []
    for (const group of groups.values()) {
      const candidates =
        group.field === undefined
          ? group.all
          : (group.byValue.get(record[group.field] ?? null) ?? [])
      for (const instance of candidates) {
        if (instance.spec.part !== part) continue
        if (!belongs(instance, record, ctx)) continue
        out.push(instance)
      }
    }
    return out
  }
}

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

  /** Incremental closure: kept instances and kept rows, extended monotonically. */
  const keptInstances = new Set<string>()
  const keptRows = new Set<string>()
  const memberships = new Map<string, ResolvedInstance[]>()
  const ctxFor = new Map<string, (args: RuleArgs) => Parameters<typeof matchesWhere>[2]>()
  const ctxOf = (kind: string) => {
    let ctx = ctxFor.get(kind)
    if (ctx === undefined) {
      ctx = matchContext(recordOf(kind), input.store, input.now)
      ctxFor.set(kind, ctx)
    }
    return ctx
  }
  const keepRows = (
    rows: readonly EntityRecord[],
    via: ResolvedInstance | undefined,
    work: EntityRecord[],
  ) => {
    for (const row of rows) {
      const key = rowKeyOf(row)
      if (via !== undefined) {
        const list = memberships.get(key) ?? []
        list.push(via)
        memberships.set(key, list)
      }
      if (keptRows.has(key)) {
        // A row already kept may now belong to one more collection, whose
        // comes-with it must bring along too.
        if (via !== undefined && (via.collection.comesWith?.length ?? 0) > 0) work.push(row)
        continue
      }
      keptRows.add(key)
      work.push(row)
    }
  }
  const keepInstance = (key: string, work: EntityRecord[]): void => {
    if (keptInstances.has(key)) return
    const instance = resolved.get(key)
    keptInstances.add(key)
    if (instance === undefined || instance.spec.part === 'stub') return
    const ctx = ctxOf(instance.of)
    const members = (byKind.get(instance.of) ?? []).filter((row) =>
      belongs(instance, (row.value ?? {}) as Record<string, unknown>, ctx),
    )
    keepRows(members, instance, work)
  }
  const settle = (work: EntityRecord[]): void => {
    for (let guard = 0; work.length > 0; guard += 1) {
      if (guard > 10_000_000) throw new Error('trim closure did not settle')
      const row = work.pop()!
      const memberOf = memberships.get(rowKeyOf(row)) ?? []
      for (const spec of comesWithOf(row.entity, row.value, memberOf, input.now)) {
        const key = instanceKey(spec)
        if (input.instances.has(key)) keepInstance(key, work)
      }
    }
  }

  const work: EntityRecord[] = []
  for (const key of input.held) if (input.instances.has(key)) keepInstance(key, work)
  settle(work)
  const base = new Set(keptRows)
  const cache = [...input.instances.values()]
    .filter((record) => record.via === undefined && !keptInstances.has(record.key))
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0) || (a.key < b.key ? -1 : 1))
  let cacheRecords = 0
  for (const record of cache) {
    // Tentatively keep it; give it back if it takes the cache above the cap.
    const instancesBefore = new Set(keptInstances)
    const rowsBefore = new Set(keptRows)
    const membershipsBefore = new Map([...memberships].map(([key, list]) => [key, [...list]]))
    const next: EntityRecord[] = []
    keepInstance(record.key, next)
    settle(next)
    let count = 0
    for (const key of keptRows) if (!base.has(key)) count += 1
    if (count > input.cap) {
      keptInstances.clear()
      for (const key of instancesBefore) keptInstances.add(key)
      keptRows.clear()
      for (const key of rowsBefore) keptRows.add(key)
      memberships.clear()
      for (const [key, list] of membershipsBefore) memberships.set(key, list)
      // Released longest ago go first: this one and every older one are dropped.
      break
    }
    cacheRecords = count
  }

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
