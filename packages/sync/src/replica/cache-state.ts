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
    const next = new Map(meta.instances)
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
    instances = next
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
  let policy: CachePolicy | null = null
  let loadingSince: number | null = null
  for (const { key, value } of rows) {
    if (key === CURSOR_META_KEY) cursor = isCursor(value) ? value : null
    else if (key === POLICY_META_KEY) policy = isPolicy(value) ? value : null
    else if (key === LOADING_SINCE_META_KEY)
      loadingSince = typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
    else if (key.startsWith(INSTANCE_META_PREFIX) && isInstance(value))
      instances.set(value.key, value)
  }
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
