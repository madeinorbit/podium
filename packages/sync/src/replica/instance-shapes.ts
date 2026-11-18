/**
 * HOW A HELD INSTANCE IS FOUND FOR A RECORD (POD-7119).
 *
 * A keyed collection ("the sessions of issue X", "one issue by id") is found
 * by its key: the record's field gives the instance's one argument, so a
 * change looks its instances up by key, once per declared `via`. Every other
 * instance is "listed": a collection without a key field (the policy's, a
 * tree, a page with two arguments), or a keyed marker whose shape the key
 * cannot reach (its argument missing, others besides it, a `via` this build
 * does not declare). Listed instances are few; the marker map keeps them
 * apart as markers are set, so no reader walks every marker to find them.
 *
 * Only `@podium/model` and the kernel types are imported here: the marker map
 * (`cache-state.ts`) and the holdings (`holdings.ts`) both read these rules.
 */

import {
  type Clause,
  COLLECTIONS,
  type Collection,
  type ComesWith,
  clausesOf,
  instanceParams,
  isParam,
  RECORD_KINDS,
  recordOf,
} from '@podium/model'
import type { InstanceRecord, InstanceSpec } from './types'

/** An instance as the index reads it: a marker (with its range) or a fetch in flight. */
export type HeldSpec = InstanceSpec & { readonly range?: InstanceRecord['range'] }

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
/** The field a keyed collection's one argument equals; `undefined` for any other collection. */
export function cachedKeyField(collection: Collection): string | undefined {
  let field = keyFieldCache.get(collection.id)
  if (field === undefined) {
    field = keyFieldOf(collection) ?? null
    keyFieldCache.set(collection.id, field)
  }
  return field ?? undefined
}

/** A keyed collection: the field its one argument equals, and every `via` an instance can name. */
export interface KeyedShape {
  readonly collection: Collection
  readonly field: string
  readonly param: string
  /** `undefined` (no via) first, then every declared holder. */
  readonly vias: readonly (string | undefined)[]
  readonly declaredVias: ReadonlySet<string>
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

/** A collection's keyed shape, by id; `null` for one found by listing its instances. */
const keyedShapes = new Map<string, KeyedShape | null>()
export function keyedShapeOf(collectionId: string): KeyedShape | undefined {
  let shape = keyedShapes.get(collectionId)
  if (shape === undefined) {
    const collection = COLLECTIONS.get(collectionId)
    const field = collection === undefined ? undefined : cachedKeyField(collection)
    const declaredVias = viasOf(collectionId)
    shape =
      collection === undefined || field === undefined
        ? null
        : {
            collection,
            field,
            param: instanceParams(collection)[0] as string,
            vias: [undefined, ...declaredVias],
            declaredVias,
          }
    keyedShapes.set(collectionId, shape)
  }
  return shape ?? undefined
}

/** The keyed shapes of a record kind's collections, in declaration order. */
const keyedByKind = new Map<string, readonly KeyedShape[]>()
export function keyedShapesOfKind(kind: string): readonly KeyedShape[] {
  let shapes = keyedByKind.get(kind)
  if (shapes === undefined) {
    const out: KeyedShape[] = []
    for (const collection of COLLECTIONS.values()) {
      if (collection.of !== kind) continue
      const shape = keyedShapeOf(collection.id)
      if (shape !== undefined) out.push(shape)
    }
    shapes = out
    keyedByKind.set(kind, shapes)
  }
  return shapes
}

/**
 * Whether a held instance can be found only by listing (see the file
 * header). A collection this build does not declare is neither: no record
 * belongs to it.
 */
export function isListed(spec: HeldSpec): boolean {
  if (!COLLECTIONS.has(spec.collection)) return false
  const shape = keyedShapeOf(spec.collection)
  if (shape === undefined) return true
  if (spec.via !== undefined && spec.via !== '' && !shape.declaredVias.has(spec.via)) return true
  const args = spec.args as Readonly<Record<string, unknown>> | undefined
  if (args === undefined || args[shape.param] === undefined || args[shape.param] === null)
    return true
  for (const name in args) if (name !== shape.param) return true
  return false
}
