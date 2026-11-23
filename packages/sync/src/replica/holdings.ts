/**
 * WHAT THE DEVICE HOLDS, AND WHAT A CHANGE MEANS FOR IT (POD-7086, design
 * POD-7059 "The feed", "Comes with").
 *
 * The device holds INSTANCES of the declared collections (`@podium/model`
 * `records/`), each with a marker once complete. Every rule is data the
 * client evaluates in JavaScript over the record's own fields, so nothing
 * here needs the server to stamp a record with its collection.
 *
 * Two questions are answered here, and only here:
 *  - Does a record belong to an instance the device holds? One lookup per
 *    collection definition, not per instance: a keyed instance ("the
 *    sessions of issue X") is found by the value of its key field.
 *  - What does a held record come with that the device does not hold yet?
 *    Its declared links, as ordinary keyed instances.
 *
 * What memory keeps is the warm set's (`memory.ts`, POD-7161), and what the
 * device keeps is pruning's (POD-7162).
 *
 * Holding is not visibility. The server decides what this viewer may see;
 * these rules only say which of the records it sent the device keeps.
 */

import {
  andWhere,
  COLLECTIONS,
  type Collection,
  type ComesWith,
  instanceParams,
  matchesWhere,
  paramsRead,
  type RecordDeclaration,
  type RuleArgs,
  recordOf,
  type Where,
} from '@podium/model'
import { instanceKey, listedMarkers } from './cache-state'
import { type HeldSpec, isListed, keyedShapeOf, keyedShapesOfKind } from './instance-shapes'
import type {
  CachePolicy,
  EntityRecord,
  InstanceRange,
  InstanceRecord,
  InstanceSpec,
} from './types'

export type { HeldSpec } from './instance-shapes'

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

/** Compare two sort values in one direction; nulls sort last. */
function compareSort(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return (a as string | number) < (b as string | number) ? -1 : 1
}

/** Whether the fetched page has reached the range the device already held. */
export function rangeReached(
  collection: Collection,
  have: InstanceRange,
  want: InstanceRange,
): boolean {
  if (have.end || collection.page === undefined) return true
  if (want.end) return false
  if (want.through === undefined) return true
  if (have.through === undefined) return false
  for (let at = 0; at < collection.page.sort.length; at += 1) {
    const order = compareSort(have.through[at], want.through[at])
    if (order === 0) continue
    return collection.page.sort[at]?.direction === 'asc' ? order > 0 : order < 0
  }
  return true
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
    // side-state: snapshot: a held index is rebuilt when its inputs change
    this.markers = isSpecMap(instances)
      ? instances
      : new Map([...instances].map((spec) => [instanceKey(spec), spec]))
    // side-state: snapshot: a held index is rebuilt when its inputs change
    this.fetching = new Map([...fetching].map((spec) => [instanceKey(spec), spec]))
    const listedFetches = [...this.fetching.values()].filter(isListed)
    this.listed = [...listedMarkers(this.markers).values(), ...listedFetches]
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
    for (const spec of this.listed) {
      // A keyed instance listed for its odd shape is still found by its key
      // argument first, as the record's field gives it: one whose argument is
      // another record's (or missing) is not asked, so its rule never runs
      // without the argument it needs.
      const shape = keyedShapeOf(spec.collection)
      if (
        shape !== undefined &&
        ((spec.args as Readonly<Record<string, unknown>> | undefined)?.[shape.param] ?? null) !==
          (record[shape.field] ?? null)
      )
        continue
      consider(spec)
    }
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
): value is ReadonlyMap<string, HeldSpec> =>
  // By shape, not class: a second copy of this module in a bundle has its own InstanceMap.
  typeof (value as Partial<ReadonlyMap<string, HeldSpec>>).get === 'function' &&
  typeof (value as Partial<ReadonlyMap<string, HeldSpec>>).has === 'function'

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
/** Per kind, the collections that declare comes-with (`collectionComesWithSettled`). */
// side-state: declaration: a memo over the declared collections
const collectionComesWith = new Map<
  string,
  readonly {
    readonly id: string
    readonly where: Where | undefined
    readonly bare: boolean
    readonly holderOnly: boolean
  }[]
>()

/**
 * POD-7181 — whether no held instance a record belongs to can add a
 * comes-with that the device lacks, without finding the instances
 * (`HeldIndex.matching`): each collection of its kind that declares
 * comes-with either has it complete for this record on the disk (`cw`, for
 * comes-with the record holds itself), or cannot hold the record by its
 * rule, which reads no argument. A record kind with no such collection
 * always qualifies. When this is false, the caller finds the instances.
 */
export function collectionComesWithSettled(
  kind: string,
  value: unknown,
  cw: readonly string[] | undefined,
  now: number,
): boolean {
  let collections = collectionComesWith.get(kind)
  if (collections === undefined) {
    collections = [...COLLECTIONS.values()]
      .filter((collection) => collection.of === kind && (collection.comesWith?.length ?? 0) > 0)
      .map((collection) => ({
        id: collection.id,
        where: collection.where,
        bare: collection.where !== undefined && paramsRead(collection.where).length === 0,
        holderOnly: (collection.comesWith ?? []).every((entry) => entry.key === undefined),
      }))
    collectionComesWith.set(kind, collections)
  }
  for (const collection of collections) {
    if (collection.holderOnly && cw?.includes(collection.id) === true) continue
    if (
      collection.bare &&
      collection.where !== undefined &&
      !matchesWhere(collection.where, (value ?? {}) as Readonly<Record<string, unknown>>, {
        now,
        args: {},
      })
    )
      continue
    return false
  }
  return true
}

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
