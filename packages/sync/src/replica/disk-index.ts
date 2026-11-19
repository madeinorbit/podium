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
 * ON DISK the index is BUCKET rows, each the entries of the records whose key
 * hashes to it, read at start with one getAll; an instance's state rides in
 * its marker row, which the open reads anyway. A bucket holds about
 * `BUCKET_RECORDS` records (POD-7160): the count of buckets starts at 256 and
 * doubles as the disk grows, every bucket rewritten once when it does, so a
 * feed change rewrites a bucket of bounded size whatever the disk holds. A
 * bucket's rows are encoded once and patched by the records that change.
 *
 * THE JOURNAL (POD-7160). A commit does not rewrite the buckets its records
 * land in (a frame of 100 changes touches about 100 of them): it writes ONE
 * journal row with the entries it changed. The open reads the journal rows
 * with the same getAll and applies them over the buckets, in order. Past
 * `JOURNAL_FOLD_ROWS` rows, or on an idle tick, a commit folds the journal:
 * it writes the buckets the journaled records land in and deletes the journal
 * rows, in one transaction.
 *
 * A dropped instance's key is left in its members' holders rather than
 * rewriting every one of them: an instance's members are a superset of what
 * its rule selects, never fewer, and a reader evaluates the rule over the rows
 * anyway.
 */

import { COLLECTIONS, instanceParams, recordOf } from '@podium/model'
import { INSTANCE_META_PREFIX, instanceKey, rowAfter } from './cache-state'
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
import type { CacheMutation, CacheOperation } from './ports'
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

/** The fewest index buckets on disk (design "The index on disk is bucketed"). */
export const INDEX_BUCKETS = 256
/** POD-7160 — about this many records per bucket: past it, the count of buckets doubles. */
export const BUCKET_RECORDS = 64
/** POD-7160 — past this many journal rows, the next commit folds the journal into its buckets. */
export const JOURNAL_FOLD_ROWS = 64
/** The key of a journal row, in commit order. */
export const indexJournalKey = (seq: number): string => `j${seq.toString().padStart(12, '0')}`
/** Whether an index row of a principal is a journal row (not a bucket). */
export const isJournalKey = (key: string): boolean => key.startsWith('j')

/** The count of buckets an index of `records` records keeps, never fewer than `from`. */
export function bucketCountFor(records: number, from = INDEX_BUCKETS): number {
  let count = Math.max(INDEX_BUCKETS, from)
  while (records > count * BUCKET_RECORDS) count *= 2
  return count
}
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

/**
 * POD-7160 — how many record keys were hashed to a bucket (`bucketOf`), for
 * the test that a commit hashes each changed key at most once (POD-7170
 * found 2 million hashes, 1.0 s, in one first-download commit).
 */
export const INDEX_HASHES = { count: 0 }

/** The bucket a record key lands in among `count` buckets (FNV-1a). */
export function bucketOf(key: string, count = INDEX_BUCKETS): number {
  INDEX_HASHES.count += 1
  let hash = 0x811c9dc5
  for (let at = 0; at < key.length; at += 1) {
    hash ^= key.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % count
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
  /** POD-7160 — how many buckets the disk keeps its index in. */
  readonly bucketCount: number
  record(key: string): RecordEntry | undefined
  records(): IterableIterator<[string, RecordEntry]>
  /** The member row keys of a main-part instance (empty for an unknown one). */
  membersOf(instanceKey: string): ReadonlySet<string>
  instance(instanceKey: string): InstanceState | undefined
  /** POD-7162 — every instance on disk (each has a marker). */
  instanceKeys(): IterableIterator<string>
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
  /** POD-7160 — how many buckets the disk keeps (`bucketCountFor`). */
  private count = INDEX_BUCKETS
  /** The record keys of each disk bucket (a commit rewrites the buckets it touched). */
  private buckets: Set<string>[] = Array.from({ length: INDEX_BUCKETS }, () => new Set())
  /**
   * POD-7160 — buckets as last written this session, so the next write patches
   * the records that changed instead of encoding the whole bucket again. Only
   * buckets written since the open (the start heap does not hold them all),
   * the oldest dropped past `ENCODED_BUCKETS`.
   */
  private readonly encoded = new Map<number, StoredBucket>()
  /** POD-7160 — the journal rows on disk, and the records they hold (with their bucket). */
  private readonly journalRows = new Set<string>()
  private journalSeq = 0
  private readonly journaled = new Map<string, number>()
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

  /** How many buckets the disk keeps. */
  get bucketCount(): number {
    return this.count
  }

  /** The bucket a record key lands in on this disk. */
  bucketOf(key: string): number {
    return bucketOf(key, this.count)
  }

  /** The journal rows on disk (their keys). */
  journalKeys(): ReadonlySet<string> {
    return this.journalRows
  }

  /** The next journal row's number. */
  get nextJournal(): number {
    return this.journalSeq
  }

  /** The records the journal holds, each with its bucket. */
  journalRecords(): ReadonlyMap<string, number> {
    return this.journaled
  }

  /** A journal row read at open: its records are the journal's until a fold. */
  noteJournalRow(key: string, records: Iterable<string>): void {
    this.journalRows.add(key)
    const seq = Number(key.slice(1))
    if (Number.isSafeInteger(seq) && seq >= this.journalSeq) this.journalSeq = seq + 1
    for (const record of records) this.journaled.set(record, bucketOf(record, this.count))
  }

  /** Forget a record (a journal row read at open removed it). */
  dropRecord(key: string): void {
    this.setRecord(key, null)
  }

  /** A bucket as this session last wrote it; `undefined` when it has not, or was re-bucketed. */
  encodedBucket(bucket: number): StoredBucket | undefined {
    return this.encoded.get(bucket)
  }

  /** The count of buckets on disk (at open, from its rows; after a re-bucket). */
  setBucketCount(count: number): void {
    if (count === this.count) return
    this.count = count
    this.buckets = Array.from({ length: count }, () => new Set<string>())
    for (const key of this.entries.keys()) this.buckets[bucketOf(key, count)]?.add(key)
    this.encoded.clear()
    for (const key of this.journaled.keys()) this.journaled.set(key, bucketOf(key, count))
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
    this.setBucketCount(INDEX_BUCKETS)
    this.encoded.clear()
    this.journalRows.clear()
    this.journaled.clear()
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
    // POD-7160: a re-bucket places every record once, after the changes;
    // otherwise each changed record keeps the bucket the draft hashed it to.
    const count = draft.bucketCountAfter()
    const rebucket = count !== this.count
    for (const [key, entry] of draft.recordChanges)
      this.setRecord(
        key,
        entry,
        rebucket ? null : (draft.hashed.get(key) ?? bucketOf(key, this.count)),
      )
    for (const [key, state] of draft.instanceChanges) {
      if (state === null) {
        this.states.delete(key)
        this.memory.delete(key)
      } else this.states.set(key, state)
    }
    for (const key of draft.markedInMemory) if (this.states.has(key)) this.memory.add(key)
    // POD-7160: the count of buckets the draft wrote, and the buckets it encoded.
    if (draft.cleared) this.encoded.clear()
    this.setBucketCount(count)
    // The journal: a full write or a fold ends it; a journal row extends it.
    const write = draft.indexWrite
    if (draft.cleared || rebucket || write?.kind === 'fold') {
      this.journalRows.clear()
      this.journaled.clear()
    }
    if (write?.kind === 'journal') {
      this.journalRows.add(write.key)
      this.journalSeq += 1
      for (const key of write.records)
        this.journaled.set(key, draft.hashed.get(key) ?? bucketOf(key, this.count))
    }
    for (const [bucket, stored] of draft.encoded) {
      this.encoded.delete(bucket)
      this.encoded.set(bucket, stored)
    }
    while (this.encoded.size > ENCODED_BUCKETS) {
      const oldest = this.encoded.keys().next().value as number
      this.encoded.delete(oldest)
    }
    this.changes += 1
  }

  /** `bucket`: where the key lands (`null`: a re-bucket places it after). */
  private setRecord(
    key: string,
    entry: RecordEntry | null,
    bucket: number | null = bucketOf(key, this.count),
  ): void {
    const before = this.entries.get(key)
    if (before !== undefined) {
      this.totalBytes -= before.bytes
      for (const holder of before.holders)
        if (entry === null || !entry.holders.includes(holder)) this.members.get(holder)?.delete(key)
    }
    if (entry === null) {
      this.entries.delete(key)
      if (bucket !== null) this.buckets[bucket]?.delete(key)
      return
    }
    if (before === undefined && bucket !== null) this.buckets[bucket]?.add(key)
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
  /** POD-7160 — the buckets an adapter encoded for this draft, kept by the index at publish. */
  readonly encoded = new Map<number, StoredBucket>()
  /** POD-7160 — the bucket each changed record was hashed to (`indexChanges`), reused at publish. */
  readonly hashed = new Map<string, number>()
  /** POD-7160 — how an adapter wrote this draft's index (`planIndexWrite`). */
  indexWrite:
    | { readonly kind: 'journal'; readonly key: string; readonly records: readonly string[] }
    | { readonly kind: 'fold' }
    | { readonly kind: 'buckets' }
    | undefined
  private countAfter: number | undefined

  constructor(private readonly base: DiskIndex) {}

  /** The index this draft changes. */
  get index(): DiskIndex {
    return this.base
  }

  /**
   * POD-7160 — how many buckets the disk keeps after this draft: as before,
   * doubled while the records it leaves are more than `BUCKET_RECORDS` each.
   * Decided once, when an adapter first asks (its writes are staged by then).
   */
  bucketCountAfter(): number {
    if (this.countAfter !== undefined) return this.countAfter
    let records = this.cleared ? 0 : this.base.recordCount
    for (const [key, entry] of this.recordChanges) {
      const had = !this.cleared && this.base.record(key) !== undefined
      if (entry === null && had) records -= 1
      else if (entry !== null && !had) records += 1
    }
    this.countAfter = bucketCountFor(records, this.cleared ? INDEX_BUCKETS : this.base.bucketCount)
    return this.countAfter
  }

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

  /**
   * A row was written (`row`) or deleted (`null`). `holders` replaces every
   * holder it had when given, the records it comes with among them (POD-7160:
   * the feed decides them, `retainedComesWith`).
   */
  row(key: string, row: EntityRecord | null, holders?: readonly string[], bytes?: number): void {
    if (row === null) {
      if (this.record(key) === undefined && !this.recordChanges.has(key)) return
      this.putRecord(key, null)
      return
    }
    const before = this.record(key)
    const level = row.part === 'stub' ? 'stub' : 'main'
    const kept =
      level === 'stub'
        ? NO_HOLDERS
        : holders === undefined
          ? (before?.holders ?? NO_HOLDERS)
          : holders
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

  /** POD-7160 — the instance is behind the feed (a gap): it keeps its rows and members. */
  stale(key: string): void {
    const before = this.instance(key)
    if (before === undefined || before.stale) return
    const state = { ...before, stale: true }
    this.instanceChanges.set(key, state)
    this.writes.push({ kind: 'instance', key, state })
  }

  /**
   * POD-7162 — the instance is being pruned: a disk load cannot answer it any
   * more, and the members in `kept` (something else keeps them) are not its
   * members any more.
   */
  pruning(key: string, kept: readonly string[]): void {
    const before = this.instance(key)
    if (before === undefined) return
    if (before.indexed) {
      const state = { ...before, indexed: false }
      this.instanceChanges.set(key, state)
      this.writes.push({ kind: 'instance', key, state })
    }
    for (const member of kept) {
      const entry = this.record(member)
      if (entry === undefined || !entry.holders.includes(key)) continue
      this.putRecord(member, {
        ...entry,
        holders: this.base.holderList(entry.holders.filter((holder) => holder !== key)),
      })
    }
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
  /**
   * POD-7160 — the count of buckets grew: every bucket row of the principal
   * goes first, and every bucket is written again (`buckets` names them all).
   */
  readonly rebucket: boolean
  /** How many buckets the disk keeps after the draft. */
  readonly bucketCount: number
  /** The disk buckets whose records changed: each is written in its final state. */
  readonly buckets: ReadonlySet<number>
  /** The records that changed in each bucket (after a re-bucket: every record of it). */
  readonly changed: ReadonlyMap<number, readonly string[]>
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
  const bucketCount = draft.bucketCountAfter()
  const rebucket = bucketCount !== (draft.cleared ? INDEX_BUCKETS : draft.index.bucketCount)
  const changed = new Map<number, string[]>()
  // Each key hashed once: the draft's changes are one entry per key.
  const add = (key: string): void => {
    const bucket = bucketOf(key, bucketCount)
    if (!rebucket) draft.hashed.set(key, bucket)
    const list = changed.get(bucket)
    if (list === undefined) changed.set(bucket, [key])
    else list.push(key)
  }
  if (!rebucket) for (const key of draft.recordChanges.keys()) add(key)
  const instances = new Map<string, InstanceState | null>()
  let clearInstances = false
  for (let i = at; i < draft.writes.length; i += 1) {
    const write = draft.writes[i] as IndexWrite
    if (write.kind === 'record') continue
    if (write.kind === 'instance') instances.set(write.key, write.state)
    else if (write.kind === 'clearInstances') {
      clearInstances = true
      instances.clear()
    }
  }
  // A re-bucket writes every bucket, from every record the draft leaves.
  if (rebucket) for (const key of draft.recordKeys()) add(key)
  return {
    clearAll,
    rebucket,
    bucketCount,
    buckets: new Set(changed.keys()),
    changed,
    instances,
    clearInstances,
  }
}

/** The record keys a bucket holds after a draft, in no particular order. */
export function bucketKeysAfter(draft: DiskIndexDraft, base: DiskIndex, bucket: number): string[] {
  const out: string[] = []
  if (!draft.cleared)
    for (const key of base.bucketKeys(bucket)) if (draft.record(key) !== undefined) out.push(key)
  for (const [key, entry] of draft.recordChanges)
    if (
      entry !== null &&
      base.bucketOf(key) === bucket &&
      (draft.cleared || base.record(key) === undefined)
    )
      out.push(key)
  return out
}

/** POD-7160 — at most this many encoded buckets kept between writes. */
const ENCODED_BUCKETS = 1024

/**
 * POD-7160 — one bucket's row after a draft, or `undefined` when the bucket
 * is empty (its row goes). A bucket this session wrote before is patched: only
 * the records that changed are encoded (`row` gives each one's row, for its
 * stub). Any other is encoded whole. The result is kept on the draft, and by
 * the index once the draft publishes.
 */
export function encodeBucketAfter(
  draft: DiskIndexDraft,
  changes: IndexChanges,
  bucket: number,
  row: (key: string, entry: RecordEntry) => EntityRecord | undefined,
  /** The records that changed in the bucket since it was written (a fold: the journal's too). */
  changed: readonly string[] = changes.changed.get(bucket) ?? [],
): StoredBucket | undefined {
  const base = draft.index
  const count = changes.bucketCount
  const cached =
    changes.clearAll || changes.rebucket || draft.cleared ? undefined : base.encodedBucket(bucket)
  let stored: StoredBucket
  if (cached !== undefined) {
    const at = new Map<string, number>()
    for (let position = 0; position < cached.k.length; position += 1)
      at.set(cached.k[position] as string, position)
    const out = copyColumns(cached)
    const gone = new Set<number>()
    for (const key of changed) {
      const entry = draft.record(key)
      const position = at.get(key)
      if (entry === undefined) {
        if (position !== undefined) gone.add(position)
        continue
      }
      const columns = entryColumns(key, entry, row(key, entry))
      if (position === undefined) pushColumns(out, columns)
      else setColumns(out, position, columns)
    }
    stored = { ...(gone.size === 0 ? out : withoutPositions(out, gone)), n: count }
  } else {
    // The bucket's records after the draft, with no key hashed again: those
    // it held that stay, and the changed ones that are new to it.
    const kept: string[] = []
    if (!changes.rebucket && !draft.cleared)
      for (const key of base.bucketKeys(bucket)) if (draft.record(key) !== undefined) kept.push(key)
    const fresh = changed.filter(
      (key) =>
        draft.record(key) !== undefined &&
        (changes.rebucket || draft.cleared || base.record(key) === undefined),
    )
    const keys = kept.length === 0 ? fresh : [...kept, ...fresh]
    stored = encodeBucket(
      keys.map((key) => {
        const entry = draft.record(key) as RecordEntry
        return [key, entry, row(key, entry)] as const
      }),
      count,
    )
  }
  if (stored.k.length === 0) {
    draft.encoded.delete(bucket)
    return undefined
  }
  draft.encoded.set(bucket, stored)
  return stored
}

/** A stored journal row: the entries a commit changed, and the records it removed. */
export interface StoredJournal extends StoredBucket {
  readonly d?: readonly string[]
}

/** What an adapter writes for a draft's index records: rows to put and rows to delete. */
export interface IndexRowWrites {
  /** Every index row of the principal goes first (a clear, a re-bucket). */
  readonly deleteAll: boolean
  readonly puts: readonly (readonly [string, StoredBucket | StoredJournal])[]
  readonly deletes: readonly string[]
}

/**
 * POD-7160 — the index rows a draft writes, for every adapter. A clear or a
 * re-bucket writes every bucket. Otherwise one journal row holds the records
 * it changed, unless the journal is full or `fold` asks (an idle tick): then
 * the buckets of every journaled and changed record are written and the
 * journal rows deleted, in the same transaction.
 */
export function planIndexWrite(
  draft: DiskIndexDraft,
  changes: IndexChanges,
  row: (key: string, entry: RecordEntry) => EntityRecord | undefined,
  fold = false,
): IndexRowWrites {
  const base = draft.index
  const puts: (readonly [string, StoredBucket | StoredJournal])[] = []
  const deletes: string[] = []
  const bucketRows = (changed: ReadonlyMap<number, readonly string[]>): void => {
    for (const [bucket, keys] of changed) {
      const stored = encodeBucketAfter(draft, changes, bucket, row, keys)
      if (stored === undefined) deletes.push(indexBucketKey(bucket))
      else puts.push([indexBucketKey(bucket), stored])
    }
  }
  if (changes.clearAll || changes.rebucket || draft.cleared) {
    bucketRows(changes.changed)
    draft.indexWrite = { kind: 'buckets' }
    return { deleteAll: true, puts, deletes }
  }
  const journal = base.journalKeys()
  if (!fold && journal.size < JOURNAL_FOLD_ROWS) {
    if (changes.changed.size === 0) return { deleteAll: false, puts, deletes }
    const out = emptyColumns()
    const removed: string[] = []
    const records: string[] = []
    for (const keys of changes.changed.values())
      for (const key of keys) {
        records.push(key)
        const entry = draft.record(key)
        if (entry === undefined) removed.push(key)
        else pushColumns(out, entryColumns(key, entry, row(key, entry)))
      }
    const key = indexJournalKey(base.nextJournal)
    draft.indexWrite = { kind: 'journal', key, records }
    puts.push([key, removed.length === 0 ? out : { ...out, d: removed }])
    return { deleteAll: false, puts, deletes }
  }
  // The fold: every journaled record's bucket, and this commit's.
  if (journal.size === 0 && changes.changed.size === 0) return { deleteAll: false, puts, deletes }
  const changed = new Map<number, string[]>()
  for (const [bucket, keys] of changes.changed) changed.set(bucket, [...keys])
  for (const [key, bucket] of base.journalRecords()) {
    const list = changed.get(bucket)
    if (list === undefined) changed.set(bucket, [key])
    else if (!list.includes(key)) list.push(key)
  }
  bucketRows(changed)
  deletes.push(...journal)
  draft.indexWrite = { kind: 'fold' }
  return { deleteAll: false, puts, deletes }
}

/**
 * A journal row's records, as the open applies them over the buckets: the
 * entries it wrote, and the records it removed. `undefined` when it cannot
 * be read (the store is rebuilt).
 */
export function decodeJournal(
  value: unknown,
): { readonly entries: DecodedEntry[]; readonly removed: readonly string[] } | undefined {
  const entries = decodeBucket(value)
  if (entries === undefined) return undefined
  const d = (value as { readonly d?: unknown }).d
  if (d !== undefined && (!Array.isArray(d) || d.some((key) => typeof key !== 'string')))
    return undefined
  return { entries, removed: (d as readonly string[] | undefined) ?? [] }
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
  /** POD-7160 — how many buckets the disk kept when this one was written (absent: 256). */
  readonly n?: number
}

/** The count of buckets a stored bucket row was written among. */
export function storedBucketCount(value: unknown): number {
  const n = (value as { readonly n?: unknown } | null)?.n
  return typeof n === 'number' && Number.isInteger(n) && n >= INDEX_BUCKETS ? n : INDEX_BUCKETS
}

type Columns = { -readonly [K in Exclude<keyof StoredBucket, 'n'>]: StoredBucket[K][number][] }
type EntryColumns = { readonly [K in keyof Columns]: Columns[K][number] }
const COLUMNS = ['k', 's', 'l', 'b', 'h', 'c', 'st', 'r'] as const

/** One record's cells in a bucket row's columns. */
function entryColumns(
  key: string,
  entry: RecordEntry,
  row: EntityRecord | undefined,
): EntryColumns {
  const stubbed = row !== undefined && stubFieldsOf(row.entity).length > 0
  return {
    k: key,
    s: entry.seq,
    l: entry.level === 'main' ? 1 : 0,
    b: entry.bytes,
    h: entry.holders.length > 0 ? [...entry.holders] : 0,
    c: entry.cw.length > 0 ? [...entry.cw] : 0,
    st: !stubbed ? 0 : entry.level === 'stub' ? row.value : stubOfValue(row.entity, row.value),
    r:
      stubbed && entry.level === 'stub'
        ? [row.revision ?? null, row.provenance, row.asOf ?? null]
        : 0,
  }
}

const emptyColumns = (): Columns => ({ k: [], s: [], l: [], b: [], h: [], c: [], st: [], r: [] })

const columnsOf = (out: Columns): Record<(typeof COLUMNS)[number], unknown[]> =>
  out as unknown as Record<(typeof COLUMNS)[number], unknown[]>

function copyColumns(from: StoredBucket): Columns {
  const out = emptyColumns()
  for (const name of COLUMNS) columnsOf(out)[name] = [...from[name]]
  return out
}

function pushColumns(out: Columns, cells: EntryColumns): void {
  for (const name of COLUMNS) columnsOf(out)[name].push(cells[name])
}

function setColumns(out: Columns, at: number, cells: EntryColumns): void {
  for (const name of COLUMNS) columnsOf(out)[name][at] = cells[name]
}

function withoutPositions(from: Columns, gone: ReadonlySet<number>): Columns {
  const out = emptyColumns()
  for (const name of COLUMNS)
    columnsOf(out)[name] = columnsOf(from)[name].filter((_, at) => !gone.has(at))
  return out
}

/**
 * Encode a bucket from its records' entries and rows (the rows give a stub
 * its stub), written among `count` buckets.
 */
export function encodeBucket(
  entries: readonly (readonly [string, RecordEntry, EntityRecord | undefined])[],
  count = INDEX_BUCKETS,
): StoredBucket {
  const out = emptyColumns()
  for (const [key, entry, row] of entries) pushColumns(out, entryColumns(key, entry, row))
  return { ...out, n: count }
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
      case 'stale':
        index.stale(op.key)
        break
      case 'pruning':
        index.pruning(op.key, op.kept ?? [])
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
// The feed to records only on disk (POD-7160)
// ---------------------------------------------------------------------------

/**
 * The row a record whole on disk and not in memory is, for "newest wins":
 * its feed number from the index, no value. `undefined` for a record the
 * index holds no whole row of (a stub is always in memory).
 */
export function heldRowOf(key: string, entry: RecordEntry | undefined): EntityRecord | undefined {
  if (entry === undefined || entry.level !== 'main') return undefined
  const { entity, entityId } = splitRowKey(key)
  return { entity, entityId, value: undefined, provenance: { seq: entry.seq }, asOf: entry.seq }
}

/** What memory is told of the rows a draft writes to disk only. */
export interface DiskOnlyMirror {
  hasMain(key: string): boolean
  set(key: string, row: EntityRecord): unknown
  putStubOf(entity: string, entityId: string, value: unknown): void
}

/**
 * POD-7160 — the rows one draft writes to disk and not to memory (a feed
 * change to a record only instances on disk hold). At publish a row memory
 * holds by then (a disk load put it there meanwhile) is replaced in memory
 * too; the others leave their stub columns current, so counts and trees
 * read the new stub.
 */
export class DiskOnlyWrites {
  private readonly rows = new Map<string, EntityRecord>()

  get size(): number {
    return this.rows.size
  }

  get(key: string): EntityRecord | undefined {
    return this.rows.get(key)
  }

  set(key: string, row: EntityRecord): void {
    this.rows.delete(key)
    this.rows.set(key, row)
  }

  delete(key: string): void {
    this.rows.delete(key)
  }

  publish(mirror: DiskOnlyMirror): void {
    for (const [key, row] of this.rows) {
      if (mirror.hasMain(key)) mirror.set(key, row)
      else mirror.putStubOf(row.entity, row.entityId, row.value)
    }
  }
}

/**
 * One operation of a mutation against a row, as every adapter applies it:
 * "newest wins" against the row as the draft leaves it, in memory or only on
 * disk (the index's feed number: no disk read). Returns the row to write and
 * whether memory takes it (`memory: false` — written to disk only, kept in
 * `diskOnly`), `null` to delete it, or `undefined` when it is skipped.
 */
export function stageRow(
  key: string,
  op: CacheOperation,
  resident: EntityRecord | undefined,
  diskOnly: DiskOnlyWrites,
  index: DiskIndexDraft,
): { readonly row: EntityRecord | null; readonly memory: boolean } | undefined {
  const written = diskOnly.get(key)
  const held =
    op.asOf === undefined ? undefined : (written ?? resident ?? heldRowOf(key, index.record(key)))
  const row = rowAfter(held, op)
  if (row === undefined) return undefined
  if (row === null) {
    diskOnly.delete(key)
    return { row: null, memory: true }
  }
  const toDisk =
    op.kind === 'upsert' &&
    op.diskOnly === true &&
    row.part !== 'stub' &&
    (resident === undefined || resident.part === 'stub')
  if (toDisk) diskOnly.set(key, row)
  else diskOnly.delete(key)
  return { row, memory: !toDisk }
}

/**
 * The records a changed row stays brought by (POD-7160, "leaving an
 * instance"): of the holders it had (`^` + row key), those its new value
 * still names by a keyed comes-with field. A holder whose comes-with through
 * that via is complete keeps it only when its rule still selects the row
 * (`brought`, `comesWithHolders`); one not complete yet keeps it while the
 * field names it.
 */
export function retainedComesWith(
  kind: string,
  value: unknown,
  before: readonly string[],
  brought: readonly string[],
  index: DiskIndexReader,
): string[] {
  const out = [...brought]
  if (before.length === 0) return out
  const record = (value ?? {}) as Readonly<Record<string, unknown>>
  for (const holder of before) {
    if (!isComesWithHolder(holder) || out.includes(holder)) continue
    const holderKey = holder.slice(COMES_WITH_HOLDER.length)
    let named = false
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
        if (comesWithHolderOf(spec) !== holderKey) continue
        // Complete through this via: the rule decided it (`brought`).
        if (index.record(holderKey)?.cw.includes(via) !== true) named = true
      }
    }
    if (named) out.push(holder)
  }
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
