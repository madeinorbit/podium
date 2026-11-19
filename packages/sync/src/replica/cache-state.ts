/**
 * THE CACHE'S OWN STATE, ONE DEFINITION FOR EVERY ADAPTER (POD-7086, design
 * POD-7059 "The feed", "Memory, cache and leaving").
 *
 * An adapter stores rows, a cursor, the markers of the instances it holds,
 * the server's policy and whether a load is still under way. What one
 * mutation does to them is decided here, once, as pure functions; the
 * in-memory, IndexedDB and SQLite adapters only translate the result into
 * their own writes. Two adapters that each re-derived "the newer one wins"
 * would be two answers to the same question.
 */

import { isListed } from './instance-shapes'
import type { CacheMutation, CacheOperation } from './ports'
import {
  type CachePolicy,
  type Cursor,
  type EntityRecord,
  type InstanceArgs,
  type InstanceRecord,
  type InstanceSpec,
  type KindTokens,
  rowAsOf,
} from './types'

/** The stored cursor: the feed position, with the shape tokens of the rows it describes. */
export interface ScopedCacheCursor extends Cursor {
  readonly kindTokens?: KindTokens
}

/** Keep adapter-private metadata out of the feed cursor port. */
export function cursorTriple(cursor: Cursor | null): Cursor | null {
  return cursor === null ? null : { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq }
}

/** A cursor is a triple; equal seq alone cannot certify another feed or epoch. */
export function sameCursor(a: Cursor | null, b: Cursor | null): boolean {
  return a !== null && b !== null && a.feedId === b.feedId && a.epoch === b.epoch && a.seq === b.seq
}

// ---------------------------------------------------------------------------
// Instance identity
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** The one key of an instance: collection, part, holder and its arguments in key order. */
export function instanceKey(spec: InstanceSpec): string {
  const args: InstanceArgs = spec.args ?? {}
  return `${spec.collection}|${spec.part}|${spec.via ?? ''}|${canonical(args)}`
}

// ---------------------------------------------------------------------------
// Metadata: cursor, markers, policy, load
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Markers: a map each mutation extends without copying
// ---------------------------------------------------------------------------

/**
 * POD-7115 — the markers of one cache, as a value each mutation replaces.
 *
 * A mutation's markers are a new map (the replica caches by its identity),
 * but copying every marker per mutation made a first download quadratic:
 * each chunk and each fetched instance is its own mutation, and the comes-with
 * markers number in the thousands. This map is a frozen base plus a small
 * layer of the changes since it; a mutation copies only that layer, and folds
 * it into a new base once it outgrows the square root of the base. Iteration
 * order is a `Map`'s: a key set again keeps its place, a key deleted and set
 * again goes last.
 */
export class InstanceMap implements ReadonlyMap<string, InstanceRecord> {
  /** A plain map of every marker, made on the first iteration (the map never changes). */
  private flat: Map<string, InstanceRecord> | undefined

  private constructor(
    private readonly base: ReadonlyMap<string, InstanceRecord>,
    /** Changed keys: the new record, or `undefined` once deleted. */
    private readonly changes: ReadonlyMap<string, InstanceRecord | undefined>,
    /** Keys that iterate after the base, in the order they were (re)added. */
    private readonly appended: ReadonlyMap<string, true>,
    readonly size: number,
    /** POD-7119: the markers only a listing finds (`isListed`), kept as markers are set. */
    private readonly listedOnes: ReadonlyMap<string, InstanceRecord>,
  ) {}

  /** An editor over `from`; `done()` gives the next map and leaves `from` as it was. */
  static edit(from: ReadonlyMap<string, InstanceRecord>): InstanceMapEditor {
    if (from instanceof InstanceMap)
      return new InstanceMapEditor(
        from,
        from.base,
        from.changes,
        from.appended,
        from.size,
        from.listedOnes,
      )
    return new InstanceMapEditor(from, from, new Map(), new Map(), from.size, listedMarkers(from))
  }

  /** @internal The editor's result. */
  static of(
    base: ReadonlyMap<string, InstanceRecord>,
    changes: ReadonlyMap<string, InstanceRecord | undefined>,
    appended: ReadonlyMap<string, true>,
    size: number,
    listed: ReadonlyMap<string, InstanceRecord>,
  ): InstanceMap {
    return new InstanceMap(base, changes, appended, size, listed)
  }

  /** The markers a record's key cannot find (POD-7119): few, and never found by walking every marker. */
  listed(): ReadonlyMap<string, InstanceRecord> {
    return this.listedOnes
  }

  get(key: string): InstanceRecord | undefined {
    return this.changes.has(key) ? this.changes.get(key) : this.base.get(key)
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  /**
   * The frozen base and the changes over it, for a reader that keeps what it
   * derives from the base (POD-7119: the held index lists a few instances
   * once per base, then follows the changes).
   */
  layers(): {
    readonly base: ReadonlyMap<string, InstanceRecord>
    readonly changes: ReadonlyMap<string, InstanceRecord | undefined>
  } {
    return { base: this.base, changes: this.changes }
  }

  entries(): MapIterator<[string, InstanceRecord]> {
    return this.plain().entries()
  }

  keys(): MapIterator<string> {
    return this.plain().keys()
  }

  values(): MapIterator<InstanceRecord> {
    return this.plain().values()
  }

  [Symbol.iterator](): MapIterator<[string, InstanceRecord]> {
    return this.plain().entries()
  }

  forEach(
    callback: (
      value: InstanceRecord,
      key: string,
      map: ReadonlyMap<string, InstanceRecord>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.plain()) callback.call(thisArg, value, key, this)
  }

  private plain(): Map<string, InstanceRecord> {
    if (this.flat === undefined) {
      if (this.changes.size === 0 && this.base instanceof Map) return this.base
      this.flat = flatten(this.base, this.changes, this.appended)
    }
    return this.flat
  }
}

/** Every marker of a layered map, in `Map` order. */
function flatten(
  base: ReadonlyMap<string, InstanceRecord>,
  changes: ReadonlyMap<string, InstanceRecord | undefined>,
  appended: ReadonlyMap<string, true>,
): Map<string, InstanceRecord> {
  const out = new Map<string, InstanceRecord>()
  for (const [key, record] of base) {
    if (appended.has(key)) continue
    const value = changes.has(key) ? changes.get(key) : record
    if (value !== undefined) out.set(key, value)
  }
  for (const key of appended.keys()) {
    const value = changes.get(key)
    if (value !== undefined) out.set(key, value)
  }
  return out
}

/** The changes one mutation makes to the markers, staged over the map it started from. */
export class InstanceMapEditor {
  private touched = false
  private listedOwned = false

  constructor(
    private readonly from: ReadonlyMap<string, InstanceRecord>,
    private base: ReadonlyMap<string, InstanceRecord>,
    private changes: ReadonlyMap<string, InstanceRecord | undefined>,
    private appended: ReadonlyMap<string, true>,
    private count: number,
    private listed: ReadonlyMap<string, InstanceRecord>,
  ) {}

  get(key: string): InstanceRecord | undefined {
    return this.changes.has(key) ? this.changes.get(key) : this.base.get(key)
  }

  set(key: string, record: InstanceRecord): void {
    const { changes, appended } = this.own()
    if (this.get(key) === undefined) {
      // A new key, or one deleted before: it goes last, as in a `Map`.
      this.count += 1
      appended.delete(key)
      appended.set(key, true)
    }
    changes.set(key, record)
    if (isListed(record)) this.ownListed().set(key, record)
    else if (this.listed.has(key)) this.ownListed().delete(key)
  }

  delete(key: string): boolean {
    if (this.get(key) === undefined) return false
    const { changes, appended } = this.own()
    this.count -= 1
    appended.delete(key)
    if (this.base.has(key)) changes.set(key, undefined)
    else changes.delete(key)
    if (this.listed.has(key)) this.ownListed().delete(key)
    return true
  }

  clear(): void {
    this.touched = true
    this.base = new Map()
    this.changes = new Map()
    this.appended = new Map()
    this.count = 0
    this.listed = new Map()
    this.listedOwned = true
  }

  /** The markers after this mutation: the map it started from when nothing changed. */
  done(): ReadonlyMap<string, InstanceRecord> {
    if (!this.touched) return this.from
    // Past the square root of the base, the layer folds into a new base: a
    // mutation copies at most that many changes, and a fold is paid for by
    // the mutations that grew the layer.
    if (this.changes.size > Math.max(32, Math.ceil(Math.sqrt(this.base.size)))) {
      const folded = flatten(this.base, this.changes, this.appended)
      return InstanceMap.of(folded, new Map(), new Map(), folded.size, this.listed)
    }
    return InstanceMap.of(this.base, this.changes, this.appended, this.count, this.listed)
  }

  /** The listed markers this editor writes: copied once (they are few). */
  private ownListed(): Map<string, InstanceRecord> {
    if (!this.listedOwned) {
      this.listedOwned = true
      this.listed = new Map(this.listed)
    }
    return this.listed as Map<string, InstanceRecord>
  }

  /** The layer this editor writes: copied once, so the map it started from stays as it was. */
  private own(): {
    changes: Map<string, InstanceRecord | undefined>
    appended: Map<string, true>
  } {
    if (!this.touched) {
      this.touched = true
      this.changes = new Map(this.changes)
      this.appended = new Map(this.appended)
    }
    return {
      changes: this.changes as Map<string, InstanceRecord | undefined>,
      appended: this.appended as Map<string, true>,
    }
  }
}

/** The listed markers of a decoded map, registered as it decodes (a decoded map is never changed). */
const listedOfPlain = new WeakMap<ReadonlyMap<string, unknown>, ReadonlyMap<string, unknown>>()

/**
 * The markers of `markers` that only a listing finds (`isListed`). A layered
 * map keeps them and a decoded map had them registered; any other plain map
 * (a test's, an empty one) is walked, since nothing says it stays unchanged.
 */
export function listedMarkers<T extends InstanceSpec>(
  markers: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> {
  // By shape, not class: a second copy of this module in a bundle has its own InstanceMap.
  const layered = markers as unknown as Partial<InstanceMap>
  if (typeof layered.listed === 'function')
    return layered.listed() as unknown as ReadonlyMap<string, T>
  const decoded = listedOfPlain.get(markers) as ReadonlyMap<string, T> | undefined
  if (decoded !== undefined) return decoded
  const out = new Map<string, T>()
  for (const [key, spec] of markers) if (isListed(spec)) out.set(key, spec)
  return out
}

/** One principal's cache metadata. */
export interface CacheMeta {
  readonly cursor: ScopedCacheCursor | null
  readonly instances: ReadonlyMap<string, InstanceRecord>
  readonly policy: CachePolicy | null
  readonly loadingSince: number | null
}

export const EMPTY_CACHE_META: CacheMeta = Object.freeze({
  cursor: null,
  instances: new Map<string, InstanceRecord>(),
  policy: null,
  loadingSince: null,
})

/** The metadata keys every adapter stores, namespaced per principal by its own key. */
export const CURSOR_META_KEY = 'cursor'
export const POLICY_META_KEY = 'policy'
export const LOADING_SINCE_META_KEY = 'loading-since'
/** Markers are one metadata row each, under this prefix. */
export const INSTANCE_META_PREFIX = 'instance\u0000'
/** The first key past every marker: `[prefix, end)` is the marker range. */
export const INSTANCE_META_END = 'instance\u0001'

export const instanceMetaKey = (key: string): string => `${INSTANCE_META_PREFIX}${key}`

/** One durable metadata write, in order. */
export type MetaWrite =
  | { readonly kind: 'put'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly key: string }
  /** Delete every marker row of this principal, including ones another tab wrote. */
  | { readonly kind: 'deleteInstances' }

/** What a mutation does to the metadata, and the writes that make it durable. */
export function nextCacheMeta(
  meta: CacheMeta,
  mutation: CacheMutation,
): { readonly meta: CacheMeta; readonly writes: readonly MetaWrite[] } {
  const writes: MetaWrite[] = []
  let cursor = meta.cursor
  if (mutation.cursor !== undefined) {
    const sameFeed =
      meta.cursor !== null &&
      meta.cursor.feedId === mutation.cursor.feedId &&
      meta.cursor.epoch === mutation.cursor.epoch
    const kindTokens = mutation.kindTokens ?? (sameFeed ? meta.cursor?.kindTokens : undefined)
    const triple = cursorTriple(mutation.cursor) as Cursor
    cursor = kindTokens === undefined ? triple : { ...triple, kindTokens: { ...kindTokens } }
    writes.push({ kind: 'put', key: CURSOR_META_KEY, value: cursor })
  }
  let instances = meta.instances
  if (mutation.instances !== undefined && mutation.instances.length > 0) {
    const next = InstanceMap.edit(meta.instances)
    for (const op of mutation.instances) {
      switch (op.kind) {
        case 'mark':
          next.set(op.instance.key, op.instance)
          writes.push({ kind: 'put', key: instanceMetaKey(op.instance.key), value: op.instance })
          break
        case 'drop':
          if (next.delete(op.key)) writes.push({ kind: 'delete', key: instanceMetaKey(op.key) })
          break
        case 'dropAll':
          next.clear()
          writes.push({ kind: 'deleteInstances' })
          break
        case 'stale':
          // The marker stays as it was; the stale flag is the disk index's.
          break
        case 'release': {
          const held = next.get(op.key)
          if (held === undefined) break
          const released = { ...held, releasedAt: op.at }
          next.set(op.key, released)
          writes.push({ kind: 'put', key: instanceMetaKey(op.key), value: released })
          break
        }
      }
    }
    instances = next.done()
  }
  let policy = meta.policy
  if (mutation.policy !== undefined) {
    policy = mutation.policy
    writes.push(
      policy === null
        ? { kind: 'delete', key: POLICY_META_KEY }
        : { kind: 'put', key: POLICY_META_KEY, value: policy },
    )
  }
  let loadingSince = meta.loadingSince
  if (mutation.loadingSince !== undefined) {
    loadingSince = mutation.loadingSince
    writes.push(
      loadingSince === null
        ? { kind: 'delete', key: LOADING_SINCE_META_KEY }
        : { kind: 'put', key: LOADING_SINCE_META_KEY, value: loadingSince },
    )
  }
  return { meta: { cursor, instances, policy, loadingSince }, writes }
}

const isCursor = (value: unknown): value is ScopedCacheCursor => {
  const row = value as Partial<Cursor> | null
  return (
    row !== null &&
    typeof row === 'object' &&
    typeof row.feedId === 'string' &&
    typeof row.epoch === 'string' &&
    typeof row.seq === 'number' &&
    Number.isSafeInteger(row.seq) &&
    row.seq >= 0
  )
}

const isInstance = (value: unknown): value is InstanceRecord => {
  const row = value as Partial<InstanceRecord> | null
  return (
    row !== null &&
    typeof row === 'object' &&
    typeof row.key === 'string' &&
    typeof row.collection === 'string' &&
    (row.part === 'stub' || row.part === 'main') &&
    isCursor(row.completeAt)
  )
}

const isPolicy = (value: unknown): value is CachePolicy => {
  const row = value as Partial<CachePolicy> | null
  return (
    row !== null &&
    typeof row === 'object' &&
    typeof row.clientType === 'string' &&
    Array.isArray(row.steps) &&
    typeof row.recentDays === 'number' &&
    typeof row.cacheCap === 'number'
  )
}

/**
 * Read one principal's metadata back from its stored rows. Fail-open: a row
 * this build cannot read is no marker, never a boot refusal; a load whose
 * feed number cannot be read restarts as a load.
 */
export function decodeCacheMeta(
  rows: Iterable<{ readonly key: string; readonly value: unknown }>,
): CacheMeta {
  let cursor: ScopedCacheCursor | null = null
  const instances = new Map<string, InstanceRecord>()
  const listed = new Map<string, InstanceRecord>()
  let policy: CachePolicy | null = null
  let loadingSince: number | null = null
  for (const { key, value } of rows) {
    if (key === CURSOR_META_KEY) cursor = isCursor(value) ? value : null
    else if (key === POLICY_META_KEY) policy = isPolicy(value) ? value : null
    else if (key === LOADING_SINCE_META_KEY)
      loadingSince = typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
    else if (key.startsWith(INSTANCE_META_PREFIX) && isInstance(value)) {
      // POD-7159: the instance's disk-index state rides beside the marker (`_s`).
      const { _s: _state, ...marker } = value as InstanceRecord & { readonly _s?: unknown }
      instances.set(marker.key, marker)
      if (isListed(marker)) listed.set(marker.key, marker)
      else listed.delete(marker.key)
    }
  }
  listedOfPlain.set(instances, listed)
  return { cursor, instances, policy, loadingSince }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * What one operation leaves for one row: the row to write, `null` to delete
 * it, or `undefined` when the operation is skipped because the row it would
 * replace is current as of the same or a later feed number.
 */
export function rowAfter(
  existing: EntityRecord | undefined,
  op: CacheOperation,
): EntityRecord | null | undefined {
  if (
    op.asOf !== undefined &&
    existing !== undefined &&
    !(op.kind === 'upsert' && op.force === true)
  ) {
    const held = rowAsOf(existing)
    // A stub is current only for its stub fields: the whole record read at the
    // same feed number brings the main part, so it is newer for this row.
    const fills = op.kind === 'upsert' && op.part === undefined && existing.part === 'stub'
    if (held > op.asOf || (held === op.asOf && !fills)) return undefined
  }
  if (op.kind !== 'upsert') return null
  return {
    entity: op.entity,
    entityId: op.entityId,
    value: op.value,
    revision: op.revision,
    provenance: op.provenance,
    ...(op.part === undefined ? {} : { part: op.part }),
    ...(op.asOf === undefined ? {} : { asOf: op.asOf }),
  }
}

/** Whether a row carries the record's main part (the rows `readEntities` and `read` answer). */
export const isMainRow = (row: EntityRecord): boolean => row.part !== 'stub'
