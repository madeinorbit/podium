/**
 * THE DISK INDEX (POD-7159, design POD-7157 "The disk index", "Layer 1").
 *
 * The device's local storage keeps every record it has fetched; memory keeps
 * only the resident set. Feed apply, the loader and the trim must decide about
 * records that are not in memory without reading the disk (IndexedDB reads are
 * asynchronous), so the device keeps a compact index of everything on disk,
 * always in memory:
 *
 *  - per record (`entity\0id`): the feed number it is current as of (newest
 *    wins), its level (stub or main), its approximate size in bytes, and the
 *    main-part instances that hold it;
 *  - per instance: its marker (the store's `InstanceMap`, `cache-state.ts`),
 *    its member keys, when a view last read it, whether it is in memory, and
 *    whether it is stale (the field only: POD-7160 sets it).
 *
 * This is the one answer to "what does the device hold". It is written in the
 * same transaction as the rows it describes (each adapter turns a draft's
 * changes into durable index rows), and read whole at start, with no rows.
 *
 * Members are kept for main-part instances only: a stub-part instance's rows
 * are stubs, and the stub table is always resident. The durable form keeps
 * membership on the record (its holders); the members of an instance are
 * rebuilt from them when the index is read.
 *
 * WHAT A RECORD COMES WITH IS NOT AN INSTANCE (design POD-7157, "The disk
 * index"). A keyed comes-with instance ("the sessions of issue X", "the parent
 * of X") is recorded on its holder record instead: the record's comes-with
 * complete vias (`cw`: the holders it came with as a member of, `issueProjection`
 * or `issueProjection.tree`), and on each row it brings, the holder record as
 * a holder (`^` + its row key). A pointer ("X's parent", "a session's issue")
 * is one record, found by key. So the markers are bounded by views and the
 * policy, not by records.
 *
 * ON DISK the index is about 256 BUCKET rows, each the entries of the records
 * whose key hashes to it, so reading it at start is a few large reads; an
 * instance's state rides in its marker row, which the open reads anyway.
 *
 * A dropped instance's key is left in its members' holders rather than
 * rewriting every one of them: an instance's members are a superset of what
 * its rule selects, never fewer, and a reader evaluates the rule over the rows
 * anyway.
 */

import { COLLECTIONS, instanceParams, recordOf } from '@podium/model'
import { INSTANCE_META_PREFIX, instanceKey } from './cache-state'
import {
  comesWithEntry,
  comesWithOf,
  holds,
  policyArgs,
  type ResolvedInstance,
  resolveInstance,
  stubFieldsOf,
  stubOfValue,
} from './holdings'
import { cachedKeyField, keyedShapesOfKind } from './instance-shapes'
import type { CacheMutation } from './ports'
import type { CachePolicy, EntityRecord, InstanceRecord, InstanceSpec } from './types'
import { rowAsOf } from './types'

const SEPARATOR = '\u0000'

/** The row key of a record: `entity\0entityId`. */
export const rowKeyOf = (entity: string, entityId: string): string =>
  `${entity}${SEPARATOR}${entityId}`

/** The entity and id of a row key. */
export function splitRowKey(key: string): { readonly entity: string; readonly entityId: string } {
  const at = key.indexOf(SEPARATOR)
  return at < 0
    ? { entity: key, entityId: '' }
    : { entity: key.slice(0, at), entityId: key.slice(at + 1) }
}

/** One record on the device's disk. */
export interface RecordEntry {
  /** The feed number the row is current as of (`rowAsOf`). */
  readonly seq: number
  readonly level: 'stub' | 'main'
  /** Approximate stored size of the row. */
  readonly bytes: number
  /**
   * The main-part instances whose member it is (instance keys), and the
   * records it comes with (`^` + their row key).
   */
  readonly holders: readonly string[]
  /**
   * The vias whose comes-with of this record is complete on the device (a
   * record kind, or a collection it is a member of). Empty for a stub.
   */
  readonly cw: readonly string[]
}

/** The holder a row brought by a record carries: that record. */
export const COMES_WITH_HOLDER = '^'
export const comesWithHolderKey = (rowKey: string): string => `${COMES_WITH_HOLDER}${rowKey}`
export const isComesWithHolder = (holder: string): boolean => holder.startsWith(COMES_WITH_HOLDER)

/** Index buckets on disk (design "The index on disk is bucketed"). */
export const INDEX_BUCKETS = 256
/** The key of a bucket row in an adapter's index table. */
export const indexBucketKey = (bucket: number): string => `b${bucket.toString().padStart(3, '0')}`
/**
 * The holder record of a keyed comes-with instance that selects the holder's
 * own things ("the sessions of issue X", via its kind or a collection it is in):
 * X's row key. `undefined` for any other instance, a pointer among them.
 */
export function comesWithHolderOf(spec: InstanceSpec): string | undefined {
  if (spec.via === undefined) return undefined
  const entry = comesWithEntry(spec.via, spec.collection)
  if (entry === undefined || entry.key !== undefined) return undefined
  const holderKind = recordOf(spec.via) !== undefined ? spec.via : COLLECTIONS.get(spec.via)?.of
  const collection = COLLECTIONS.get(spec.collection)
  if (holderKind === undefined || collection === undefined) return undefined
  const param = instanceParams(collection)[0]
  const id = param === undefined ? undefined : spec.args?.[param]
  return typeof id === 'string' ? rowKeyOf(holderKind, id) : undefined
}

/**
 * The one record a pointer comes-with instance selects ("X's parent", "a
 * session's issue": a one-record collection named by another of the holder's
 * fields): its row key. `undefined` for any other instance.
 */
export function pointerTargetOf(spec: InstanceSpec): string | undefined {
  if (spec.via === undefined) return undefined
  const entry = comesWithEntry(spec.via, spec.collection)
  if (entry === undefined || entry.key === undefined) return undefined
  const collection = COLLECTIONS.get(spec.collection)
  const id = spec.args?.['id']
  if (
    collection === undefined ||
    spec.collection !== `${collection.of}.one` ||
    typeof id !== 'string'
  )
    return undefined
  return rowKeyOf(collection.of, id)
}

/**
 * The records a row comes with, by the holders' comes-with complete vias
 * (design "What comes with a record is not a separate instance"): for each
 * keyed comes-with collection of its kind that selects its holder's own things,
 * the holder whose comes-with through that via is complete, when the row
 * belongs to it by the entry's rule. As holder keys (`^` + row key).
 */
export function comesWithHolders(
  kind: string,
  value: unknown,
  args: Parameters<typeof resolveInstance>[1],
  rows: { readRow(entity: string, entityId: string): EntityRecord | undefined },
  now: number,
  index: DiskIndexReader,
): string[] {
  const record = (value ?? {}) as Readonly<Record<string, unknown>>
  const out: string[] = []
  for (const shape of keyedShapesOfKind(kind)) {
    const id = record[shape.field]
    if (typeof id !== 'string' || id === '') continue
    for (const via of shape.declaredVias) {
      const spec: InstanceSpec = {
        collection: shape.collection.id,
        args: { [shape.param]: id },
        part: 'main',
        via,
      }
      const holder = comesWithHolderOf(spec)
      if (holder === undefined || index.record(holder)?.cw.includes(via) !== true) continue
      const instance = resolveInstance(spec, args)
      if (instance !== undefined && holds(instance, kind, value, rows, now))
        out.push(comesWithHolderKey(holder))
    }
  }
  return out.length < 2 ? out : [...new Set(out)]
}

/**
 * Whether a whole row on disk is held by nothing the device keeps: no marked
 * instance, and no record on the device it comes with. Such a row is in
 * memory from the start (nothing would load it); every other one is loaded
 * with what holds it.
 */
export function heldByNothing(
  entry: RecordEntry,
  markers: ReadonlyMap<string, unknown>,
  index: DiskIndexReader,
): boolean {
  return !entry.holders.some((holder) =>
    isComesWithHolder(holder)
      ? index.record(holder.slice(COMES_WITH_HOLDER.length))?.level === 'main'
      : markers.has(holder),
  )
}

/** The bucket a record key lands in (FNV-1a). */
export function bucketOf(key: string): number {
  let hash = 0x811c9dc5
  for (let at = 0; at < key.length; at += 1) {
    hash ^= key.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % INDEX_BUCKETS
}

/** One instance on the device's disk, beside its marker. */
export interface InstanceState {
  /** When a view last read it (ms). */
  readonly lastReadAt: number
  /** Its marker is behind the feed (POD-7160 sets it; read from disk as usual). */
  readonly stale: boolean
  /** Its members are known: a disk load can answer it. */
  readonly indexed: boolean
}

/** What the replica and the loader read of the index. */
export interface DiskIndexReader {
  /** Bumped on every change. */
  readonly version: number
  /** Records on disk. */
  readonly recordCount: number
  /** Approximate bytes of every record on disk. */
  readonly bytes: number
  record(key: string): RecordEntry | undefined
  records(): IterableIterator<[string, RecordEntry]>
  /** The member row keys of a main-part instance (empty for an unknown one). */
  membersOf(instanceKey: string): ReadonlySet<string>
  instance(instanceKey: string): InstanceState | undefined
  /** Whether the instance's rows are in memory (its marker answers `isComplete`). */
  inMemory(instanceKey: string): boolean
  /** Every instance in memory. */
  memoryInstances(): ReadonlySet<string>
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const NO_HOLDERS: readonly string[] = Object.freeze([]) as readonly string[]
const NO_VIAS: readonly string[] = NO_HOLDERS

/**
 * Holder lists, shared: most records of one instance have the same holders,
 * so each distinct list is one frozen array (the index's memory is mostly one
 * entry per record, not one array per record).
 */
class HolderLists {
  private readonly lists = new Map<string, readonly string[]>()

  of(holders: readonly string[]): readonly string[] {
    if (holders.length === 0) return NO_HOLDERS
    const sorted = holders.length === 1 ? holders : [...new Set(holders)].sort()
    const id = sorted.join('\u0001')
    const held = this.lists.get(id)
    if (held !== undefined) return held
    const list = Object.freeze([...sorted]) as readonly string[]
    this.lists.set(id, list)
    return list
  }

  clear(): void {
    this.lists.clear()
  }
}

/** The approximate stored size of a row. */
export function approxBytes(row: Pick<EntityRecord, 'value'>): number {
  const value = row.value
  if (typeof value === 'string') return value.length + 64
  try {
    return (JSON.stringify(value)?.length ?? 4) + 64
  } catch {
    return 1024
  }
}

/** The index of one principal's disk, in memory. Changed only by publishing a draft (or at open). */
export class DiskIndex implements DiskIndexReader {
  private readonly entries = new Map<string, RecordEntry>()
  private readonly members = new Map<string, Set<string>>()
  /** The record keys of each disk bucket (a commit rewrites the buckets it touched). */
  private readonly buckets: Set<string>[] = Array.from({ length: INDEX_BUCKETS }, () => new Set())
  private readonly states = new Map<string, InstanceState>()
  private readonly memory = new Set<string>()
  private readonly lists = new HolderLists()
  private totalBytes = 0
  private changes = 0

  get version(): number {
    return this.changes
  }

  get recordCount(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  record(key: string): RecordEntry | undefined {
    return this.entries.get(key)
  }

  records(): IterableIterator<[string, RecordEntry]> {
    return this.entries.entries()
  }

  membersOf(instanceKey: string): ReadonlySet<string> {
    return this.members.get(instanceKey) ?? EMPTY_SET
  }

  instance(instanceKey: string): InstanceState | undefined {
    return this.states.get(instanceKey)
  }

  instanceKeys(): IterableIterator<string> {
    return this.states.keys()
  }

  inMemory(instanceKey: string): boolean {
    return this.memory.has(instanceKey)
  }

  memoryInstances(): ReadonlySet<string> {
    return this.memory
  }

  /** A shared holder list (for building entries). */
  holderList(holders: readonly string[]): readonly string[] {
    return this.lists.of(holders)
  }

  /** The record keys of one disk bucket. */
  bucketKeys(bucket: number): ReadonlySet<string> {
    return this.buckets[bucket] ?? EMPTY_SET
  }

  /** Put an entry directly (open, migration). */
  putRecord(key: string, entry: RecordEntry): void {
    this.setRecord(key, {
      ...entry,
      holders: this.lists.of(entry.holders),
      cw: this.lists.of(entry.cw),
    })
  }

  /** Put an instance's state directly (open, migration). */
  putInstance(key: string, state: InstanceState): void {
    this.states.set(key, state)
    this.changes += 1
  }

  /** Mark instances in or out of memory (the loader's disk source; an unload). */
  setInMemory(keys: Iterable<string>, inMemory: boolean): void {
    for (const key of keys) {
      if (inMemory) this.memory.add(key)
      else this.memory.delete(key)
    }
    this.changes += 1
  }

  /** Note a read in memory only (a view held it); the next release or mark writes it. */
  touch(key: string, at: number): void {
    const state = this.states.get(key)
    if (state === undefined || state.lastReadAt >= at) return
    this.states.set(key, { ...state, lastReadAt: at })
  }

  /** Forget everything (a discard, a snapshot install's start). */
  clear(): void {
    this.entries.clear()
    this.members.clear()
    for (const bucket of this.buckets) bucket.clear()
    this.states.clear()
    this.memory.clear()
    this.lists.clear()
    this.totalBytes = 0
    this.changes += 1
  }

  /**
   * Apply a published draft. A dropped instance keeps its members (its key
   * stays in their holders, see the header): marked again, it holds them as
   * before; a member leaves it only when the member's own entry changes.
   */
  publish(draft: DiskIndexDraft): void {
    if (draft.cleared) {
      this.entries.clear()
      this.members.clear()
      for (const bucket of this.buckets) bucket.clear()
      this.states.clear()
      this.memory.clear()
      this.lists.clear()
      this.totalBytes = 0
    } else if (draft.instancesCleared) {
      this.states.clear()
      this.memory.clear()
    }
    for (const key of draft.droppedInstances) {
      this.states.delete(key)
      this.memory.delete(key)
    }
    for (const [key, entry] of draft.recordChanges) this.setRecord(key, entry)
    for (const [key, state] of draft.instanceChanges) {
      if (state === null) {
        this.states.delete(key)
        this.memory.delete(key)
      } else this.states.set(key, state)
    }
    for (const key of draft.markedInMemory) if (this.states.has(key)) this.memory.add(key)
    this.changes += 1
  }

  private setRecord(key: string, entry: RecordEntry | null): void {
    const before = this.entries.get(key)
    if (before !== undefined) {
      this.totalBytes -= before.bytes
      for (const holder of before.holders)
        if (entry === null || !entry.holders.includes(holder)) this.members.get(holder)?.delete(key)
    }
    if (entry === null) {
      this.entries.delete(key)
      this.buckets[bucketOf(key)]?.delete(key)
      return
    }
    if (before === undefined) this.buckets[bucketOf(key)]?.add(key)
    this.entries.set(key, entry)
    this.totalBytes += entry.bytes
    for (const holder of entry.holders) {
      if (before?.holders.includes(holder) === true) continue
      let set = this.members.get(holder)
      if (set === undefined) {
        set = new Set()
        this.members.set(holder, set)
      }
      set.add(key)
    }
  }
}

/** One durable index write, for an adapter to turn into its own rows. */
export type IndexWrite =
  | { readonly kind: 'record'; readonly key: string; readonly entry: RecordEntry | null }
  | { readonly kind: 'instance'; readonly key: string; readonly state: InstanceState | null }
  /** Delete every instance state row of this principal. */
  | { readonly kind: 'clearInstances' }
  /** Delete every index row of this principal. */
  | { readonly kind: 'clearAll' }

/**
 * A transaction's changes to the index, private until publish (the same span
 * discipline as the rows: a draft that aborts changes nothing).
 */
export class DiskIndexDraft {
  readonly recordChanges = new Map<string, RecordEntry | null>()
  readonly instanceChanges = new Map<string, InstanceState | null>()
  readonly droppedInstances = new Set<string>()
  readonly markedInMemory = new Set<string>()
  cleared = false
  instancesCleared = false
  /** The durable writes, in order. */
  readonly writes: IndexWrite[] = []

  constructor(private readonly base: DiskIndex) {}

  record(key: string): RecordEntry | undefined {
    if (this.recordChanges.has(key)) return this.recordChanges.get(key) ?? undefined
    if (this.cleared) return undefined
    return this.base.record(key)
  }

  instance(key: string): InstanceState | undefined {
    if (this.instanceChanges.has(key)) return this.instanceChanges.get(key) ?? undefined
    if (this.cleared || this.instancesCleared || this.droppedInstances.has(key)) return undefined
    return this.base.instance(key)
  }

  /** Every record this draft leaves (a whole-store delete). */
  *recordKeys(): IterableIterator<string> {
    if (!this.cleared)
      for (const [key] of this.base.records())
        if (!this.recordChanges.has(key) || this.recordChanges.get(key) !== null) yield key
    for (const [key, entry] of this.recordChanges)
      if (entry !== null && (this.cleared || this.base.record(key) === undefined)) yield key
  }

  /** A row was written (`row`) or deleted (`null`). `holders` replaces its holders when given. */
  row(key: string, row: EntityRecord | null, holders?: readonly string[], bytes?: number): void {
    if (row === null) {
      if (this.record(key) === undefined && !this.recordChanges.has(key)) return
      this.putRecord(key, null)
      return
    }
    const before = this.record(key)
    const level = row.part === 'stub' ? 'stub' : 'main'
    // The records it comes with stay its holders through a change of its own.
    const brought = before?.holders.filter(isComesWithHolder) ?? NO_HOLDERS
    const kept =
      level === 'stub'
        ? NO_HOLDERS
        : holders === undefined
          ? (before?.holders ?? NO_HOLDERS)
          : brought.length === 0
            ? holders
            : [...holders, ...brought]
    this.putRecord(key, {
      seq: rowAsOf(row),
      level,
      bytes: bytes ?? approxBytes(row),
      holders: this.base.holderList(kept),
      cw: level === 'stub' ? NO_VIAS : (before?.cw ?? NO_VIAS),
    })
  }

  /** A row a record brings now carries that record as a holder (`^` + its key). */
  addHolder(key: string, holder: string): void {
    const entry = this.record(key)
    if (entry === undefined || entry.level !== 'main' || entry.holders.includes(holder)) return
    this.putRecord(key, { ...entry, holders: this.base.holderList([...entry.holders, holder]) })
  }

  /** The vias whose comes-with of a record is complete, replacing what it had. */
  setComesWith(key: string, vias: readonly string[]): void {
    const entry = this.record(key)
    if (entry === undefined || entry.level !== 'main') return
    const next = this.base.holderList(vias)
    if (next === entry.cw) return
    this.putRecord(key, { ...entry, cw: next })
  }

  /** An instance's marker was written, with the rows it holds when known. */
  mark(
    marker: InstanceRecord,
    members: readonly string[] | undefined,
    at: number | undefined,
  ): void {
    const key = marker.key
    this.droppedInstances.delete(key)
    if (marker.part === 'main' && members !== undefined)
      for (const member of members) {
        const entry = this.record(member)
        if (entry === undefined || entry.level !== 'main' || entry.holders.includes(key)) continue
        this.putRecord(member, {
          ...entry,
          holders: this.base.holderList([...entry.holders, key]),
        })
      }
    const before = this.instance(key)
    const state: InstanceState = {
      lastReadAt: Math.max(at ?? 0, before?.lastReadAt ?? 0),
      stale: false,
      indexed: marker.part === 'stub' || members !== undefined || before?.indexed === true,
    }
    this.instanceChanges.set(key, state)
    this.writes.push({ kind: 'instance', key, state })
    this.markedInMemory.add(key)
  }

  drop(key: string): void {
    if (this.instance(key) === undefined && !this.instanceChanges.has(key)) return
    this.instanceChanges.delete(key)
    this.droppedInstances.add(key)
    this.markedInMemory.delete(key)
    this.writes.push({ kind: 'instance', key, state: null })
  }

  dropAll(): void {
    this.instanceChanges.clear()
    this.droppedInstances.clear()
    this.markedInMemory.clear()
    this.instancesCleared = true
    this.writes.push({ kind: 'clearInstances' })
  }

  release(key: string, at: number): void {
    const before = this.instance(key)
    if (before === undefined) return
    const state = { ...before, lastReadAt: Math.max(before.lastReadAt, at) }
    this.instanceChanges.set(key, state)
    this.writes.push({ kind: 'instance', key, state })
  }

  /** Every row and instance gone (a discard, a snapshot install). */
  clearAll(): void {
    this.recordChanges.clear()
    this.instanceChanges.clear()
    this.droppedInstances.clear()
    this.markedInMemory.clear()
    this.cleared = true
    this.writes.push({ kind: 'clearAll' })
  }

  private putRecord(key: string, entry: RecordEntry | null): void {
    this.recordChanges.set(key, entry)
    this.writes.push({ kind: 'record', key, entry })
  }
}

/** What a draft leaves to write: the buckets it touched, and each instance's final state. */
export interface IndexChanges {
  /** Every index row of the principal goes first (a discard, a snapshot). */
  readonly clearAll: boolean
  /** The disk buckets whose records changed: each is rewritten whole. */
  readonly buckets: ReadonlySet<number>
  /** Instances whose state changed (`null`: dropped). Every instance first when `clearInstances`. */
  readonly instances: ReadonlyMap<string, InstanceState | null>
  readonly clearInstances: boolean
}

/** The durable changes of a draft, in their final state. */
export function indexChanges(draft: DiskIndexDraft): IndexChanges {
  let at = 0
  for (let i = draft.writes.length - 1; i >= 0; i -= 1)
    if (draft.writes[i]?.kind === 'clearAll') {
      at = i
      break
    }
  const clearAll = draft.writes[at]?.kind === 'clearAll'
  const buckets = new Set<number>()
  const instances = new Map<string, InstanceState | null>()
  let clearInstances = false
  for (let i = at; i < draft.writes.length; i += 1) {
    const write = draft.writes[i] as IndexWrite
    if (write.kind === 'record') buckets.add(bucketOf(write.key))
    else if (write.kind === 'instance') instances.set(write.key, write.state)
    else if (write.kind === 'clearInstances') {
      clearInstances = true
      instances.clear()
    }
  }
  return { clearAll, buckets, instances, clearInstances }
}

/** The record keys a bucket holds after a draft, in no particular order. */
export function bucketKeysAfter(draft: DiskIndexDraft, base: DiskIndex, bucket: number): string[] {
  const out: string[] = []
  if (!draft.cleared)
    for (const key of base.bucketKeys(bucket)) if (draft.record(key) !== undefined) out.push(key)
  for (const [key, entry] of draft.recordChanges)
    if (
      entry !== null &&
      bucketOf(key) === bucket &&
      (draft.cleared || base.record(key) === undefined)
    )
      out.push(key)
  return out
}

// ---------------------------------------------------------------------------
// The durable form, shared by the adapters
// ---------------------------------------------------------------------------

/** The key of an instance's state row in an adapter's index table. */
export const INDEX_INSTANCE_PREFIX = '\u0001'
/** The meta key that says the index of a principal was built (a store without it is rebuilt from its rows). */
export const INDEX_BUILT_META_KEY = 'disk-index'

/**
 * One bucket row's value, in columns (arrays of plain values read fast at
 * start): per record its key, feed number, level (1 main, 0 stub), size,
 * holders and comes-with vias (0 for none), and for a record with a stub its
 * stub (0 for none) and, held at stub level, the row's own fields
 * `[revision, provenance, asOf]` (0 for none).
 */
export interface StoredBucket {
  readonly k: readonly string[]
  readonly s: readonly number[]
  readonly l: readonly (0 | 1)[]
  readonly b: readonly number[]
  readonly h: readonly (readonly string[] | 0)[]
  readonly c: readonly (readonly string[] | 0)[]
  readonly st: readonly unknown[]
  readonly r: readonly (readonly [number | null, EntityRecord['provenance'], number | null] | 0)[]
}

/** Encode a bucket from its records' entries and rows (the rows give a stub its stub). */
export function encodeBucket(
  entries: readonly (readonly [string, RecordEntry, EntityRecord | undefined])[],
): StoredBucket {
  const out = { k: [], s: [], l: [], b: [], h: [], c: [], st: [], r: [] } as {
    [K in keyof StoredBucket]: StoredBucket[K][number][]
  }
  for (const [key, entry, row] of entries) {
    out.k.push(key)
    out.s.push(entry.seq)
    out.l.push(entry.level === 'main' ? 1 : 0)
    out.b.push(entry.bytes)
    out.h.push(entry.holders.length > 0 ? [...entry.holders] : 0)
    out.c.push(entry.cw.length > 0 ? [...entry.cw] : 0)
    const stubbed = row !== undefined && stubFieldsOf(row.entity).length > 0
    if (!stubbed) {
      out.st.push(0)
      out.r.push(0)
    } else if (entry.level === 'stub') {
      out.st.push(row.value)
      out.r.push([row.revision ?? null, row.provenance, row.asOf ?? null])
    } else {
      out.st.push(stubOfValue(row.entity, row.value))
      out.r.push(0)
    }
  }
  return out
}

/** One record as a bucket row gives it back: its entry, its stub, and a stub-level row. */
export interface DecodedEntry {
  readonly key: string
  readonly entry: RecordEntry
  /** The stub columns of a whole record with a stub. */
  readonly stub?: unknown
  /** The row of a record held at stub level. */
  readonly stubRow?: EntityRecord
}

/** A bucket row's records; `undefined` when it cannot be read (the store is rebuilt). */
export function decodeBucket(value: unknown): DecodedEntry[] | undefined {
  const row = value as Partial<StoredBucket> | null
  if (row === null || typeof row !== 'object') return undefined
  const { k, s, l, b, h, c, st, r } = row
  if (!Array.isArray(k) || !Array.isArray(s) || !Array.isArray(l) || !Array.isArray(b))
    return undefined
  if (!Array.isArray(h) || !Array.isArray(c) || !Array.isArray(st) || !Array.isArray(r))
    return undefined
  const n = k.length
  if (s.length !== n || l.length !== n || b.length !== n || h.length !== n || c.length !== n)
    return undefined
  if (st.length !== n || r.length !== n) return undefined
  const out: DecodedEntry[] = []
  for (let at = 0; at < n; at += 1) {
    const key = k[at]
    const seq = s[at]
    const bytes = b[at]
    if (typeof key !== 'string' || typeof seq !== 'number' || typeof bytes !== 'number')
      return undefined
    const main = l[at] === 1
    const holders = h[at]
    const vias = c[at]
    const entry: RecordEntry = {
      seq,
      level: main ? 'main' : 'stub',
      bytes,
      holders: Array.isArray(holders) ? holders : NO_HOLDERS,
      cw: Array.isArray(vias) ? vias : NO_VIAS,
    }
    const stub = st[at]
    const fields = r[at]
    if (!main && Array.isArray(fields)) {
      const { entity, entityId } = splitRowKey(key)
      const [revision, provenance, asOf] = fields as unknown as readonly [
        number | null,
        EntityRecord['provenance'],
        number | null,
      ]
      out.push({
        key,
        entry,
        stubRow: {
          entity,
          entityId,
          value: stub,
          ...(revision === null ? {} : { revision }),
          provenance,
          part: 'stub',
          ...(asOf === null ? {} : { asOf }),
        },
      })
    } else out.push(stub === 0 ? { key, entry } : { key, entry, stub })
  }
  return out
}

/** The stored instance state a marker row carries beside the marker (`_s`). */
export const MARKER_STATE_FIELD = '_s'

/** The instance states the marker rows of one principal carry (`_s`), by instance key. */
export function decodeMarkerStates(
  rows: Iterable<{ readonly key: string; readonly value: unknown }>,
): Map<string, InstanceState> {
  const out = new Map<string, InstanceState>()
  for (const { key, value } of rows) {
    if (!key.startsWith(INSTANCE_META_PREFIX)) continue
    const marker = value as { readonly key?: unknown; readonly _s?: unknown } | null
    if (marker === null || typeof marker !== 'object' || typeof marker.key !== 'string') continue
    const state = decodeInstanceState(marker[MARKER_STATE_FIELD])
    if (state !== undefined) out.set(marker.key, state)
  }
  return out
}

/** A marker row's value with its instance state beside it. */
export function markerWithState(marker: InstanceRecord, state: InstanceState): unknown {
  return { ...marker, [MARKER_STATE_FIELD]: encodeInstanceState(state) }
}

/** A durable instance state row value. */
export interface StoredInstanceState {
  readonly a: number
  readonly s?: true
  readonly i: boolean
}

export function encodeInstanceState(state: InstanceState): StoredInstanceState {
  return { a: state.lastReadAt, ...(state.stale ? { s: true as const } : {}), i: state.indexed }
}

export function decodeInstanceState(value: unknown): InstanceState | undefined {
  const row = value as Partial<StoredInstanceState> | null
  if (row === null || typeof row !== 'object' || typeof row.a !== 'number') return undefined
  return { lastReadAt: row.a, stale: row.s === true, indexed: row.i === true }
}

// ---------------------------------------------------------------------------
// Building the index from rows (a migration, or a store without one)
// ---------------------------------------------------------------------------

/**
 * The members of every main-part marker, by its rule, over every row: what a
 * store written before the index holds. Linear in rows and markers: a keyed
 * instance finds its candidates by its key field.
 */
export function membersByRule(input: {
  readonly rows: readonly EntityRecord[]
  readonly markers: ReadonlyMap<string, InstanceRecord>
  readonly policy: CachePolicy | null
  readonly now: number
}): Map<string, string[]> {
  const args = policyArgs(input.policy)
  const byKind = new Map<string, EntityRecord[]>()
  const byKey = new Map<string, EntityRecord>()
  for (const row of input.rows) {
    if (row.part === 'stub') continue
    byKey.set(rowKeyOf(row.entity, row.entityId), row)
    const list = byKind.get(row.entity)
    if (list === undefined) byKind.set(row.entity, [row])
    else list.push(row)
  }
  const stubsByKey = new Map<string, EntityRecord>()
  for (const row of input.rows)
    if (row.part === 'stub') stubsByKey.set(rowKeyOf(row.entity, row.entityId), row)
  const store = {
    readRow: (entity: string, entityId: string): EntityRecord | undefined => {
      const key = rowKeyOf(entity, entityId)
      return byKey.get(key) ?? stubsByKey.get(key)
    },
  }
  const indexes = new Map<string, Map<unknown, EntityRecord[]>>()
  const out = new Map<string, string[]>()
  for (const [key, marker] of input.markers) {
    if (marker.part !== 'main') continue
    const instance = resolveInstance(marker, args)
    if (instance === undefined) continue
    let candidates = byKind.get(instance.of) ?? []
    const field = cachedKeyField(instance.collection)
    if (field !== undefined) {
      const indexKey = `${instance.of}${SEPARATOR}${field}`
      let index = indexes.get(indexKey)
      if (index === undefined) {
        index = new Map()
        for (const row of candidates) {
          const value = ((row.value ?? {}) as Record<string, unknown>)[field] ?? null
          const list = index.get(value)
          if (list === undefined) index.set(value, [row])
          else list.push(row)
        }
        indexes.set(indexKey, index)
      }
      const param = instanceParams(instance.collection)[0]
      candidates = index.get(param === undefined ? null : (instance.args[param] ?? null)) ?? []
    }
    // A marker whose rule cannot be read (an argument it names is missing)
    // gets no members: only the server answers it.
    try {
      const members: string[] = []
      for (const row of candidates)
        if (holds(instance, row.entity, row.value, store, input.now))
          members.push(rowKeyOf(row.entity, row.entityId))
      out.set(key, members)
    } catch {
      // no members
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The resident set at start
// ---------------------------------------------------------------------------

/** What a store offers the resident load: its disk, and putting rows in memory. */
export interface ResidentLoadPort {
  readonly index: DiskIndexReader
  readonly markers: ReadonlyMap<string, InstanceRecord>
  readonly policy: CachePolicy | null
  readonly now: number
  /** Whether a row is in memory. */
  resident(key: string): boolean
  /** Read rows from disk, in one batched read. */
  read(keys: readonly string[]): Promise<readonly EntityRecord[]>
  /** Put rows read from disk into memory. */
  install(rows: readonly EntityRecord[]): void
}

/**
 * The instances whose rows memory holds from the start (design "Layer 2",
 * always resident): the policy collections and what their records come with,
 * as instances on disk. A device with no policy holds everything it has.
 */
export function policyInstanceKeys(policy: CachePolicy | null): string[] {
  if (policy === null) return []
  const out: string[] = []
  for (const step of policy.steps)
    for (const id of step.collections) {
      const collection = COLLECTIONS.get(id)
      out.push(instanceKey({ collection: id, part: collection?.part ?? 'main' }))
    }
  return out
}

/**
 * Load instances' rows from disk into memory, with what those rows come with
 * when that is on disk too (a record's comes-with rows, its pointers), in
 * rounds of one batched read each. Returns the instances loaded and the rows
 * installed. Instances without members (`indexed: false`) are left out: only
 * the server can answer them.
 */
export async function loadInstancesFromDisk(
  port: ResidentLoadPort,
  seeds: readonly string[],
  options: {
    /** Install a round's rows; defaults to `port.install`. */
    readonly install?: (rows: readonly EntityRecord[]) => Promise<void> | void
    /** Read a resident row (to follow what it comes with). */
    readonly row?: (key: string) => EntityRecord | undefined
    readonly maxRounds?: number
  } = {},
): Promise<{ readonly loaded: string[]; readonly rows: EntityRecord[] }> {
  const install = options.install ?? ((rows) => port.install(rows))
  const index = port.index
  const loaded = [...new Set(seeds)].filter(
    (key) => port.markers.has(key) && index.instance(key)?.indexed === true,
  )
  const installed: EntityRecord[] = []
  const asked = new Set<string>()
  let next = new Set<string>()
  const want = (key: string): void => {
    if (asked.has(key)) return
    asked.add(key)
    if (index.record(key)?.level === 'main' && !port.resident(key)) next.add(key)
  }
  /** What a whole row brings, when its comes-with is complete on the device. */
  const follow = (row: EntityRecord): void => {
    const key = rowKeyOf(row.entity, row.entityId)
    const entry = index.record(key)
    if (entry === undefined || entry.cw.length === 0) return
    for (const member of index.membersOf(comesWithHolderKey(key))) want(member)
    for (const spec of comesWithOf(row.entity, row.value, [], port.now)) {
      if (spec.via === undefined || !entry.cw.includes(spec.via)) continue
      const target = pointerTargetOf(spec)
      if (target !== undefined) want(target)
    }
  }
  for (const key of loaded)
    for (const member of index.membersOf(key)) {
      if (asked.has(member)) continue
      asked.add(member)
      if (index.record(member)?.level !== 'main') continue
      if (!port.resident(member)) next.add(member)
      else {
        const row = options.row?.(member)
        if (row !== undefined) follow(row)
      }
    }
  for (let at = 0; at < (options.maxRounds ?? 16) && next.size > 0; at += 1) {
    const keys = [...next]
    next = new Set()
    const rows = await port.read(keys)
    if (rows.length > 0) await install(rows)
    installed.push(...rows)
    for (const row of rows) if (row.part !== 'stub') follow(row)
  }
  return { loaded, rows: installed }
}

// ---------------------------------------------------------------------------
// Shared adapter steps
// ---------------------------------------------------------------------------

/** Stage a mutation's comes-with changes into the index draft (after its markers). */
export function stageIndexComesWith(
  index: DiskIndexDraft,
  ops: CacheMutation['comesWith'] | undefined,
): void {
  for (const op of ops ?? []) {
    if (op.kind === 'held') index.addHolder(op.member, comesWithHolderKey(op.holder))
    else index.setComesWith(op.record, op.vias)
  }
}

/** Stage a mutation's marker changes into the index draft (after its rows). */
export function stageIndexInstances(
  index: DiskIndexDraft,
  instances: CacheMutationInstances | undefined,
): void {
  for (const op of instances ?? []) {
    switch (op.kind) {
      case 'mark':
        index.mark(op.instance, op.members, op.at)
        break
      case 'drop':
        index.drop(op.key)
        break
      case 'dropAll':
        index.dropAll()
        break
      case 'release':
        index.release(op.key, op.at)
        break
    }
  }
}

type CacheMutationInstances = NonNullable<CacheMutation['instances']>

/** The resident-set operations every adapter shares, over its mirror and index. */
export interface ResidentRows {
  hasMain(key: string): boolean
  set(key: string, row: EntityRecord): unknown
  unload(key: string): boolean
}

/**
 * Put rows read from disk into memory: only a row that is still the one on
 * disk (same feed number and level in the index) and not in memory already.
 */
export function installResidentRows(
  mirror: ResidentRows,
  index: DiskIndexReader,
  rows: readonly EntityRecord[],
): EntityRecord[] {
  const out: EntityRecord[] = []
  for (const row of rows) {
    if (row.part === 'stub') continue
    const key = rowKeyOf(row.entity, row.entityId)
    const entry = index.record(key)
    if (entry === undefined || entry.level !== 'main' || entry.seq !== rowAsOf(row)) continue
    if (mirror.hasMain(key)) continue
    mirror.set(key, row)
    out.push(row)
  }
  return out
}

/**
 * Take instances out of memory: each member nothing else in memory holds
 * leaves memory (another in-memory instance, or a resident record it comes
 * with), and so does what the rows that left bring along. Returns the rows
 * that left.
 */
export function unloadResident(
  mirror: ResidentRows,
  index: DiskIndex,
  keys: readonly string[],
): { entity: string; entityId: string }[] {
  const leaving = keys.filter((key) => index.inMemory(key))
  if (leaving.length === 0) return []
  index.setInMemory(leaving, false)
  const out: { entity: string; entityId: string }[] = []
  const seen = new Set<string>()
  const heldElsewhere = (key: string): boolean =>
    index
      .record(key)
      ?.holders.some((holder) =>
        isComesWithHolder(holder) ? mirror.hasMain(holder.slice(1)) : index.inMemory(holder),
      ) === true
  const queue: string[] = []
  const consider = (member: string): void => {
    if (seen.has(member)) return
    seen.add(member)
    if (!mirror.hasMain(member) || heldElsewhere(member)) return
    mirror.unload(member)
    out.push(splitRowKey(member))
    queue.push(member)
  }
  for (const key of leaving) for (const member of index.membersOf(key)) consider(member)
  for (let at = 0; at < queue.length; at += 1)
    for (const member of index.membersOf(comesWithHolderKey(queue[at] as string))) consider(member)
  return out
}

// ---------------------------------------------------------------------------
// The members of instances an answer completes
// ---------------------------------------------------------------------------

/**
 * The records one answer named (a fetch, a load), so the instances it marks
 * complete get their members: the named records each one's rule selects. A
 * keyed instance ("the sessions of issue X") finds its candidates by its key
 * field; the few others are tried against every named record of their type.
 * The server sends every record of an instance it answers, so an instance's
 * members are among what the answer named.
 */
export class AnswerMembers {
  private readonly named = new Set<string>()
  /** The comes-with instances (via a holder) the answer marked complete, by key. */
  readonly comesWith = new Map<string, InstanceSpec>()
  private readonly byKind = new Map<string, string[]>()
  /** `kind\0field` → field value → row keys. */
  private readonly byField = new Map<string, Map<unknown, string[]>>()

  add(entity: string, entityId: string, value: unknown): void {
    const key = rowKeyOf(entity, entityId)
    if (this.named.has(key)) return
    this.named.add(key)
    const list = this.byKind.get(entity)
    if (list === undefined) this.byKind.set(entity, [key])
    else list.push(key)
    const record = (value ?? {}) as Record<string, unknown>
    for (const [indexKey, index] of this.byField) {
      const at = indexKey.indexOf(SEPARATOR)
      if (indexKey.slice(0, at) !== entity) continue
      const field = indexKey.slice(at + 1)
      const by = record[field] ?? null
      const keys = index.get(by)
      if (keys === undefined) index.set(by, [key])
      else keys.push(key)
    }
  }

  has(key: string): boolean {
    return this.named.has(key)
  }

  /** Every record the answer named, by row key. */
  namedKeys(): IterableIterator<string> {
    return this.named.values()
  }

  /**
   * The named records the instance's rule selects, read as the device holds
   * them now; `undefined` when its rule cannot be read (an argument it names
   * is missing), so the instance gets no members and only the server answers it.
   */
  membersOf(
    marker: InstanceSpec & { readonly range?: InstanceRecord['range'] },
    args: Parameters<typeof resolveInstance>[1],
    rows: { readRow(entity: string, entityId: string): EntityRecord | undefined },
    now: number,
  ): string[] | undefined {
    try {
      return this.select(marker, args, rows, now)
    } catch {
      return undefined
    }
  }

  private select(
    marker: InstanceSpec & { readonly range?: InstanceRecord['range'] },
    args: Parameters<typeof resolveInstance>[1],
    rows: { readRow(entity: string, entityId: string): EntityRecord | undefined },
    now: number,
  ): string[] {
    const instance = resolveInstance(marker, args)
    if (instance === undefined) return []
    let candidates: readonly string[] = this.byKind.get(instance.of) ?? []
    const field = cachedKeyField(instance.collection)
    if (field !== undefined) {
      const indexKey = `${instance.of}${SEPARATOR}${field}`
      let index = this.byField.get(indexKey)
      if (index === undefined) {
        index = new Map()
        for (const key of candidates) {
          const { entity, entityId } = splitRowKey(key)
          const value = rows.readRow(entity, entityId)?.value as Record<string, unknown> | undefined
          const by = value?.[field] ?? null
          const keys = index.get(by)
          if (keys === undefined) index.set(by, [key])
          else keys.push(key)
        }
        this.byField.set(indexKey, index)
      }
      const param = instanceParams(instance.collection)[0]
      candidates = index.get(param === undefined ? null : (instance.args[param] ?? null)) ?? []
    }
    const out: string[] = []
    for (const key of candidates) {
      const { entity, entityId } = splitRowKey(key)
      const row = rows.readRow(entity, entityId)
      if (row === undefined || row.part === 'stub') continue
      if (holds(instance, entity, row.value, rows, now)) out.push(key)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// The index of a store written without one (a migration)
// ---------------------------------------------------------------------------

/** What a store built before the disk index holds, as the index records it. */
export interface BuiltIndex {
  readonly entries: Map<string, RecordEntry>
  /** The state of every marker kept (not a comes-with one). */
  readonly states: Map<string, InstanceState>
  /** The comes-with markers (via a holder): recorded on their holders now, their rows to delete. */
  readonly comesWithMarkers: readonly string[]
}

/**
 * Build the index from every row and marker of one principal: each record's
 * entry, each marker's members by its rule. The comes-with markers an older
 * build wrote (via a holder) become what they are now: their rows carry the
 * holder, and each holder whose comes-with through a via was all marked gets
 * that via. Nothing is dropped: those markers' rows go, what they said stays.
 */
export function buildIndex(input: {
  readonly rows: ReadonlyMap<string, EntityRecord>
  readonly bytes: (key: string, row: EntityRecord) => number
  readonly markers: ReadonlyMap<string, InstanceRecord>
  readonly policy: CachePolicy | null
  readonly now: number
}): BuiltIndex {
  const rows = [...input.rows.values()]
  const kept = new Map<string, InstanceRecord>()
  const comesWith = new Map<string, InstanceRecord>()
  for (const [key, marker] of input.markers)
    (marker.via === undefined ? kept : comesWith).set(key, marker)
  const holders = new Map<string, string[]>()
  const hold = (key: string, holder: string): void => {
    const list = holders.get(key)
    if (list === undefined) holders.set(key, [holder])
    else if (!list.includes(holder)) list.push(holder)
  }
  const membership = membersByRule({ rows, markers: kept, policy: input.policy, now: input.now })
  for (const [instance, keys] of membership) for (const key of keys) hold(key, instance)
  const brought = membersByRule({ rows, markers: comesWith, policy: input.policy, now: input.now })
  for (const [key, keys] of brought) {
    const holder = comesWithHolderOf(comesWith.get(key) as InstanceRecord)
    if (holder !== undefined) for (const member of keys) hold(member, comesWithHolderKey(holder))
  }
  const args = policyArgs(input.policy)
  const resolved = new Map<string, ResolvedInstance>()
  for (const [key, marker] of kept) {
    const instance = resolveInstance(marker, args)
    if (instance !== undefined) resolved.set(key, instance)
  }
  const entries = new Map<string, RecordEntry>()
  for (const [key, row] of input.rows) {
    const main = row.part !== 'stub'
    const cw: string[] = []
    if (main && comesWith.size > 0) {
      const memberOf = (holders.get(key) ?? [])
        .map((holder) => resolved.get(holder))
        .filter((instance): instance is ResolvedInstance => instance !== undefined)
      const done = new Map<string, boolean>()
      for (const spec of comesWithOf(row.entity, row.value, memberOf, input.now)) {
        const via = spec.via as string
        const target = pointerTargetOf(spec)
        const ok =
          comesWith.has(instanceKey(spec)) ||
          (target !== undefined &&
            input.rows.get(target)?.part === undefined &&
            input.rows.has(target))
        done.set(via, (done.get(via) ?? true) && ok)
      }
      for (const [via, ok] of done) if (ok) cw.push(via)
    }
    entries.set(key, {
      seq: rowAsOf(row),
      level: main ? 'main' : 'stub',
      bytes: input.bytes(key, row),
      holders: main ? (holders.get(key) ?? []) : [],
      cw,
    })
  }
  const states = new Map<string, InstanceState>()
  for (const [key, marker] of kept)
    states.set(key, { lastReadAt: marker.releasedAt ?? input.now, stale: false, indexed: true })
  return { entries, states, comesWithMarkers: [...comesWith.keys()] }
}
