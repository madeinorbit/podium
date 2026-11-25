/**
 * POD-7602 — MANY NARROW INSTANCES, ONE STATEMENT.
 *
 * A screen of rows asks one instance per row (`session.ofIssue` for each
 * issue). Sent as they are, each is its own statement and marker on the
 * server: one deck of 1,000 issues saturated the server's sync worker. The
 * instances of one keyed collection (one argument, tested for equality)
 * therefore go on the wire as one keyed instance, which the server answers
 * with one statement per chunk of keys and a marker per key, as if each had
 * been asked alone. The device's books (markers, holds, the trim) never see
 * the packing: it happens where a request is written, and a fetch is filled
 * by what goes on the wire ({@link FetchBudget}).
 */

import { COLLECTIONS, instanceParams } from './index'
import { clausesOf, isParam } from './rule'

/** Most instances one fetch names (the route's bound, `COLLECTION_FETCH_MAX_INSTANCES`). */
export const FETCH_MAX_INSTANCES = 200

/**
 * Most keys the keyed instances of one fetch name together. A keyed instance
 * counts once against {@link FETCH_MAX_INSTANCES} however many keys it names.
 */
export const FETCH_MAX_KEYS = 2000

/** What packing reads of an instance: the wire's, or a device's request for one. */
export interface PackableInstance {
  readonly collection: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly part?: 'stub' | 'main'
  readonly via?: string
  readonly after?: readonly unknown[]
  readonly keys?: readonly string[]
  /** POD-7609 — the instance whose rows the device holds; such an instance goes alone. */
  readonly rowsHeld?: { readonly collection: string; readonly seq: number }
}

const keyedArguments = new Map<string, string | undefined>()

/**
 * The argument a collection is keyed by, when its instances can share one
 * keyed instance on the wire: one clause that tests a plain saved field (no
 * path into an object) for equality with the collection's one argument, and
 * no page. The server reads each record's key from that field. `undefined`
 * for any other.
 */
export function keyedArgument(collectionId: string): string | undefined {
  if (keyedArguments.has(collectionId)) return keyedArguments.get(collectionId)
  const collection = COLLECTIONS.get(collectionId)
  let param: string | undefined
  if (collection?.where !== undefined && collection.page === undefined) {
    const params = instanceParams(collection)
    const only = params.length === 1 ? params[0] : undefined
    const clauses = clausesOf(collection.where)
    const keyed =
      clauses.length === 1 &&
      Object.entries(clauses[0]!).some(
        ([path, test]) =>
          !path.includes('.') &&
          typeof test === 'object' &&
          test !== null &&
          'eq' in test &&
          isParam((test as { eq: unknown }).eq) &&
          (test as { eq: { param: string } }).eq.param === only,
      )
    if (only !== undefined && keyed) param = only
  }
  keyedArguments.set(collectionId, param)
  return param
}

/** The group an instance packs into, or `undefined` when it goes on the wire alone. */
function packGroup(instance: PackableInstance): { group: string; key: string } | undefined {
  if (
    instance.after !== undefined ||
    instance.keys !== undefined ||
    instance.rowsHeld !== undefined
  )
    return undefined
  // An omitted part is the collection's own: only a main part packs.
  if ((instance.part ?? COLLECTIONS.get(instance.collection)?.part) !== 'main') return undefined
  const param = keyedArgument(instance.collection)
  if (param === undefined) return undefined
  const args = instance.args ?? {}
  const key = args[param]
  if (typeof key !== 'string' || key === '' || Object.keys(args).length !== 1) return undefined
  return { group: `${instance.via ?? ''}\u0000${instance.collection}`, key }
}

/**
 * The instances as they go on the wire: those of one keyed collection (with
 * the same holder) become one keyed instance, in the place of the first of
 * them; every other instance goes as it is.
 */
export function packInstances<T extends PackableInstance>(
  instances: readonly T[],
): PackableInstance[] {
  const out: PackableInstance[] = []
  const groups = new Map<string, { at: number; keys: string[]; seen: Set<string> }>()
  for (const instance of instances) {
    const packed = packGroup(instance)
    if (packed === undefined) {
      out.push(instance)
      continue
    }
    const group = groups.get(packed.group)
    if (group === undefined) {
      groups.set(packed.group, { at: out.length, keys: [packed.key], seen: new Set([packed.key]) })
      out.push({
        collection: instance.collection,
        part: 'main',
        ...(instance.via === undefined ? {} : { via: instance.via }),
      })
      continue
    }
    if (group.seen.has(packed.key)) continue
    group.seen.add(packed.key)
    group.keys.push(packed.key)
  }
  for (const group of groups.values()) out[group.at] = { ...out[group.at]!, keys: group.keys }
  return out
}

/**
 * Fills one fetch within the route's bounds, by what goes on the wire: a
 * keyed collection's instances count once, and their keys count against
 * {@link FETCH_MAX_KEYS}.
 */
export class FetchBudget {
  private readonly groups = new Set<string>()
  private units = 0
  private keys = 0

  constructor(
    private readonly maxUnits = FETCH_MAX_INSTANCES,
    private readonly maxKeys = FETCH_MAX_KEYS,
  ) {}

  /** Take `instance` into the fetch; false when it does not fit (nothing taken). */
  take(instance: PackableInstance): boolean {
    const packed = packGroup(instance)
    if (packed === undefined) {
      if (this.units >= this.maxUnits) return false
      this.units += 1
      return true
    }
    const fresh = !this.groups.has(packed.group)
    if (fresh && this.units >= this.maxUnits) return false
    if (this.keys >= this.maxKeys) return false
    if (fresh) {
      this.groups.add(packed.group)
      this.units += 1
    }
    this.keys += 1
    return true
  }

  /** What the fetch goes as: its wire instances and the keys they name. */
  get size(): { readonly instances: number; readonly keys: number } {
    return { instances: this.units, keys: this.keys }
  }
}
