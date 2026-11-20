/**
 * THE WEB REPLICA STORAGE ADAPTER — transactional IndexedDB (ADR 6 D1, D3, D4).
 *
 * ADR 6 D1 names transactional IndexedDB as the durable engine for web replica
 * entities, cursor, outbox and overlay, and D2 records that OPFS is NOT adopted
 * and must not be re-opened inside this issue. This adapter is that decision as
 * code: three object stores in ONE IndexedDB database (`./schema.ts`), one native
 * transaction spanning all of them, and no localStorage on any path including
 * degraded (D4.4.4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CENTRAL CONSTRAINT: THE KERNEL PORT IS SYNCHRONOUS AND IndexedDB IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ReplicaCacheStore.readCursor()`, `.readEntities()` and `.read()` return values,
 * not promises, and `.applyAtomic()` returns `void`. `SyncSpanParticipant.publish`
 * "MUST NOT await" — and `span.ts` says why in terms of this very technology: an
 * IndexedDB transaction auto-closes on an unrelated await. So the adapter cannot
 * read through to IndexedDB at call time, and it does not try to:
 *
 *   HYDRATE ONCE, MIRROR IN MEMORY, COMMIT THROUGH A NATIVE TRANSACTION.
 *
 *   - `open()` reads every row of every region into an in-memory MIRROR. From then
 *     on the mirror answers every synchronous read.
 *   - A write STAGES into a span-private draft (memory) plus a list of IndexedDB
 *     operations. Nothing touches the mirror yet.
 *   - Commit opens ONE native transaction over all three object stores, issues the
 *     staged operations into it, and awaits `oncomplete`.
 *   - The mirror is swapped in — and `onCommit` adoptions run — STRICTLY AFTER
 *     that completion. This is the ordering `span.ts` requires ("adoptions run in
 *     registration order AFTER the span's durable commit") and it is the reason a
 *     quota abort cannot leave an observation that outran its own durability.
 *
 * The mirror is therefore never ahead of durable truth while the store is
 * `durable`. When it deliberately IS ahead — after a quota denial — the mode says
 * so (`degraded-memory`) and the degradation is surfaced, which is D4.4 exactly.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CRASH IS, AND WHY THE TESTS DROP THE OBJECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Because reads are served from a mirror, a "crash" that keeps this object alive
 * proves nothing: it re-reads the very memory the crash was supposed to destroy.
 * That is the fixture-certifying-itself shape POD-306 found. So `crash.test.ts`
 * kills by DISCARDING the store and calling `open()` again over the same
 * `IdbFactoryLike` — the mirror dies, IndexedDB survives, and every assertion is
 * about what actually committed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRECONDITIONS ARE RE-CHECKED INSIDE THE NATIVE TRANSACTION (ADR 6 D4.6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OutboxStoreMutation.expect` is checked twice: once against the mirror when the
 * mutation is staged (so `apply` can return `{ok: false, conflicts}` to a caller
 * that can still re-stage), and once with `get` requests issued INSIDE the commit
 * transaction, against the durable rows. The second check is the one that binds
 * across browser tabs — two tabs are two connections with two mirrors, and only
 * the durable read can see the other's committed work. A conflict there raises
 * `SyncCommitConflict` and aborts the whole span.
 */

import type { MutationId } from '@podium/model'
import type {
  OutboxApplyResult,
  OutboxRecordExpectation,
  OutboxStoreMutation,
  OutboxStorePort,
} from '../../outbox/ports'
import type { OutboxRecord } from '../../outbox/records'
import {
  type CacheMeta,
  CURSOR_META_KEY,
  cursorTriple,
  decodeCacheMeta,
  EMPTY_CACHE_META,
  INSTANCE_META_END,
  INSTANCE_META_PREFIX,
  instanceMetaKey,
  isMainRow,
  type MetaWrite,
  nextCacheMeta,
  type ScopedCacheCursor,
} from '../../replica/cache-state'
import {
  approxBytes,
  bucketCountFor,
  bucketOf,
  buildIndex,
  type DecodedEntry,
  DiskIndex,
  DiskIndexDraft,
  type DiskIndexReader,
  DiskOnlyWrites,
  decodeBucket,
  decodeJournal,
  decodeMarkerStates,
  encodeBucket,
  heldByNothing,
  INDEX_BUCKETS,
  INDEX_BUILT_META_KEY,
  indexBucketKey,
  indexChanges,
  installResidentRows,
  isJournalKey,
  loadInstancesFromDisk,
  markerWithState,
  planIndexWrite,
  policyInstanceKeys,
  type RecordEntry,
  splitRowKey,
  stageIndexComesWith,
  stageIndexInstances,
  stageRow,
  storedBucketCount,
  unloadResident,
} from '../../replica/disk-index'
import type {
  CacheMutation,
  OwnedSyncSpan,
  ReplicaCacheStore,
  SnapshotVersions,
  SyncSpan,
  SyncSpanParticipant,
  SyncUnitOfWork,
} from '../../replica/ports'
import { ReplicaStoreCorruptError } from '../../replica/ports'
import { RowMirror } from '../../replica/row-mirror'
import type { StubTableReader } from '../../replica/stub-table'
import type {
  CachePolicy,
  Cursor,
  EntityRecord,
  InstanceRecord,
  KindTokens,
} from '../../replica/types'
import { SyncCommitConflict } from '../../span'
import { ChangedKeyDraft } from '../changed-key-draft'
import {
  EMPTY_SCRUB_REPORT,
  mergeScrubReports,
  planSecretScrub,
  type SecretScrubReport,
} from '../secret-scrub'
import {
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbKeyRangeLike,
  type IdbTransactionLike,
  isQuotaError,
  requestAsPromise,
} from './idb'
import {
  ALL_STORES,
  ENTITY_STORE,
  INDEX_STORE,
  META_STORE,
  OUTBOX_STORE,
  REPLICA_DB_NAME,
  REPLICA_SCHEMA_VERSION,
  type StoredEntity,
  type StoredIndexRow,
  type StoredMeta,
  type StoredOutboxRecord,
  upgradeSchema,
} from './schema'
import { enqueueWrites } from './write-batch'

const rowKey = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

/**
 * The format of the disk index this build writes; a store without it is rebuilt from its rows.
 * 2 (POD-7186): every entry carries its pointer edges.
 */
const INDEX_FORMAT = 2
/** POD-7160 — a quiet tick after the last journal row, then the journal folds into its buckets. */
const INDEX_FOLD_IDLE_MS = 2_000
/** The principal of store-wide metadata rows (no principal's view reads it). */
const STORE_PRINCIPAL = ''
/** The upper bound of every string key that starts with a given prefix. */
const KEY_END = '\uffff'

export type DurabilityMode = 'durable' | 'degraded-memory' | 'unavailable'

/**
 * ADR 6 D4.4 clause 3 — "the UI is EXPLICITLY informed: offline guarantees are
 * suspended; reload may cold-start".
 *
 * A callback and not a log line, and REQUIRED at construction for the same reason
 * `OutboxConfig.onStoreUnreadable` is: making the one silent-degradation path a
 * mandatory parameter is how "explicitly surfaced" becomes a compile-time
 * obligation instead of something an integrator means to wire up later.
 */
export interface DurabilityDegradation {
  readonly mode: Exclude<DurabilityMode, 'durable'>
  /** `quota` is D4.4; `corrupt` is D4.5; `unavailable` is "no IndexedDB here at all". */
  readonly cause: 'quota' | 'corrupt' | 'unavailable'
  readonly error: unknown
}

/** Bound a hung `indexedDB.open` so Safari's ~60s lock cannot freeze the UI. */
export const IDB_OPEN_TIMEOUT_MS = 8_000

export class IndexedDbOpenTimeoutError extends Error {
  override readonly name = 'IndexedDbOpenTimeoutError'
  constructor(timeoutMs: number) {
    super(`IndexedDB open timed out after ${timeoutMs}ms`)
  }
}

/** Reopening a closed connection failed; unlike corruption, this must never clear the DB. */
export class IndexedDbReconnectError extends Error {
  override readonly name = 'IndexedDbReconnectError'
  constructor(cause: unknown) {
    super('Could not reopen the closed IndexedDB connection', { cause })
  }
}

export interface IndexedDbStoreOptions {
  /** Optional cache retention policy. Defaults to keeping every entity kind.
   * Excluded kinds are ignored on ingest and retired from older disk caches;
   * cursor and authored outbox rows are independent of this policy. */
  readonly retainEntity?: (entity: string) => boolean
  readonly factory: IdbFactoryLike
  readonly keyRange?: IdbKeyRangeLike
  readonly databaseName?: string
  /**
   * How long `indexedDB.open` may sit before the adapter degrades to memory.
   * Safari can hold a blocked open for ~60s after an unclean close; that is
   * a frozen UI, not a durable wait. Default {@link IDB_OPEN_TIMEOUT_MS}.
   * Tests inject a short value so a hung factory cannot stall the suite.
   */
  readonly openTimeoutMs?: number
  /** Diagnostic only, after a version-change transaction has committed. */
  readonly onSchemaUpgrade?: (event: {
    readonly from: number
    readonly to: number
    readonly cachePrincipalsReset: number
  }) => void
  /** POD-7184 — how much one group commit writes; default {@link GROUP_COMMIT_BOUNDS}. Tests pass small ones. */
  readonly groupCommitBounds?: GroupCommitBounds
  /** REQUIRED — see {@link DurabilityDegradation}. */
  readonly onDegraded: (degradation: DurabilityDegradation) => void
  /**
   * Called after every open with what the secret scrub found (POD-419).
   *
   * OPTIONAL, and deliberately not the mechanism anything depends on: the
   * property is enforced by the pass itself, and `audit-client-secrets.ts`
   * verifies it by inspecting the RUNNING store rather than by trusting a
   * callback a composition root might not wire. This exists so an instance can
   * SAY that it removed material it should never have held.
   */
  readonly onSecretsScrubbed?: (report: SecretScrubReport) => void
}

/** One staged IndexedDB operation, issued into the commit transaction verbatim and IN ORDER. */
type IdbOp =
  | { readonly kind: 'put'; readonly store: string; readonly value: unknown }
  | { readonly kind: 'delete'; readonly store: string; readonly key: unknown }

/** The post-state one span has staged, per region, plus the durable operations that produce it. */
interface SpanDraft {
  /** Principal → changed keys or snapshot replacement. Absent means untouched. */
  readonly entities: Map<string, ChangedKeyDraft<EntityRecord, RowMirror>>
  /** Principal → the cursor, markers, policy and load state this draft leaves. */
  readonly metas: Map<string, CacheMeta>
  /** Principal → the disk index changes this draft makes (POD-7159). */
  readonly indexes: Map<string, DiskIndexDraft>
  /** Principal → the rows this draft writes to disk and not to memory (POD-7160). */
  readonly diskOnly: Map<string, DiskOnlyWrites>
  /** POD-7160 — principals whose index journal this draft folds into its buckets (an idle tick). */
  readonly foldIndex: Set<string>
  /** The index's durable rows were added to `ops` (once, at commit). */
  indexWritten: boolean
  readonly outbox: Map<string, StoredOutboxRecord[]>
  readonly ops: IdbOp[]
  /** Re-checked inside the native transaction against durable rows (D4.6). */
  readonly expectations: { principal: string; expectation: OutboxRecordExpectation }[]
  /** The cache generation each principal's writes were planned against. */
  readonly cacheGenerations: Map<string, string | undefined>
  touchedCache: boolean
  touchedOutbox: boolean
}

/**
 * The two regions whose commits are ordered independently (POD-4810): the
 * replica's (entities and cursor, which always move together) and the outbox's.
 */
type CommitLane = 'cache' | 'outbox'
const COMMIT_LANES: readonly CommitLane[] = ['cache', 'outbox']

/**
 * The object stores a draft's native transaction must span: every store it
 * writes, plus the outbox when it carries preconditions (they are re-checked
 * against durable outbox rows INSIDE that transaction). In `ALL_STORES` order.
 */
function scopeOf(draft: SpanDraft): string[] {
  const touched = new Set<string>(draft.ops.map((op) => op.store))
  if (draft.expectations.length > 0) touched.add(OUTBOX_STORE)
  if (draft.cacheGenerations.size > 0) touched.add(META_STORE)
  return ALL_STORES.filter((store) => touched.has(store))
}

/** The commit queues a draft joins — see `IndexedDbSyncStore.enqueueCommit`. */
function lanesOf(draft: SpanDraft): readonly CommitLane[] {
  const scope = scopeOf(draft)
  const lanes: CommitLane[] = []
  if (scope.includes(ENTITY_STORE) || scope.includes(META_STORE) || scope.includes(INDEX_STORE))
    lanes.push('cache')
  if (scope.includes(OUTBOX_STORE)) lanes.push('outbox')
  return lanes.length === 0 ? COMMIT_LANES : lanes
}

/** POD-7170 — eager cache drafts written as one transaction (`joinCacheGroup`). */
interface CacheGroup {
  readonly drafts: SpanDraft[]
  run: Promise<void>
  /** POD-7184 — the requests and estimated bytes of its drafts, before the merge. */
  ops: number
  bytes: number
}

/**
 * POD-7184 — the most one group commit writes: drafts queued behind a running
 * commit join its group only while the group stays within both. A draft larger
 * than either is a group of its own (a draft is all-or-nothing).
 */
export interface GroupCommitBounds {
  readonly ops: number
  readonly bytes: number
}

export const GROUP_COMMIT_BOUNDS: GroupCommitBounds = { ops: 16_384, bytes: 16 * 1024 * 1024 }

/**
 * About the bytes a value takes once IndexedDB has serialized it: string
 * characters, 8 per number, the bytes of a binary view, plus a little per
 * property. An estimate for a bound, not a measurement.
 */
function estimateBytes(root: unknown): number {
  let bytes = 0
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    switch (typeof value) {
      case 'string':
        bytes += value.length + 2
        continue
      case 'number':
      case 'bigint':
        bytes += 8
        continue
      case 'object':
        break
      default:
        bytes += 1
        continue
    }
    if (value === null) {
      bytes += 1
      continue
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength + 8
      continue
    }
    if (Array.isArray(value)) {
      bytes += 4
      for (const item of value) stack.push(item)
      continue
    }
    bytes += 4
    for (const key in value as Record<string, unknown>) {
      bytes += key.length + 2
      stack.push((value as Record<string, unknown>)[key])
    }
  }
  return bytes
}

/** The estimated bytes of a draft's operations (a delete costs its key). */
function draftBytes(draft: SpanDraft): number {
  let bytes = 0
  for (const op of draft.ops) bytes += op.kind === 'put' ? estimateBytes(op.value) : 32
  return bytes
}

/** A draft that may join a group: an eager write of the cache region alone, with no precondition. */
function groupable(draft: SpanDraft, lanes: readonly CommitLane[]): boolean {
  return (
    lanes.length === 1 &&
    lanes[0] === 'cache' &&
    draft.ops.length > 0 &&
    draft.expectations.length === 0
  )
}

/**
 * The store and key one operation writes, or `undefined` for a range delete
 * (never left out, never lets an earlier operation be left out).
 */
function opIdentity(op: IdbOp): string | undefined {
  if (op.kind === 'delete')
    return Array.isArray(op.key) ? JSON.stringify([op.store, ...op.key]) : undefined
  const value = op.value as Record<string, unknown>
  if (op.store === ENTITY_STORE)
    return JSON.stringify([op.store, value['principal'], value['entity'], value['entityId']])
  if (op.store === OUTBOX_STORE)
    return JSON.stringify([op.store, value['principal'], value['mutationId']])
  return JSON.stringify([op.store, value['principal'], value['key']])
}

/**
 * The drafts' operations in order, without those a later operation on the same
 * store and key replaces: what they leave is what the drafts one after another
 * leave (a range delete stays where it is, and the operations around it keep
 * their order).
 */
function mergeDrafts(drafts: readonly SpanDraft[]): SpanDraft {
  if (drafts.length === 1) return drafts[0] as SpanDraft
  const merged = newDraft()
  const later = new Set<string>()
  const kept: IdbOp[] = []
  for (let d = drafts.length - 1; d >= 0; d -= 1) {
    const draft = drafts[d] as SpanDraft
    merged.touchedCache ||= draft.touchedCache
    // The first draft's expectation is what the grouped transaction starts at.
    for (const [principal, generation] of draft.cacheGenerations)
      merged.cacheGenerations.set(principal, generation)
    for (let i = draft.ops.length - 1; i >= 0; i -= 1) {
      const op = draft.ops[i] as IdbOp
      const identity = opIdentity(op)
      if (identity !== undefined) {
        if (later.has(identity)) continue
        later.add(identity)
      }
      kept.push(op)
    }
  }
  for (let i = kept.length - 1; i >= 0; i -= 1) merged.ops.push(kept[i] as IdbOp)
  return merged
}

const newDraft = (): SpanDraft => ({
  entities: new Map(),
  metas: new Map(),
  indexes: new Map(),
  diskOnly: new Map(),
  foldIndex: new Set(),
  indexWritten: false,
  outbox: new Map(),
  ops: [],
  expectations: [],
  cacheGenerations: new Map(),
  touchedCache: false,
  touchedOutbox: false,
})

/**
 * The span this adapter hands out.
 *
 * `commit()` is synchronous because `OwnedSyncSpan` is, and it cannot be otherwise:
 * every hook on that port is synchronous by requirement, not by simplification.
 * What it does is run the veto phase and ENQUEUE the durable commit on the store's
 * serial write queue; `durable` is the promise that settles when IndexedDB has
 * either committed or refused. `SyncUnitOfWork.transact` awaits it. A caller that
 * opens a span through `ReplicaCacheStore.beginSpan()` must await
 * `IndexedDbSyncStore.settled()` before believing anything is durable — which is
 * why nothing in this package opens one that way.
 *
 * `eager` splits the ONE case where the mirror cannot wait for durability: the
 * cache port's `void` methods. See `autocommitEager`.
 */
class IdbSpan implements OwnedSyncSpan {
  private readonly participants: SyncSpanParticipant[] = []
  private readonly adoptions: (() => void)[] = []
  private state: 'open' | 'discarded' | 'published' = 'open'
  /** Resolves when the durable commit has settled. Rejects with what IndexedDB said. */
  durable: Promise<void> = Promise.resolve()

  constructor(private readonly settle: (span: IdbSpan) => Promise<void>) {}

  join(participant: SyncSpanParticipant): void {
    if (this.state !== 'open') throw new Error('cannot join a span that has already settled')
    if (!this.participants.includes(participant)) this.participants.push(participant)
  }

  onCommit(adopt: () => void): void {
    if (this.state !== 'open') throw new Error('cannot enrol in a span that has already settled')
    this.adoptions.push(adopt)
  }

  commit(): void {
    if (this.state !== 'open') throw new Error('span already settled')
    this.state = 'published'
    this.durable = this.settle(this)
  }

  abort(): void {
    if (this.state === 'discarded') return
    if (this.state === 'published') throw new Error('cannot abort a span that already published')
    this.discardAll()
  }

  /** Run every participant's veto. Throwing here aborts the whole span. */
  runPrepare(): void {
    for (const participant of this.participants) participant.prepare?.()
  }

  /** Called only after IndexedDB reported the transaction complete. */
  publishAll(): void {
    for (const participant of this.participants) participant.publish()
    // Strictly after durability: an observation that outran its own commit would be
    // a lie no later hook could retract.
    for (const adopt of this.adoptions) adopt()
  }

  discardAll(): void {
    this.state = 'discarded'
    for (const participant of this.participants) participant.discard?.()
    this.adoptions.length = 0
  }
}

/**
 * One physical IndexedDB store, handing out one pair of ports per principal.
 *
 * Construct with `IndexedDbSyncStore.open(...)`; the constructor is private
 * because a store whose mirror has not been hydrated would answer every read with
 * an empty slice, and an empty slice is indistinguishable from a cold client.
 */
class CacheGenerationConflict extends Error {}

export class IndexedDbSyncStore {
  private cacheConflict = false
  private mode: DurabilityMode = 'durable'
  /** Flipped by the corruption injector and by a hydrate that could not decode. */
  private corrupt = false
  // POD-7115: a stub is kept only in its record type's stub table.
  // POD-7159: the resident set, not a copy of the disk.
  private readonly entities = new Map<string, RowMirror>()
  private readonly metas = new Map<string, CacheMeta>()
  /** POD-7159: per principal, the disk index (always in memory). */
  private readonly indexes = new Map<string, DiskIndex>()
  private readonly outboxRows = new Map<string, StoredOutboxRecord[]>()
  private readonly views = new Map<string, IndexedDbStoreView>()
  private nextOrdinal = 0
  /** What a rebuild of the index scrubbed, reported with the open's scrub. */
  private rebuildScrub: SecretScrubReport = EMPTY_SCRUB_REPORT
  /**
   * Serializes durable commits PER REGION — see `enqueueCommit`. Two transactions
   * over the same region interleaving is the one race D10 forbids; two over
   * disjoint regions cannot interleave anything, and making the outbox wait for
   * the replica's is what stalled a user's send behind a cold sync (POD-4810).
   */
  private readonly laneTails: Record<CommitLane, Promise<unknown>> = {
    cache: Promise.resolve(),
    outbox: Promise.resolve(),
  }
  /** POD-7170: the group of eager cache drafts waiting for the cache region's queue. */
  private cacheGroup: CacheGroup | null = null
  /** Spans opened by `unitOfWork.transact`, so `cacheWrites` can exclude them. */
  private readonly transactSpans = new WeakSet<IdbSpan>()
  /** Spans whose mirror publishes before durability — see `autocommitEager`. */
  private readonly eagerSpans = new WeakSet<IdbSpan>()

  private reopening: Promise<void> | undefined
  private closeRequested = false
  /** beginSpan's void commit reports failures through its documented settled() boundary. */
  private readonly manualCommits: Promise<void>[] = []

  transactCount = 0
  outboxCommits = 0
  cacheCommits = 0

  private constructor(
    private db: IdbDatabaseLike,
    private readonly options: IndexedDbStoreOptions,
  ) {}

  /**
   * Open, migrate and hydrate.
   *
   * D4.5 — a store that cannot be opened or decoded is CLEARED and the client cold
   * starts. Boot never wedges and nothing throws past this boundary: a poisoned
   * store that threw here would take the whole app down, which is strictly worse
   * than re-bootstrapping from the Authority.
   */
  static async open(options: IndexedDbStoreOptions): Promise<IndexedDbSyncStore> {
    const name = options.databaseName ?? REPLICA_DB_NAME
    let db: IdbDatabaseLike
    try {
      db = await openDatabase(options.factory, name, options.openTimeoutMs, options)
    } catch (error) {
      // A timeout is not corruption. Deleting the replica because Safari held
      // the lock would throw away a recoverable store and force a world-sized
      // bootstrap onto the same UI thread the timeout was meant to protect.
      if (error instanceof IndexedDbOpenTimeoutError) {
        const store = new IndexedDbSyncStore(unavailableDatabase(), options)
        store.degrade('unavailable', 'unavailable', error)
        return store
      }
      // Includes `VersionError` — a store written by a NEWER build than this one.
      // D5.1 is forward-only, so the only honest move is to drop it and cold start.
      await deleteDatabase(options.factory, name)
      try {
        db = await openDatabase(options.factory, name, options.openTimeoutMs, options)
      } catch (fatal) {
        const store = new IndexedDbSyncStore(unavailableDatabase(), options)
        store.degrade('unavailable', 'unavailable', fatal)
        return store
      }
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error })
    }
    const store = new IndexedDbSyncStore(db, options)
    try {
      await store.hydrate()
      // POD-419: material written by an EARLIER build is removed before this
      // store answers its first read. After hydrate, so the pass sees the same
      // rows every later read is served from; inside `open`, so no caller can
      // observe an unscrubbed store. It is not gated on the schema version —
      // see `../secret-scrub.ts` for why a one-shot arm is the wrong shape for a
      // property that can be violated again.
      await store.scrubSecrets()
    } catch (error) {
      // Decode failure or unreadable region: clear the whole replica DB and proceed
      // as a cold client (D4.5). The outbox is lost with it, which is why this path
      // is LOUD rather than silent.
      if (error instanceof IndexedDbReconnectError) {
        store.degrade('unavailable', 'unavailable', error)
        return store
      }
      try {
        await store.clearAll()
      } catch (fatal) {
        store.degrade('unavailable', 'unavailable', fatal)
        return store
      }
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error })
      store.mode = 'durable'
    }
    return store
  }

  /** ADR 6 D4 — surfaced, never silent. */
  durability(): DurabilityMode {
    if (this.corrupt) return 'unavailable'
    return this.mode
  }

  /** One principal's pair of ports over this one physical store (ADR 6 D4.1). */
  viewFor(principal: string): IndexedDbStoreView {
    const existing = this.views.get(principal)
    if (existing !== undefined) return existing
    const view = new IndexedDbStoreView(this, principal)
    this.views.set(principal, view)
    return view
  }

  /**
   * Erase one principal's complete durable namespace.
   *
   * Sign-out and stale-namespace retention are different from D7 cache healing:
   * authored outbox rows belong to the signed-out principal too, so this is the
   * one lifecycle operation that intentionally spans entities, cursor AND
   * outbox. The three regions are deleted in one native transaction; a crash
   * leaves either the full old namespace or none of it.
   */
  async erasePrincipal(principal: string): Promise<void> {
    this.guardReadable()
    await this.unitOfWork.transact(async (span) => {
      const draft = this.draftFor(span)
      this.stageDeleteEveryRow(draft, principal)
      draft.entities.set(principal, new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror()))
      this.stageMetaReset(draft, principal)
      draft.touchedCache = true

      for (const row of this.outboxOf(principal)) {
        draft.ops.push({
          kind: 'delete',
          store: OUTBOX_STORE,
          key: [principal, row.mutationId],
        })
      }
      draft.outbox.set(principal, [])
      draft.touchedOutbox = true
    })
    this.views.delete(principal)
  }

  /**
   * ADR 2 D10's unit of work over one native IndexedDB transaction.
   *
   * The body does LOCAL STORAGE WORK ONLY and the transaction is not opened until
   * it has returned — deliberately. An IndexedDB transaction auto-closes when its
   * request queue drains at the end of a task, so a transaction opened around an
   * awaiting body would be closed by the first `await` and every subsequent write
   * would land in no transaction at all, reporting success and committing
   * separately. Staging first and opening the transaction once, at the end, is the
   * only shape that makes "one transaction for the whole logical commit" true on
   * this technology.
   */
  readonly unitOfWork: SyncUnitOfWork = {
    transact: async <T>(body: (span: SyncSpan) => Promise<T>): Promise<T> => {
      this.transactCount += 1
      const span = this.beginOwnSpan()
      this.transactSpans.add(span)
      let result: T
      try {
        result = await body(span)
      } catch (error) {
        span.abort()
        this.releaseDraft(span)
        throw error
      }
      span.commit()
      await span.durable
      return result
    },
    // The lane tails never reject: a failed commit reports through its own
    // caller, never through this wait. Nothing is appended to a lane.
    durable: async (): Promise<void> => {
      await Promise.all(COMMIT_LANES.map((lane) => this.laneTails[lane]))
    },
  }

  /**
   * Everything enqueued so far has settled. Async ports report their own errors;
   * a beginSpan() commit has no async port, so its failure is reported here.
   */
  async settled(): Promise<void> {
    const manual = this.manualCommits.splice(0)
    await Promise.all([...COMMIT_LANES.map((lane) => this.laneTails[lane]), ...manual])
  }

  /**
   * Re-read every region from IndexedDB, replacing the mirror.
   *
   * This is the COLD-START read, and exposing it is what lets a recovery in a test
   * be a real one. It refuses while the store is degraded (the mirror is
   * deliberately ahead of durable truth there, and re-reading would silently
   * discard the user's work) and waits for the write queue first, so it can never
   * roll the mirror back past an autocommit still in flight.
   */
  async rehydrate(): Promise<void> {
    if (this.durability() !== 'durable') return
    await this.settled()
    if (this.durability() !== 'durable') return
    await this.hydrate()
  }

  async refreshAfterCacheConflict(): Promise<boolean> {
    if (!this.cacheConflict || this.durability() !== 'durable') return false
    await this.laneTails.cache
    if (!this.cacheConflict || this.durability() !== 'durable') return false
    this.cacheConflict = false
    try {
      await this.hydrate(false)
      return true
    } catch (error) {
      this.cacheConflict = true
      throw error
    }
  }

  expectCacheGeneration(draft: SpanDraft, principal: string): void {
    if (!draft.cacheGenerations.has(principal))
      draft.cacheGenerations.set(principal, this.metaOf(principal).cursor?.cacheGeneration)
  }

  /**
   * Re-read the OUTBOX region alone from IndexedDB, replacing that part of the
   * mirror — the fresh-truth read `OutboxStorePort.read()` needs (POD-4810).
   *
   * The kernel Outbox calls `read()` before EVERY state change, to rebase on what
   * another writer may have committed. It used to be `rehydrate()`, which waited
   * for every queued replica commit and then re-read every entity row: after a
   * cold sync that was a whole replica's worth of structured-clone per state
   * change, and a send is several state changes. The outbox never returned an
   * entity row, so it now reads only its own object store, waits only for its
   * own region's commits, and does so in a transaction whose scope excludes the
   * replica's stores — which is what lets IndexedDB run it beside a replica
   * transaction instead of queueing it behind one.
   *
   * Refuses while degraded for the same reason `rehydrate` does, and waits for
   * the outbox lane for the same reason `rehydrate` waits for all of them: the
   * mirror must never roll back past an outbox commit still in flight.
   */
  async rehydrateOutbox(): Promise<void> {
    if (this.durability() !== 'durable') return
    await this.laneTails.outbox
    if (this.durability() !== 'durable') return
    const tx = await this.transaction([OUTBOX_STORE], 'readonly')
    const outbox = (await requestAsPromise(
      tx.objectStore(OUTBOX_STORE).getAll(),
    )) as StoredOutboxRecord[]
    this.adoptOutboxRows(outbox)
  }

  /** Test/injector seam: ADR 6 D4.5 / ADR 2 D7 rung 5 — the store cannot be read. */
  setCorrupt(corrupt: boolean): void {
    this.corrupt = corrupt
  }

  close(): void {
    this.closeRequested = true
    if (this.foldTimer !== undefined) clearTimeout(this.foldTimer)
    this.db.close()
  }

  /**
   * Recover ONLY a refused transaction open: no request has been issued, so the
   * draft and its durable preconditions are still safe to try on a fresh handle.
   * Never call `open()` here: its cold-start corruption policy may delete the DB,
   * and rehydrating would replace the mirror beneath pending/eager drafts.
   *
   * Cache and outbox lanes share a reopen, but keep their own transactions. After
   * explicit teardown, late work uses a one-transaction connection and closes it
   * immediately: close() lets that transaction finish without leaking a handle.
   * The await ends BEFORE any requests are issued; it never keeps a live native
   * transaction waiting on unrelated work.
   */
  private async transaction(
    names: string[],
    mode: 'readonly' | 'readwrite',
  ): Promise<IdbTransactionLike> {
    if (!this.closeRequested) {
      try {
        return this.db.transaction(names, mode)
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== 'InvalidStateError') throw error
      }
      if (this.reopening === undefined) {
        this.db.close()
        this.reopening = this.reopenDatabase()
          .then((db) => {
            this.db = db
            if (this.closeRequested) db.close()
          })
          .finally(() => {
            this.reopening = undefined
          })
      }
      await this.reopening
      if (!this.closeRequested) return this.recoveredTransaction(this.db, names, mode)
    }
    const db = await this.reopenDatabase()
    try {
      return this.recoveredTransaction(db, names, mode)
    } finally {
      db.close()
    }
  }

  private recoveredTransaction(
    db: IdbDatabaseLike,
    names: string[],
    mode: 'readonly' | 'readwrite',
  ): IdbTransactionLike {
    try {
      return db.transaction(names, mode)
    } catch (error) {
      // Bound the retry. A second close is unavailable storage, never corruption:
      // open() must not route this refusal into its destructive clearAll policy.
      if ((error as { name?: unknown } | null)?.name === 'InvalidStateError') {
        throw new IndexedDbReconnectError(error)
      }
      throw error
    }
  }

  private async reopenDatabase(): Promise<IdbDatabaseLike> {
    try {
      return await openDatabase(
        this.options.factory,
        this.options.databaseName ?? REPLICA_DB_NAME,
        this.options.openTimeoutMs,
        this.options,
      )
    } catch (error) {
      throw new IndexedDbReconnectError(error)
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private beginOwnSpan(): IdbSpan {
    // Keep the queue's rejection observer: an async/await wrapper would create
    // a second rejected promise, requiring a separate observer on every path.
    return new IdbSpan((span) => this.enqueueCommit(span))
  }

  /** `ReplicaCacheStore.beginSpan()`'s implementation — see the note on `IdbSpan`. */
  beginSpan(): OwnedSyncSpan {
    return new IdbSpan((span) => {
      const commit = this.enqueueCommit(span)
      this.manualCommits.push(commit)
      return commit
    })
  }

  private readonly drafts = new Map<IdbSpan, SpanDraft>()

  draftFor(span: SyncSpan): SpanDraft {
    const owned = span as IdbSpan
    const existing = this.drafts.get(owned)
    if (existing !== undefined) return existing
    const draft = newDraft()
    this.drafts.set(owned, draft)
    span.join({
      // The veto phase. Nothing here may await; the durable re-check that DOES
      // need IndexedDB happens inside the transaction, in `commitDraft`.
      prepare: () => {
        if (this.corrupt) throw new ReplicaStoreCorruptError()
      },
      publish: () => {
        this.applyDraftToMirror(draft)
        this.drafts.delete(owned)
      },
      discard: () => {
        this.drafts.delete(owned)
      },
    })
    return draft
  }

  private releaseDraft(span: IdbSpan): void {
    this.drafts.delete(span)
  }

  /**
   * Stage a lone operation and commit it in its own transaction (D10 clause 2),
   * publishing the mirror only after IndexedDB confirmed it.
   *
   * For the ASYNC ports — `OutboxStorePort.apply` — this is the whole story: the
   * caller awaits the promise, so a `local-ack` cannot outrun its own durability.
   */
  autocommit(stage: (draft: SpanDraft, span: SyncSpan) => void): Promise<void> {
    const span = this.beginOwnSpan()
    const draft = this.draftFor(span)
    stage(draft, span)
    span.commit()
    return span.durable
  }

  /**
   * The same, for a port method that returns `void` and therefore has nowhere to
   * put a promise: `applyAtomic`, `installSnapshot` and `discardCache` without a
   * span.
   *
   * THE MIRROR IS PUBLISHED SYNCHRONOUSLY HERE, and that asymmetry is forced
   * rather than chosen. `ReplicaCacheStore.applyAtomic` returns `void`, so the
   * Replica considers the write done when the call returns and reads the row back
   * on the next line — `Replica.settled()` covers the kernel's own work, and there
   * is no hook through which it could also await this adapter's IndexedDB
   * transaction. Deferring the swap to durability made fifteen conformance cases
   * read an empty slice.
   *
   * What is lost is bounded and is NOT the D4.1 invariant. The native transaction
   * is still one transaction, so the durable side is all-or-nothing: a crash in
   * the window leaves PRE, never a torn mix. What can happen is that the mirror is
   * briefly ahead of durable truth for a SINGLE-REGION write — and if that write
   * then fails, the store degrades to `degraded-memory` and says so (D4.4) rather
   * than rolling the mirror back, because a rollback would have to undo a write
   * later ones have already been staged on top of.
   *
   * The multi-region path — every commit where atomicity across entities, cursor
   * and outbox is the point — does NOT take this shortcut: `unitOfWork.transact`
   * publishes strictly after durability, which is what `crash.test.ts` asserts at
   * every boundary.
   */
  autocommitEager(stage: (draft: SpanDraft, span: SyncSpan) => void): void {
    const span = this.beginOwnSpan()
    const draft = this.draftFor(span)
    stage(draft, span)
    this.eagerSpans.add(span)
    span.commit()
    void span.durable.catch(() => undefined)
  }

  /**
   * Push the durable half of a span onto the serial queue of every REGION it
   * writes.
   *
   * Serial and not concurrent within a region: IndexedDB will happily run two
   * `readwrite` transactions over the same stores and resolve them in either
   * order, and D10's "independent calls are serialized" is what stops a later
   * commit from publishing its mirror swap before an earlier one.
   *
   * Per region and not store-wide (POD-4810). The replica region (entities and
   * cursor) and the outbox region share no row and no mirror map, so ordering a
   * commit of one behind a commit of the other bought nothing — and cost a user's
   * queued write every second of a cold sync's apply. A commit that writes BOTH
   * regions (a retirement enrolled with the frame that confirms it, a sign-out
   * erase) joins both queues: it waits for each region's earlier commits and
   * holds back each region's later ones, so D10's order holds exactly where the
   * regions meet. A span with no durable writes joins both, which keeps its
   * adoptions ordered after everything before it, as they always were.
   */
  private enqueueCommit(span: IdbSpan): Promise<void> {
    const eager = this.eagerSpans.has(span)
    const draftNow = this.drafts.get(span) ?? newDraft()
    // The draft is final once its span commits: its index rows join its ops.
    this.stageIndexRows(draftNow)
    const lanes = lanesOf(draftNow)
    if (eager) {
      // Published BEFORE the queue runs — see `autocommitEager` for why the cache
      // port's `void` methods cannot wait, and for what that does and does not cost.
      try {
        span.runPrepare()
      } catch (error) {
        span.discardAll()
        this.drafts.delete(span)
        return Promise.reject(error)
      }
      span.publishAll()
      if (groupable(draftNow, lanes)) return this.joinCacheGroup(draftNow)
    }
    // A commit of the cache region queued after the open group comes after it.
    if (lanes.includes('cache')) this.cacheGroup = null
    const run = Promise.all(lanes.map((lane) => this.laneTails[lane])).then(async () => {
      const draft = eager ? draftNow : (this.drafts.get(span) ?? newDraft())
      if (!eager) {
        try {
          span.runPrepare()
        } catch (error) {
          span.discardAll()
          this.drafts.delete(span)
          throw error
        }
      }
      if (draft.ops.length === 0) {
        // Nothing durable to do — a span that enrolled only in-memory adoptions.
        if (!eager) span.publishAll()
        return
      }
      if (this.durability() !== 'durable') {
        // D4.4.2 — degraded for the remainder of the session. The write applies to
        // the mirror and to NOTHING ELSE: never localStorage (D4.4.4), and never a
        // durable store that has already refused.
        if (!eager) span.publishAll()
        return
      }
      try {
        await this.commitDraft(draft)
      } catch (error) {
        if (error instanceof CacheGenerationConflict) {
          if (eager) return // The other tab owns the durable generation.
          span.discardAll()
          this.drafts.delete(span)
          throw error
        }
        if (isQuotaError(error)) this.degrade('degraded-memory', 'quota', error)
        if (eager) {
          // The mirror already published and later writes may be staged on top of
          // it, so there is nothing sound to roll back to. The durable side is
          // untouched — the native transaction aborted whole — and the session
          // continues in memory with the degradation surfaced, which is D4.4
          // exactly. Any non-quota failure here is a store that cannot be written
          // to at all, so it degrades the same way rather than silently retrying.
          this.degrade(
            'degraded-memory',
            error instanceof IndexedDbReconnectError ? 'unavailable' : 'corrupt',
            error,
          )
          throw error
        }
        // The native transaction aborted, so the durable side is byte-identical to
        // what it was. Dropping the drafts keeps the mirror there too — PRE, never
        // torn (D4.1) — and no adoption runs, so no observation escaped (D10).
        span.discardAll()
        this.drafts.delete(span)
        throw error
      }
      if (draft.touchedOutbox) this.outboxCommits += 1
      if (draft.touchedCache && !this.transactSpans.has(span)) this.cacheCommits += 1
      if (!eager) span.publishAll()
    })
    // The queue must survive a rejection, or one failed commit wedges every later
    // one behind a permanently rejected promise.
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    for (const lane of lanes) this.laneTails[lane] = tail
    return run
  }

  /**
   * POD-7170 — GROUP COMMIT of the cache port's eager writes. A draft that
   * arrives while the cache region's queue is busy joins the group waiting for
   * it, and the whole group is written as ONE native transaction when its turn
   * comes. A first download installs a chunk at a time faster than IndexedDB
   * commits them, and each commit rewrote the disk index buckets its records
   * fall in (all of them, for a large chunk): 11 commits wrote 17 MB of index
   * rows for 8 MB of records (operator size, measured). Grouped, each row and
   * each index bucket is written once per group, in its last state.
   *
   * Only eager drafts group: their mirror has published already, in queue
   * order, and nothing waits on one commit rather than another. The group's
   * operations keep their order; an operation a later one in the group
   * replaces (the same store and key) is left out, so the transaction leaves
   * exactly what the drafts one after another would have left. A group closes
   * when it starts, or when any other commit of the cache region is queued, so
   * the region's order holds. A failure degrades every draft of the group, as
   * it degrades one eager draft today.
   *
   * POD-7184 — A GROUP IS BOUNDED, in requests and in estimated bytes
   * (`GROUP_COMMIT_BOUNDS`). Unbounded, a large first download installed faster
   * than it committed became one transaction of the whole download: at 10x
   * history, 184,576 requests and about 68 MB, which Chromium refused at commit
   * with QuotaExceededError (no request failed; gigabytes of quota were free),
   * and the store degraded to memory for the session. With the requests in
   * flight bounded too (`write-batch.ts`), no transaction of a download is
   * larger than a few installs. A draft that would take the open group past a
   * bound starts the next group instead, queued behind it. Each group is still
   * a run of whole drafts in queue order, so a crash or a refusal leaves what
   * the drafts before it left: a prefix, as one transaction per draft did.
   */
  private joinCacheGroup(draft: SpanDraft): Promise<void> {
    const bounds = this.options.groupCommitBounds ?? GROUP_COMMIT_BOUNDS
    const ops = draft.ops.length
    const bytes = draftBytes(draft)
    const open = this.cacheGroup
    if (open !== null && open.ops + ops <= bounds.ops && open.bytes + bytes <= bounds.bytes) {
      open.drafts.push(draft)
      open.ops += ops
      open.bytes += bytes
      return open.run
    }
    // The open group, if any, is full: it stays queued, and this group runs after it.
    const group: CacheGroup = { drafts: [draft], run: Promise.resolve(), ops, bytes }
    this.cacheGroup = group
    group.run = this.laneTails.cache.then(async () => {
      if (this.cacheGroup === group) this.cacheGroup = null
      const merged = mergeDrafts(group.drafts)
      if (merged.ops.length === 0 || this.durability() !== 'durable') return
      try {
        await this.commitDraft(merged)
      } catch (error) {
        if (error instanceof CacheGenerationConflict) return
        if (isQuotaError(error)) this.degrade('degraded-memory', 'quota', error)
        this.degrade(
          'degraded-memory',
          error instanceof IndexedDbReconnectError ? 'unavailable' : 'corrupt',
          error,
        )
        throw error
      }
      for (const one of group.drafts) if (one.touchedCache) this.cacheCommits += 1
    })
    this.laneTails.cache = group.run.then(
      () => undefined,
      () => undefined,
    )
    return group.run
  }

  /**
   * ONE native transaction over every object store the draft writes.
   *
   * Scoped to exactly those stores, not to all three (POD-4810): IndexedDB queues
   * a `readwrite` transaction behind every earlier one whose scope OVERLAPS it, so
   * an all-stores scope made the outbox's one-row commit wait for the replica's
   * twenty-thousand-row one even with the adapter's own queues split. A draft
   * that writes both regions still gets one transaction over both — the scope is
   * narrowed only to what is written, never split.
   *
   * The precondition re-check happens HERE, inside it, against durable rows: this
   * is the version-check ADR 6 D4.6 asks for, and it is the only check that can see
   * a write committed by another tab, because another tab is another connection
   * with its own mirror.
   */
  private async commitDraft(draft: SpanDraft): Promise<void> {
    const tx = await this.transaction(scopeOf(draft), 'readwrite')
    const completion = transactionCompletion(tx)
    try {
      for (const [principal, expected] of draft.cacheGenerations) {
        const row = (await requestAsPromise(
          tx.objectStore(META_STORE).get([principal, CURSOR_META_KEY]),
        )) as StoredMeta | undefined
        const generation = (row?.value as ScopedCacheCursor | undefined)?.cacheGeneration
        if (generation !== expected) {
          this.cacheConflict = true
          throw new CacheGenerationConflict('another tab replaced the device cache generation')
        }
      }
      if (draft.expectations.length > 0) {
        const outbox = tx.objectStore(OUTBOX_STORE)
        const conflicts: string[] = []
        for (const { principal, expectation } of draft.expectations) {
          // Awaiting a request that belongs to THIS transaction keeps it alive —
          // the request queue is non-empty until the success event fires. It is an
          // unrelated await that would close it, and there is none here.
          const row = await requestAsPromise(
            outbox.get([principal, expectation.mutationId]) as {
              result: StoredOutboxRecord | undefined
              error: { name: string; message: string } | null
              onsuccess: ((this: unknown, ev: unknown) => void) | null
              onerror: ((this: unknown, ev: unknown) => void) | null
            },
          )
          const durableState =
            row === undefined ? 'absent' : (row.record as OutboxRecord | undefined)?.state
          if (durableState !== expectation.expect) conflicts.push(expectation.mutationId)
        }
        if (conflicts.length > 0) {
          tx.abort()
          await completion.catch(() => undefined)
          throw new SyncCommitConflict(conflicts)
        }
      }
      // Attach both rejection handlers before the first request event: a
      // failure earlier in a batch can abort before its last request fires.
      await Promise.all([enqueueWrites(tx, draft.ops), completion])
    } catch (error) {
      if (error instanceof SyncCommitConflict) throw error
      try {
        tx.abort()
      } catch {
        // Already aborted by the failing request; nothing to undo.
      }
      await completion.catch(() => undefined)
      throw error
    }
  }

  /** Publish a committed draft into the mirror. Runs only after IndexedDB said complete. */
  private applyDraftToMirror(draft: SpanDraft): void {
    for (const [principal, rows] of draft.entities)
      this.entities.set(principal, rows.publish(this.entitiesOf(principal)))
    for (const [principal, rows] of draft.diskOnly) rows.publish(this.entitiesOf(principal))
    for (const [principal, meta] of draft.metas) this.metas.set(principal, meta)
    for (const [principal, index] of draft.indexes) this.indexOf(principal).publish(index)
    for (const [principal, rows] of draft.outbox) this.outboxRows.set(principal, rows)
  }

  /** POD-7160 — the journal rows read at open, in commit order; `undefined` when one cannot be read. */
  private decodeJournals(
    rows: readonly { principal: string; key: string; value: unknown }[],
  ):
    | { principal: string; key: string; entries: DecodedEntry[]; removed: readonly string[] }[]
    | undefined {
    const out: {
      principal: string
      key: string
      entries: DecodedEntry[]
      removed: readonly string[]
    }[] = []
    for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      const journal = decodeJournal(row.value)
      if (journal === undefined) return undefined
      out.push({ principal: row.principal, key: row.key, ...journal })
    }
    return out
  }

  /** POD-7160 — principals whose journal waits for the idle fold. */
  private readonly foldPending = new Set<string>()
  private foldTimer: ReturnType<typeof setTimeout> | undefined

  /** POD-7160 — fold a journal once the store has been quiet for a tick (POD-7161 will own idle). */
  private scheduleIndexFold(principal: string): void {
    this.foldPending.add(principal)
    if (this.foldTimer !== undefined) clearTimeout(this.foldTimer)
    this.foldTimer = setTimeout(() => {
      this.foldTimer = undefined
      this.foldIndexJournals()
    }, INDEX_FOLD_IDLE_MS)
    ;(this.foldTimer as { unref?: () => void }).unref?.()
  }

  /**
   * POD-7160 — fold every waiting index journal into its buckets now, in one
   * transaction: the buckets its records land in are written and its rows
   * deleted. An idle tick calls it; a failure leaves the journal for the next
   * commit, which folds it once it is full.
   */
  foldIndexJournals(): void {
    const principals = [...this.foldPending].filter(
      (principal) => this.indexOf(principal).journalKeys().size > 0,
    )
    this.foldPending.clear()
    if (principals.length === 0 || this.mode !== 'durable') return
    try {
      this.autocommitEager((draft) => {
        for (const principal of principals) {
          this.expectCacheGeneration(draft, principal)
          this.indexDraft(draft, principal)
          draft.foldIndex.add(principal)
        }
        draft.touchedCache = true
      })
    } catch {
      // Left for the next commit.
    }
  }

  /**
   * POD-7159 — the durable rows of a draft's index changes, one per key, in
   * the same native transaction as the rows they describe.
   */
  private stageIndexRows(draft: SpanDraft): void {
    if (draft.indexWritten) return
    draft.indexWritten = true
    for (const [principal, index] of draft.indexes) {
      const live = this.indexOf(principal)
      const changes = indexChanges(index)
      // POD-7160: one journal row per commit; a clear or a re-bucket writes
      // every bucket again after the old rows go, a fold the journal's buckets.
      const writes = planIndexWrite(
        index,
        changes,
        (key, entry) => this.rowForIndex(draft, principal, key, entry),
        draft.foldIndex.has(principal),
      )
      if (writes.deleteAll) {
        const range = this.options.keyRange?.bound([principal, ''], [principal, KEY_END])
        if (range !== undefined) draft.ops.push({ kind: 'delete', store: INDEX_STORE, key: range })
        else {
          const keys = [...live.journalKeys()]
          for (let bucket = 0; bucket < Math.max(live.bucketCount, INDEX_BUCKETS); bucket += 1)
            keys.push(indexBucketKey(bucket))
          for (const key of keys)
            draft.ops.push({ kind: 'delete', store: INDEX_STORE, key: [principal, key] })
        }
      }
      for (const key of writes.deletes)
        draft.ops.push({ kind: 'delete', store: INDEX_STORE, key: [principal, key] })
      for (const [key, v] of writes.puts)
        draft.ops.push({
          kind: 'put',
          store: INDEX_STORE,
          value: { principal, key, v } satisfies StoredIndexRow,
        })
      if (index.indexWrite?.kind === 'journal') this.scheduleIndexFold(principal)
      // An instance's state rides in its marker row.
      if (changes.instances.size > 0) {
        const markers = (draft.metas.get(principal) ?? this.metaOf(principal)).instances
        for (const [key, state] of changes.instances) {
          const marker = markers.get(key)
          if (state === null || marker === undefined) continue
          draft.ops.push({
            kind: 'put',
            store: META_STORE,
            value: {
              principal,
              key: instanceMetaKey(key),
              value: markerWithState(marker, state),
            } satisfies StoredMeta,
          })
        }
      }
    }
  }

  /** The row an index entry describes, as the draft leaves it (its stub is stored with the entry). */
  private rowForIndex(
    draft: SpanDraft,
    principal: string,
    key: string,
    entry: RecordEntry,
  ): EntityRecord | undefined {
    const mirror = this.entitiesOf(principal)
    const written = draft.diskOnly.get(principal)?.get(key)
    if (written !== undefined) return written
    const staged = draft.entities.get(principal)
    const row = staged === undefined ? mirror.get(key) : staged.get(key, mirror)
    if (row !== undefined) return row
    const { entity, entityId } = splitRowKey(key)
    const stub = mirror.stubTable(entity)?.stubOf(entityId)
    if (stub === undefined) return undefined
    return {
      entity,
      entityId,
      value: stub,
      provenance: { seq: entry.seq },
      ...(entry.level === 'stub' ? { part: 'stub' as const } : {}),
    }
  }

  /** Stage the deletion of every row a principal has on disk (a discard, a snapshot, a sign-out). */
  stageDeleteEveryRow(draft: SpanDraft, principal: string): void {
    draft.diskOnly.delete(principal)
    const index = this.indexDraft(draft, principal)
    const keys = new Set(index.recordKeys())
    const staged = draft.entities.get(principal)
    const mirror = this.entitiesOf(principal)
    for (const row of staged === undefined ? mirror.values() : staged.values(mirror))
      keys.add(rowKey(row.entity, row.entityId))
    for (const key of keys) {
      const { entity, entityId } = splitRowKey(key)
      draft.ops.push({ kind: 'delete', store: ENTITY_STORE, key: [principal, entity, entityId] })
    }
    index.clearAll()
    draft.touchedCache = true
  }

  /** The index draft of a principal inside a span's draft. */
  indexDraft(draft: SpanDraft, principal: string): DiskIndexDraft {
    let index = draft.indexes.get(principal)
    if (index === undefined) {
      index = new DiskIndexDraft(this.indexOf(principal))
      draft.indexes.set(principal, index)
    }
    return index
  }

  indexOf(principal: string): DiskIndex {
    let index = this.indexes.get(principal)
    if (index === undefined) {
      index = new DiskIndex()
      this.indexes.set(principal, index)
    }
    return index
  }

  /** The mirror of a principal, kept (the resident set is filled in place). */
  private mirrorOf(principal: string): RowMirror {
    let mirror = this.entities.get(principal)
    if (mirror === undefined) {
      mirror = new RowMirror()
      this.entities.set(principal, mirror)
    }
    return mirror
  }

  private degrade(
    mode: Exclude<DurabilityMode, 'durable'>,
    cause: DurabilityDegradation['cause'],
    error: unknown,
  ): void {
    if (this.mode !== 'durable') return
    this.mode = mode
    this.options.onDegraded({ mode, cause, error })
  }

  /**
   * The cold-start read (POD-7159): the metadata, the outbox and the disk
   * index, whole, and NO entity row. Memory then gets the resident set: the
   * policy collections and what they come with (and every row of a device
   * without a policy), read by key in a few batched reads. A store without
   * an index (written before version 2, or seeded raw) is rebuilt from its
   * rows once, in one transaction; a crash there repeats the rebuild.
   */
  private async hydrate(includeOutbox = true): Promise<void> {
    const stores = includeOutbox
      ? [META_STORE, OUTBOX_STORE, INDEX_STORE]
      : [META_STORE, INDEX_STORE]
    const tx = await this.transaction(stores, 'readonly')
    const meta = (await requestAsPromise(tx.objectStore(META_STORE).getAll())) as StoredMeta[]
    const outbox = includeOutbox
      ? ((await requestAsPromise(tx.objectStore(OUTBOX_STORE).getAll())) as StoredOutboxRecord[])
      : undefined
    const stored = (await requestAsPromise(
      tx.objectStore(INDEX_STORE).getAll(),
    )) as StoredIndexRow[]
    const built = stored.some(
      (row) =>
        row.principal === STORE_PRINCIPAL &&
        row.key === INDEX_BUILT_META_KEY &&
        row.v === INDEX_FORMAT,
    )
    const buckets: { principal: string; entries: DecodedEntry[] }[] = []
    const counts = new Map<string, number>()
    let readable = built
    const journals: { principal: string; key: string; value: unknown }[] = []
    for (const row of stored) {
      if (row.principal === STORE_PRINCIPAL) continue
      // POD-7160: a journal row applies over the buckets, after them.
      if (isJournalKey(row.key)) {
        journals.push({ principal: row.principal, key: row.key, value: row.v })
        continue
      }
      const entries = decodeBucket(row.v)
      if (entries === undefined) readable = false
      else buckets.push({ principal: row.principal, entries })
      counts.set(row.principal, Math.max(counts.get(row.principal) ?? 0, storedBucketCount(row.v)))
    }
    const journalRows = this.decodeJournals(journals)
    if (journalRows === undefined) readable = false
    const stubsInIndex = meta.some(isStubsInIndexFlag)
    if (!readable) {
      // POD-7170: a store this build wrote keeps stub-level records in the
      // index only, so its rows cannot rebuild it: start the cache cold.
      if (outbox === undefined) throw new ReplicaStoreCorruptError()
      if (stubsInIndex) await this.clearCacheRegion(outbox)
      else await this.rebuildIndex()
      return
    }
    this.stubsInIndex = stubsInIndex
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    if (includeOutbox) {
      this.outboxRows.clear()
      this.nextOrdinal = 0
    }
    this.decodeMetas(meta)
    // POD-7160: the count of buckets the disk keeps, before its records.
    for (const [principal, count] of counts) this.indexOf(principal).setBucketCount(count)
    const excluded: { principal: string; key: string }[] = []
    for (const { principal, entries } of buckets)
      for (const { key, entry, stub, stubRow } of entries) {
        const { entity, entityId } = splitRowKey(key)
        if (!this.retainsEntity(entity)) {
          excluded.push({ principal, key })
          continue
        }
        this.indexOf(principal).putRecord(key, entry)
        const mirror = this.mirrorOf(principal)
        if (stubRow !== undefined) mirror.set(key, stubRow)
        else if (stub !== undefined) mirror.putStubOf(entity, entityId, stub)
      }
    // POD-7160: the journal rows, in commit order, over the buckets.
    for (const { principal, key, entries, removed } of journalRows ?? []) {
      const index = this.indexOf(principal)
      const mirror = this.mirrorOf(principal)
      for (const { key: record, entry, stub, stubRow } of entries) {
        const { entity, entityId } = splitRowKey(record)
        if (!this.retainsEntity(entity)) continue
        index.putRecord(record, entry)
        if (stubRow !== undefined) mirror.set(record, stubRow)
        else {
          mirror.unload(record)
          if (stub !== undefined) mirror.putStubOf(entity, entityId, stub)
        }
      }
      for (const record of removed) {
        index.dropRecord(record)
        mirror.delete(record)
      }
      index.noteJournalRow(key, [...entries.map((entry) => entry.key), ...removed])
      this.scheduleIndexFold(principal)
    }
    // Old caches remain readable: retire excluded rows before the first read.
    // Their index entries go with the next write of their bucket.
    if (excluded.length > 0) {
      const retire = await this.transaction([ENTITY_STORE], 'readwrite')
      const completion = transactionCompletion(retire)
      for (const row of excluded) {
        const { entity, entityId } = splitRowKey(row.key)
        retire.objectStore(ENTITY_STORE).delete([row.principal, entity, entityId])
      }
      await completion
    }
    for (const principal of new Set([...this.metas.keys(), ...this.indexes.keys()]))
      await this.loadResident(principal, (keys) => this.readStoredRows(principal, keys))
    if (outbox !== undefined) this.adoptOutboxRows(outbox)
  }

  /** POD-7170: the store keeps stub-level records in their index entries only (its rows hold none). */
  private stubsInIndex = false

  /** Stage, once per store, the flag that says so, with the first stub-level record written. */
  noteStubInIndex(draft: SpanDraft): void {
    if (this.stubsInIndex) return
    this.stubsInIndex = true
    draft.ops.push({
      kind: 'put',
      store: META_STORE,
      value: {
        principal: STORE_PRINCIPAL,
        key: STUBS_IN_INDEX_KEY,
        value: true,
      } satisfies StoredMeta,
    })
  }

  /**
   * POD-7170 — an unreadable index of a store whose stubs live in it: every
   * cached row, marker and index row goes, and the cache starts cold (a first
   * download). The outbox stays: the user's unsent writes are not cache.
   */
  private async clearCacheRegion(outbox: readonly StoredOutboxRecord[]): Promise<void> {
    const stores = [ENTITY_STORE, META_STORE, INDEX_STORE]
    const tx = await this.transaction(stores, 'readwrite')
    const completion = transactionCompletion(tx)
    for (const name of stores) tx.objectStore(name).clear()
    tx.objectStore(INDEX_STORE).put({
      principal: STORE_PRINCIPAL,
      key: INDEX_BUILT_META_KEY,
      v: INDEX_FORMAT,
    } satisfies StoredIndexRow)
    await completion
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    this.stubsInIndex = false
    this.adoptOutboxRows(outbox)
  }

  private decodeStates(meta: readonly StoredMeta[]): void {
    const rows = new Map<string, StoredMeta[]>()
    for (const row of meta) {
      if (row.principal === STORE_PRINCIPAL) continue
      const list = rows.get(row.principal) ?? []
      list.push(row)
      rows.set(row.principal, list)
    }
    for (const [principal, list] of rows)
      for (const [key, state] of decodeMarkerStates(list))
        this.indexOf(principal).putInstance(key, state)
  }

  private decodeMetas(meta: readonly StoredMeta[]): void {
    const metaRows = new Map<string, StoredMeta[]>()
    for (const row of meta) {
      if (row.principal === STORE_PRINCIPAL) continue
      const rows = metaRows.get(row.principal) ?? []
      rows.push(row)
      metaRows.set(row.principal, rows)
    }
    for (const [principal, rows] of metaRows) this.metas.set(principal, decodeCacheMeta(rows))
    this.decodeStates(meta)
  }

  /**
   * Fill memory with a principal's resident set from disk: every whole row
   * of a device without a policy; otherwise each whole row no instance on
   * the device holds, the policy collections and what they come with.
   * Stub-part instances are in memory with the stub table.
   */
  private async loadResident(
    principal: string,
    read: (keys: readonly string[]) => Promise<readonly EntityRecord[]>,
  ): Promise<void> {
    const mirror = this.mirrorOf(principal)
    const index = this.indexOf(principal)
    const meta = this.metaOf(principal)
    const markers = meta.instances
    for (const key of index.instanceKeys())
      if (!markers.has(key)) index.putInstance(key, NOT_INDEXED)
    for (const key of markers.keys())
      if (index.instance(key) === undefined) index.putInstance(key, NOT_INDEXED)
    const loose: string[] = []
    for (const [key, entry] of index.records())
      if (entry.level === 'main' && (meta.policy === null || heldByNothing(entry, markers, index)))
        loose.push(key)
    if (loose.length > 0) installResidentRows(mirror, index, await read(loose))
    const seeds = meta.policy === null ? [...markers.keys()] : policyInstanceKeys(meta.policy)
    const { loaded } = await loadInstancesFromDisk(
      {
        index,
        markers,
        policy: meta.policy,
        now: Date.now(),
        resident: (key) => mirror.hasMain(key),
        read,
        install: (rows) => {
          installResidentRows(mirror, index, rows)
        },
      },
      seeds,
    )
    const stubParts = [...markers.values()]
      .filter((marker) => marker.part === 'stub')
      .map((marker) => marker.key)
    index.setInMemory([...loaded, ...stubParts], true)
  }

  /**
   * The index of a store written without one (version 1, or rows seeded raw),
   * built once from every row: each record's entry, each marker's members by
   * its rule. One transaction writes it with the flag that says it exists, so
   * a crash before it commits leaves the store as it was and the next open
   * builds it again. Nothing is dropped.
   */
  private async rebuildIndex(): Promise<void> {
    const tx = await this.transaction([ENTITY_STORE, META_STORE, OUTBOX_STORE], 'readonly')
    const entities = (await requestAsPromise(
      tx.objectStore(ENTITY_STORE).getAll(),
    )) as StoredEntity[]
    const meta = (await requestAsPromise(tx.objectStore(META_STORE).getAll())) as StoredMeta[]
    const outbox = (await requestAsPromise(
      tx.objectStore(OUTBOX_STORE).getAll(),
    )) as StoredOutboxRecord[]
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    this.decodeMetas(meta)
    const now = Date.now()
    const byPrincipal = new Map<string, Map<string, EntityRecord>>()
    const excluded: StoredEntity[] = []
    for (const row of entities) {
      if (!this.retainsEntity(row.entity)) {
        excluded.push(row)
        continue
      }
      const rows = byPrincipal.get(row.principal) ?? new Map<string, EntityRecord>()
      rows.set(rowKey(row.entity, row.entityId), entityRecordOf(row))
      byPrincipal.set(row.principal, rows)
    }
    // Every row is read here once: scrub them all (POD-419), not only the resident ones.
    const scrubbed = planSecretScrub(
      [...byPrincipal].flatMap(([principal, rows]) =>
        [...rows.values()].map((record) => ({
          address: `entities[${principal}/${record.entity}/${record.entityId}]`,
          row: { principal, record },
          value: record.value,
        })),
      ),
    )
    for (const rewrite of scrubbed.rewrites) {
      const { principal, record } = rewrite.row
      byPrincipal
        .get(principal)
        ?.set(rowKey(record.entity, record.entityId), { ...record, value: rewrite.value })
    }
    this.rebuildScrub = { ...scrubbed.report, scanned: 0 }
    const indexRows: StoredIndexRow[] = []
    const markerRows: StoredMeta[] = []
    const dropMarkers: { principal: string; key: string }[] = []
    for (const principal of new Set([...byPrincipal.keys(), ...this.metas.keys()])) {
      const rows = byPrincipal.get(principal) ?? new Map<string, EntityRecord>()
      const meta = this.metaOf(principal)
      const index = this.indexOf(principal)
      const built = buildIndex({
        rows,
        bytes: (_key, row) => approxBytes(row),
        markers: meta.instances,
        policy: meta.policy,
        now,
      })
      const mirror = this.mirrorOf(principal)
      const buckets = new Map<number, (readonly [string, RecordEntry, EntityRecord])[]>()
      // POD-7160: buckets of a bounded size, as many as the records need.
      const count = bucketCountFor(built.entries.size)
      index.setBucketCount(count)
      for (const [key, entry] of built.entries) {
        const row = rows.get(key) as EntityRecord
        index.putRecord(key, entry)
        const bucket = bucketOf(key, count)
        const list = buckets.get(bucket)
        if (list === undefined) buckets.set(bucket, [[key, entry, row]])
        else list.push([key, entry, row])
        if (row.part === 'stub') mirror.set(key, row)
        else mirror.putStubOf(row.entity, row.entityId, row.value)
      }
      for (const [bucket, entries] of buckets)
        indexRows.push({ principal, key: indexBucketKey(bucket), v: encodeBucket(entries, count) })
      for (const [key, state] of built.states) {
        index.putInstance(key, state)
        const marker = meta.instances.get(key)
        if (marker !== undefined)
          markerRows.push({
            principal,
            key: instanceMetaKey(key),
            value: markerWithState(marker, state),
          })
      }
      // What a record comes with is recorded on it now, not as markers of its own.
      if (built.comesWithMarkers.length > 0) {
        const gone = new Set(built.comesWithMarkers)
        for (const key of gone) dropMarkers.push({ principal, key })
        this.metas.set(principal, {
          ...meta,
          instances: new Map([...meta.instances].filter(([key]) => !gone.has(key))),
        })
      }
    }
    try {
      const write = await this.transaction([ENTITY_STORE, META_STORE, INDEX_STORE], 'readwrite')
      const completion = transactionCompletion(write)
      try {
        const indexStore = write.objectStore(INDEX_STORE)
        // A rebuild interrupted earlier may have left part of an index: start clean.
        indexStore.clear()
        for (const row of excluded)
          write.objectStore(ENTITY_STORE).delete([row.principal, row.entity, row.entityId])
        for (const rewrite of scrubbed.rewrites) {
          const { principal, record } = rewrite.row
          write
            .objectStore(ENTITY_STORE)
            .put(entityRow(principal, { ...record, value: rewrite.value }))
        }
        for (const row of indexRows) indexStore.put(row)
        for (const row of markerRows) write.objectStore(META_STORE).put(row)
        for (const { principal, key } of dropMarkers)
          write.objectStore(META_STORE).delete([principal, instanceMetaKey(key)])
        indexStore.put({
          principal: STORE_PRINCIPAL,
          key: INDEX_BUILT_META_KEY,
          v: INDEX_FORMAT,
        } satisfies StoredIndexRow)
      } catch (error) {
        try {
          write.abort()
        } catch {
          // Already aborted by the failing request.
        }
        await completion.catch(() => undefined)
        throw error
      }
      await completion
    } catch {
      // The index could not be written (the transaction aborted whole, so the
      // store is as it was): this session keeps every row in memory, as a
      // store without an index did, and the next open builds it again.
      for (const [principal, rows] of byPrincipal) {
        installResidentRows(
          this.mirrorOf(principal),
          this.indexOf(principal),
          [...rows.values()].filter((row) => row.part !== 'stub'),
        )
        this.indexOf(principal).setInMemory(this.metaOf(principal).instances.keys(), true)
      }
      this.adoptOutboxRows(outbox)
      return
    }
    for (const [principal, rows] of byPrincipal)
      await this.loadResident(principal, async (keys) =>
        keys.flatMap((key) => {
          const row = rows.get(key)
          return row === undefined ? [] : [row]
        }),
      )
    for (const principal of this.metas.keys())
      if (!byPrincipal.has(principal)) await this.loadResident(principal, async () => [])
    this.adoptOutboxRows(outbox)
  }

  /**
   * POD-7159 — rows of one principal read from disk by key, in one readonly
   * transaction, after every commit queued so far has settled (so a row is
   * never older than the index that names it). Secret material an earlier
   * build left is removed from what is read, and from disk.
   */
  async readStoredRows(principal: string, keys: readonly string[]): Promise<EntityRecord[]> {
    if (keys.length === 0) return []
    this.guardReadable()
    await this.laneTails.cache
    if (this.durability() === 'unavailable') return []
    const tx = await this.transaction([ENTITY_STORE], 'readonly')
    const store = tx.objectStore(ENTITY_STORE)
    const found = await Promise.all(
      keys.map((key) => {
        const { entity, entityId } = splitRowKey(key)
        return requestAsPromise(store.get([principal, entity, entityId])) as Promise<
          StoredEntity | undefined
        >
      }),
    )
    const rows: EntityRecord[] = []
    for (const row of found) if (row !== undefined) rows.push(entityRecordOf(row))
    const scrub = planSecretScrub(
      rows.map((record, at) => ({
        address: `entities[${principal}/${record.entity}/${record.entityId}]`,
        row: at,
        value: record.value,
      })),
    )
    if (scrub.rewrites.length === 0) return rows
    for (const rewrite of scrub.rewrites) {
      const record = rows[rewrite.row] as EntityRecord
      rows[rewrite.row] = { ...record, value: rewrite.value }
    }
    this.autocommitEager((draft) => {
      for (const rewrite of scrub.rewrites)
        draft.ops.push({
          kind: 'put',
          store: ENTITY_STORE,
          value: entityRow(principal, rows[rewrite.row] as EntityRecord),
        })
      draft.touchedCache = true
    })
    return rows
  }

  /**
   * Replace the outbox mirror with durable rows.
   *
   * BY ORDINAL, not by key. IndexedDB hands rows back in key order, which for the
   * outbox is `mutationId` order — so hydrating without this sort would silently
   * re-order the queue on every reload and break ADR 3 D12's FIFO.
   *
   * `nextOrdinal` only ever grows here. `hydrate` zeroes it first, so a cold read
   * is unchanged; an outbox-only re-read must not hand out an ordinal a draft
   * staged before it has already taken.
   */
  private adoptOutboxRows(outbox: readonly StoredOutboxRecord[]): void {
    this.outboxRows.clear()
    for (const row of [...outbox].sort((a, b) => a.ordinal - b.ordinal)) {
      const slice = this.outboxRows.get(row.principal) ?? []
      slice.push(row)
      this.outboxRows.set(row.principal, slice)
      this.nextOrdinal = Math.max(this.nextOrdinal, row.ordinal + 1)
    }
  }

  /**
   * Remove every classified secret member from every stored row, in ONE native
   * transaction over all three object stores.
   *
   * THE MIRROR IS UPDATED ONLY AFTER THE TRANSACTION COMPLETES, which is this
   * adapter's ordering rule everywhere else and matters especially here: a
   * mirror scrubbed ahead of its durable write would make every in-process
   * assertion — including this issue's own audit, if it read through the store's
   * API — report clean while the material sat on disk. `secret-scrub.test.ts`
   * therefore drops the store and re-opens over the same factory, so it reads
   * what actually committed.
   */
  private async scrubSecrets(): Promise<void> {
    const entityRows: { principal: string; key: string; record: EntityRecord }[] = []
    for (const [principal, slice] of this.entities)
      for (const [key, record] of slice) entityRows.push({ principal, key, record })

    const entities = planSecretScrub(
      entityRows.map((row) => ({
        address: `entities[${row.principal}/${row.record.entity}/${row.record.entityId}]`,
        row,
        value: row.record.value,
      })),
    )

    const cursorRows = [...this.metas].map(([principal, meta]) => ({
      principal,
      value: meta.cursor,
    }))
    const cursors = planSecretScrub(
      cursorRows.map((row) => ({
        address: `meta[${row.principal}/${CURSOR_META_KEY}]`,
        row,
        value: row.value,
      })),
    )

    const outboxRows: { principal: string; index: number; stored: StoredOutboxRecord }[] = []
    for (const [principal, slice] of this.outboxRows)
      slice.forEach((stored, index) => {
        outboxRows.push({ principal, index, stored })
      })
    // The WHOLE record, in EVERY state. Terminal and dead-lettered entries keep
    // the author's `input` verbatim, and they are exactly the rows a scrub
    // written against the live queue would walk past.
    const outbox = planSecretScrub(
      outboxRows.map((row) => ({
        address: `outbox[${row.principal}/${row.stored.mutationId}]`,
        row,
        value: row.stored.record,
      })),
    )

    const report = mergeScrubReports(
      this.rebuildScrub,
      entities.report,
      cursors.report,
      outbox.report,
    )
    this.rebuildScrub = EMPTY_SCRUB_REPORT
    if (entities.rewrites.length + cursors.rewrites.length + outbox.rewrites.length === 0) {
      this.options.onSecretsScrubbed?.(report)
      return
    }

    const tx = await this.transaction([...ALL_STORES], 'readwrite')
    const completion = transactionCompletion(tx)
    for (const rewrite of entities.rewrites) {
      const { principal, record } = rewrite.row
      tx.objectStore(ENTITY_STORE).put({
        principal,
        entity: record.entity,
        entityId: record.entityId,
        value: rewrite.value,
        ...(record.revision === undefined ? {} : { revision: record.revision }),
        ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
        ...(record.part === undefined ? {} : { part: record.part }),
        ...(record.asOf === undefined ? {} : { asOf: record.asOf }),
      } satisfies StoredEntity)
    }
    for (const rewrite of cursors.rewrites) {
      tx.objectStore(META_STORE).put({
        principal: rewrite.row.principal,
        key: CURSOR_META_KEY,
        value: rewrite.value,
      } satisfies StoredMeta)
    }
    for (const rewrite of outbox.rewrites) {
      const { stored } = rewrite.row
      tx.objectStore(OUTBOX_STORE).put({
        principal: stored.principal,
        mutationId: stored.mutationId,
        ordinal: stored.ordinal,
        record: rewrite.value,
      } satisfies StoredOutboxRecord)
    }
    await completion

    // …and only now the mirror.
    for (const rewrite of entities.rewrites) {
      const { principal, key, record } = rewrite.row
      this.entities.get(principal)?.set(key, { ...record, value: rewrite.value })
    }
    for (const rewrite of cursors.rewrites)
      this.metas.set(rewrite.row.principal, {
        ...this.metaOf(rewrite.row.principal),
        cursor: rewrite.value as ScopedCacheCursor | null,
      })
    for (const rewrite of outbox.rewrites) {
      const { principal, index, stored } = rewrite.row
      const slice = this.outboxRows.get(principal)
      if (slice) slice[index] = { ...stored, record: rewrite.value }
    }
    this.options.onSecretsScrubbed?.(report)
  }

  private async clearAll(): Promise<void> {
    const tx = await this.transaction([...ALL_STORES], 'readwrite')
    const completion = transactionCompletion(tx)
    for (const name of ALL_STORES) tx.objectStore(name).clear()
    // An empty store's index is built: the flag says so.
    tx.objectStore(INDEX_STORE).put({
      principal: STORE_PRINCIPAL,
      key: INDEX_BUILT_META_KEY,
      v: INDEX_FORMAT,
    } satisfies StoredIndexRow)
    await completion
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.stubsInIndex = false
  }

  // ── mirror accessors used by the views ───────────────────────────────────

  guardReadable(): void {
    if (this.corrupt) throw new ReplicaStoreCorruptError()
  }

  retainsEntity(entity: string): boolean {
    return this.options.retainEntity?.(entity) ?? true
  }

  entitiesOf(principal: string): RowMirror {
    return this.entities.get(principal) ?? new RowMirror()
  }

  metaOf(principal: string): CacheMeta {
    return this.metas.get(principal) ?? EMPTY_CACHE_META
  }

  /** The durable operations of metadata writes, in order. */
  stageMetaWrites(draft: SpanDraft, principal: string, writes: readonly MetaWrite[]): void {
    for (const write of writes) {
      if (write.kind === 'put') {
        draft.ops.push({
          kind: 'put',
          store: META_STORE,
          value: { principal, key: write.key, value: write.value } satisfies StoredMeta,
        })
      } else if (write.kind === 'delete') {
        draft.ops.push({ kind: 'delete', store: META_STORE, key: [principal, write.key] })
      } else {
        const range = this.options.keyRange?.bound(
          [principal, INSTANCE_META_PREFIX],
          [principal, INSTANCE_META_END],
        )
        if (range !== undefined) draft.ops.push({ kind: 'delete', store: META_STORE, key: range })
        else
          for (const key of (draft.metas.get(principal) ?? this.metaOf(principal)).instances.keys())
            draft.ops.push({
              kind: 'delete',
              store: META_STORE,
              key: [principal, instanceMetaKey(key)],
            })
      }
    }
  }

  /** Forget a principal's cursor, markers, policy and load state in this draft. */
  stageMetaReset(draft: SpanDraft, principal: string): void {
    const before = draft.metas.get(principal) ?? this.metaOf(principal)
    const writes: MetaWrite[] = [
      { kind: 'delete', key: CURSOR_META_KEY },
      { kind: 'deleteInstances' },
    ]
    const reset = nextCacheMeta(before, {
      operations: [],
      instances: [{ kind: 'dropAll' }],
      policy: null,
      loadingSince: null,
    })
    for (const write of reset.writes) if (write.kind === 'delete') writes.push(write)
    this.stageMetaWrites(draft, principal, writes)
    draft.metas.set(principal, EMPTY_CACHE_META)
  }

  outboxOf(principal: string): readonly StoredOutboxRecord[] {
    return this.outboxRows.get(principal) ?? []
  }

  takeOrdinal(): number {
    const next = this.nextOrdinal
    this.nextOrdinal += 1
    return next
  }
}

/**
 * One principal's two ports.
 *
 * `cache` has no outbox method, so `discardCache()` CANNOT reach the queue — the
 * structural defence `replica/ports.ts` exists to hold, carried through to the
 * durable adapter. A discard stages deletions for this principal's ENTITY and
 * CURSOR rows only, and the outbox object store is not among the keys it names.
 */
export class IndexedDbStoreView {
  readonly cache: ReplicaCacheStore
  readonly outbox: OutboxStorePort

  constructor(
    store: IndexedDbSyncStore,
    private readonly principal: string,
  ) {
    this.cache = new IndexedDbCacheStore(store, principal)
    this.outbox = new IndexedDbOutboxStore(store, principal)
  }

  /** The principal this pair is bound to. Diagnostics only; nothing branches on it. */
  get boundTo(): string {
    return this.principal
  }
}

class IndexedDbCacheStore implements ReplicaCacheStore {
  constructor(
    private readonly store: IndexedDbSyncStore,
    private readonly principal: string,
  ) {}

  readCursor(): Cursor | null {
    this.store.guardReadable()
    return cursorTriple(this.store.metaOf(this.principal).cursor)
  }

  readKindTokens(): KindTokens | undefined {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).cursor?.kindTokens
  }

  readKindReloadVersion(): number | undefined {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).cursor?.kindReloadVersion
  }

  refreshAfterCacheConflict(): Promise<boolean> {
    return this.store.refreshAfterCacheConflict()
  }

  readRetainedKinds(): readonly string[] | undefined {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).cursor?.retainedKinds
  }

  retainsEntity(entity: string): boolean {
    return this.store.retainsEntity(entity)
  }

  readInstances(): ReadonlyMap<string, InstanceRecord> {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).instances
  }

  readPolicy(): CachePolicy | null {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).policy
  }

  readLoadingSince(): number | null {
    this.store.guardReadable()
    return this.store.metaOf(this.principal).loadingSince
  }

  readDiskIndex(): DiskIndexReader {
    this.store.guardReadable()
    return this.store.indexOf(this.principal)
  }

  readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]> {
    return this.store.readStoredRows(this.principal, keys)
  }

  installResident(rows: readonly EntityRecord[]): readonly EntityRecord[] {
    this.store.guardReadable()
    return installResidentRows(
      this.store.entitiesOf(this.principal),
      this.store.indexOf(this.principal),
      rows,
    )
  }

  markInMemory(instanceKeys: readonly string[]): void {
    this.store.guardReadable()
    const markers = this.store.metaOf(this.principal).instances
    this.store.indexOf(this.principal).setInMemory(
      instanceKeys.filter((key) => markers.has(key)),
      true,
    )
  }

  unload(instanceKeys: readonly string[]): readonly Pick<EntityRecord, 'entity' | 'entityId'>[] {
    this.store.guardReadable()
    // Degraded, memory is ahead of the disk: nothing may leave it.
    if (this.store.durability() !== 'durable') return []
    return unloadResident(
      this.store.entitiesOf(this.principal),
      this.store.indexOf(this.principal),
      instanceKeys,
    )
  }

  touchInstance(instanceKey: string, at: number): void {
    this.store.indexOf(this.principal).touch(instanceKey, at)
  }

  readEntities(): readonly EntityRecord[] {
    this.store.guardReadable()
    return this.store.entitiesOf(this.principal).mainRows()
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    this.store.guardReadable()
    const row = this.store.entitiesOf(this.principal).getMain(rowKey(entity, entityId))
    return row === undefined || !isMainRow(row) ? undefined : row
  }

  readRow(entity: string, entityId: string): EntityRecord | undefined {
    this.store.guardReadable()
    return this.store.entitiesOf(this.principal).get(rowKey(entity, entityId))
  }

  readStubs(): readonly EntityRecord[] {
    this.store.guardReadable()
    return this.store.entitiesOf(this.principal).stubRows()
  }

  readStubTable(entity: string): StubTableReader | undefined {
    this.store.guardReadable()
    return this.store.entitiesOf(this.principal).stubTable(entity)
  }

  beginSpan(): OwnedSyncSpan {
    return this.store.beginSpan()
  }

  applyAtomic(mutation: CacheMutation, span?: SyncSpan): void {
    this.store.guardReadable()
    if (span !== undefined) {
      this.stage(this.store.draftFor(span), mutation)
      return
    }
    // A lone single-region write may autocommit (D10 clause 2). It reaches
    // IndexedDB asynchronously because IndexedDB is asynchronous;
    // `IndexedDbSyncStore.settled()` is how a caller waits, and a failure surfaces
    // through `onDegraded` rather than through a `void` return with nowhere to put
    // it.
    this.store.autocommitEager((draft) => {
      this.stage(draft, mutation)
    })
  }

  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
    span?: SyncSpan,
    versions: SnapshotVersions = {},
  ): void {
    this.store.guardReadable()
    const install = (draft: SpanDraft): void => {
      // The atomic swap of ADR 2 D6.4: the staged slice REPLACES this principal's
      // rows, the buffered deltas apply on top, and the cursor commits — one
      // transaction, no half-installed replica.
      this.store.expectCacheGeneration(draft, this.principal)
      this.store.stageDeleteEveryRow(draft, this.principal)
      const next = new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror())
      draft.entities.set(this.principal, next)
      draft.touchedCache = true
      const index = this.store.indexDraft(draft, this.principal)
      for (const row of rows) {
        if (!this.store.retainsEntity(row.entity)) continue
        const key = rowKey(row.entity, row.entityId)
        next.set(key, row)
        index.row(key, row)
        // POD-7170: a stub lives in its index entry only.
        if (row.part !== 'stub')
          draft.ops.push({
            kind: 'put',
            store: ENTITY_STORE,
            value: entityRow(this.principal, row),
          })
        else this.store.noteStubInIndex(draft)
      }
      // The markers and policy described the rows this replaces.
      this.store.stageMetaReset(draft, this.principal)
      this.stageMeta(draft, {
        operations: [],
        cursor,
        ...versions,
      })
      for (const mutation of buffered) {
        this.applyOperations(draft, next, mutation)
        this.stageMeta(draft, mutation)
        stageIndexInstances(index, mutation.instances)
        stageIndexComesWith(index, mutation.comesWith)
      }
    }
    if (span !== undefined) {
      install(this.store.draftFor(span))
      return
    }
    this.store.autocommitEager(install)
  }

  discardCache(): void {
    this.store.guardReadable()
    // Reaches entities and the cursor. The outbox object store is not named here,
    // and there is no method on this port through which it could be.
    this.store.autocommitEager((draft) => {
      this.store.expectCacheGeneration(draft, this.principal)
      this.store.stageDeleteEveryRow(draft, this.principal)
      draft.entities.set(
        this.principal,
        new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror()),
      )
      this.store.stageMetaReset(draft, this.principal)
      draft.touchedCache = true
    })
  }

  durability(): DurabilityMode {
    return this.store.durability()
  }

  private stage(draft: SpanDraft, mutation: CacheMutation): void {
    this.store.expectCacheGeneration(draft, this.principal)
    if (mutation.operations.length > 0) this.applyOperations(draft, this.slice(draft), mutation)
    this.stageMeta(draft, mutation)
    // The disk index after the rows: a marker's members are rows it can see.
    if ((mutation.instances?.length ?? 0) > 0 || (mutation.comesWith?.length ?? 0) > 0) {
      const index = this.store.indexDraft(draft, this.principal)
      stageIndexInstances(index, mutation.instances)
      stageIndexComesWith(index, mutation.comesWith)
      draft.touchedCache = true
    }
  }

  /** The cursor, markers, policy and load state a mutation leaves, staged with their writes. */
  private stageMeta(draft: SpanDraft, mutation: CacheMutation): void {
    const before = draft.metas.get(this.principal) ?? this.store.metaOf(this.principal)
    const next = nextCacheMeta(before, mutation)
    if (next.writes.length === 0) return
    this.store.stageMetaWrites(draft, this.principal, next.writes)
    draft.metas.set(this.principal, next.meta)
    draft.touchedCache = true
  }

  /**
   * IN ORDER, never grouped by kind. A frame carrying `remove(seq 1)` then
   * `upsert(seq 2)` for one entity must leave it PRESENT, and the durable ops are
   * appended in the same order so the native transaction reproduces it exactly
   * (ADR 2 D9/D13 — order is the correctness property).
   */
  private applyOperations(
    draft: SpanDraft,
    slice: ChangedKeyDraft<EntityRecord, RowMirror>,
    mutation: CacheMutation,
  ): void {
    draft.touchedCache = true
    const published = this.store.entitiesOf(this.principal)
    const index = this.store.indexDraft(draft, this.principal)
    let diskOnly = draft.diskOnly.get(this.principal)
    if (diskOnly === undefined) {
      diskOnly = new DiskOnlyWrites()
      draft.diskOnly.set(this.principal, diskOnly)
    }
    for (const op of mutation.operations) {
      if (!this.store.retainsEntity(op.entity)) continue
      const key = rowKey(op.entity, op.entityId)
      // POD-7160: newest wins against the row in memory or, only on disk, its index entry.
      const staged = stageRow(key, op, slice.get(key, published), diskOnly, index)
      if (staged === undefined) continue
      const row = staged.row
      if (row !== null) {
        if (staged.memory) slice.set(key, row)
        const before = index.record(key)?.level
        index.row(key, row, op.kind === 'upsert' ? op.holders : undefined)
        if (row.part !== 'stub')
          draft.ops.push({
            kind: 'put',
            store: ENTITY_STORE,
            value: entityRow(this.principal, row),
          })
        else {
          // POD-7170: a stub-level record has no entity row (its index entry
          // stores the stub); one taken back to its stub drops its whole row.
          this.store.noteStubInIndex(draft)
          if (before === 'main')
            draft.ops.push({
              kind: 'delete',
              store: ENTITY_STORE,
              key: [this.principal, op.entity, op.entityId],
            })
        }
        continue
      }
      index.row(key, null)
      // `remove` (tombstone, global) and `evict` (this principal's view only) both
      // drop the row from THIS principal's slice — and under a per-principal
      // keyspace that is the whole difference, because an evict must not touch
      // anybody else's copy. Amendment 1 D14.5's distinction is preserved upstream
      // in the envelope's op and, for the port, by `cacheOperations()`.
      slice.delete(key)
      draft.ops.push({
        kind: 'delete',
        store: ENTITY_STORE,
        key: [this.principal, op.entity, op.entityId],
      })
    }
  }

  /** Stage only changed keys; published rows stay untouched until publish. */
  private slice(draft: SpanDraft): ChangedKeyDraft<EntityRecord, RowMirror> {
    const staged = draft.entities.get(this.principal)
    if (staged !== undefined) return staged
    const changes = new ChangedKeyDraft<EntityRecord, RowMirror>()
    draft.entities.set(this.principal, changes)
    return changes
  }
}

class IndexedDbOutboxStore implements OutboxStorePort {
  constructor(
    private readonly store: IndexedDbSyncStore,
    private readonly principal: string,
  ) {}

  /**
   * The fresh-truth read — at open, and before every kernel Outbox state change.
   *
   * It re-reads the outbox region from IndexedDB first, and that is what makes a
   * recovery in a test an honest one: a read that only returned the mirror would
   * report what a surviving object still held rather than what committed — and
   * what lets a rebase see another tab's committed work. ONLY the outbox region,
   * never the entity rows (POD-4810): see `rehydrateOutbox`. It refuses while
   * degraded and waits for the outbox's own commits, so it can never roll the
   * mirror back past work still in flight.
   */
  async read(): Promise<readonly OutboxRecord[]> {
    this.store.guardReadable()
    await this.store.rehydrateOutbox()
    this.store.guardReadable()
    return this.store.outboxOf(this.principal).map((row) => row.record as OutboxRecord)
  }

  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult> {
    this.store.guardReadable()
    const declared = new Set(mutation.expect.map((e) => e.mutationId))
    const undeclared = [
      ...(mutation.put ?? []).map((r) => r.mutationId),
      ...(mutation.remove ?? []),
    ].filter((id) => !declared.has(id))
    if (undeclared.length > 0) {
      throw new Error(`mutation touches ${undeclared.join(', ')} with no precondition`)
    }
    if (span !== undefined) {
      const draft = this.store.draftFor(span)
      const conflicts = this.conflictsOf(mutation, this.rows(draft))
      if (conflicts.length > 0) return { ok: false, conflicts }
      this.stage(draft, mutation)
      return { ok: true }
    }
    let outcome: OutboxApplyResult = { ok: true }
    await this.store.autocommit((draft) => {
      const conflicts = this.conflictsOf(mutation, this.rows(draft))
      if (conflicts.length > 0) {
        outcome = { ok: false, conflicts }
        return
      }
      this.stage(draft, mutation)
    })
    return outcome
  }

  private stage(draft: SpanDraft, mutation: OutboxStoreMutation): void {
    const rows = this.rows(draft)
    draft.touchedOutbox = true
    for (const expectation of mutation.expect) {
      draft.expectations.push({ principal: this.principal, expectation })
    }
    for (const id of mutation.remove ?? []) {
      const at = rows.findIndex((row) => row.mutationId === id)
      if (at >= 0) rows.splice(at, 1)
      draft.ops.push({ kind: 'delete', store: OUTBOX_STORE, key: [this.principal, id] })
    }
    for (const record of mutation.put ?? []) {
      const at = rows.findIndex((row) => row.mutationId === record.mutationId)
      // A replacing put KEEPS the record's existing position (the port's stated
      // contract); only a first put appends. Reusing the ordinal is what carries
      // that across a reload.
      const ordinal = at >= 0 ? (rows[at] as StoredOutboxRecord).ordinal : this.store.takeOrdinal()
      const row: StoredOutboxRecord = {
        principal: this.principal,
        mutationId: record.mutationId,
        ordinal,
        // Through a JSON round trip, as a real adapter's structured clone would be:
        // anything that survives only by object identity fails here the same way it
        // would on device, which is the class of bug ADR 6 D4 exists to catch.
        record: JSON.parse(JSON.stringify(record)) as unknown,
      }
      if (at >= 0) rows[at] = row
      else rows.push(row)
      draft.ops.push({ kind: 'put', store: OUTBOX_STORE, value: row })
    }
  }

  private conflictsOf(
    mutation: OutboxStoreMutation,
    rows: readonly StoredOutboxRecord[],
  ): MutationId[] {
    const conflicts: MutationId[] = []
    for (const expectation of mutation.expect) {
      const row = rows.find((candidate) => candidate.mutationId === expectation.mutationId)
      const state = row === undefined ? 'absent' : (row.record as OutboxRecord).state
      if (state !== expectation.expect) conflicts.push(expectation.mutationId)
    }
    return conflicts
  }

  private rows(draft: SpanDraft): StoredOutboxRecord[] {
    const staged = draft.outbox.get(this.principal)
    if (staged !== undefined) return staged
    const copy = [...this.store.outboxOf(this.principal)]
    draft.outbox.set(this.principal, copy)
    return copy
  }
}

/** A stored entity row, as the port's record. */
function entityRecordOf(row: StoredEntity): EntityRecord {
  return {
    entity: row.entity,
    entityId: row.entityId,
    value: row.value,
    revision: row.revision,
    provenance: row.provenance as EntityRecord['provenance'],
    ...(row.part === 'stub' ? { part: 'stub' as const } : {}),
    ...(typeof row.asOf === 'number' ? { asOf: row.asOf } : {}),
  }
}

/** The state of a marker the index has no members for: only the server can answer it. */
const NOT_INDEXED = Object.freeze({ lastReadAt: 0, stale: false, indexed: false })

const entityRow = (principal: string, row: EntityRecord): StoredEntity => ({
  principal,
  entity: row.entity,
  entityId: row.entityId,
  value: row.value,
  revision: row.revision,
  provenance: row.provenance,
  ...(row.part === undefined ? {} : { part: row.part }),
  ...(row.asOf === undefined ? {} : { asOf: row.asOf }),
})

/**
 * The transaction's own outcome, as a promise.
 *
 * `oncomplete` is the ONLY durability signal IndexedDB gives. A `put` whose request
 * succeeded is not durable — the transaction can still abort afterwards, which is
 * exactly what a quota denial does — so nothing in this adapter treats a request
 * success as a commit.
 */
function transactionCompletion(tx: IdbTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

function openDatabase(
  factory: IdbFactoryLike,
  name: string,
  timeoutMs: number = IDB_OPEN_TIMEOUT_MS,
  options?: Pick<IndexedDbStoreOptions, 'keyRange' | 'onSchemaUpgrade'>,
): Promise<IdbDatabaseLike> {
  return new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(name, REPLICA_SCHEMA_VERSION)
    let settled = false
    let upgraded: { from: number; to: number; cachePrincipalsReset: number } | undefined
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new IndexedDbOpenTimeoutError(timeoutMs))
    }, timeoutMs)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    request.onupgradeneeded = (event) => {
      const from = (event as { oldVersion?: number } | undefined)?.oldVersion ?? 0
      upgraded = { from, to: REPLICA_SCHEMA_VERSION, cachePrincipalsReset: 0 }
      upgradeSchema(
        request.result,
        request.transaction === null
          ? undefined
          : {
              transaction: request.transaction,
              oldVersion: from,
              keyRange: options?.keyRange,
              onLegacyReset: (count) => {
                if (upgraded !== undefined) upgraded.cachePrincipalsReset = count
              },
            },
      )
    }
    // Another connection is holding the version lock. Do not wait it out —
    // the timeout is the bound. A later success still closes the late handle.
    request.onblocked = () => {
      return
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      // Another tab is upgrading. Close so it is not blocked (D4.6). A pending
      // draft may reopen before its next transaction; an incompatible version
      // refuses through the owning port, never by deleting the durable rows.
      db.onversionchange = () => {
        db.close()
      }
      finish(() => {
        resolve(db)
        if (upgraded !== undefined) {
          try {
            options?.onSchemaUpgrade?.(upgraded)
          } catch {
            // Observability cannot refuse an already committed database open.
          }
        }
      })
    }
    request.onerror = () => {
      finish(() => {
        reject(request.error ?? new Error('IndexedDB open failed'))
      })
    }
  })
}

function deleteDatabase(factory: IdbFactoryLike, name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => {
      resolve()
    }
    // A delete that fails leaves the poisoned store in place; the caller degrades to
    // memory rather than wedging, so there is nothing useful to reject with.
    request.onerror = () => {
      resolve()
    }
  })
}

/** The stand-in for "there is no IndexedDB here" — every call throws, nothing is durable. */
function unavailableDatabase(): IdbDatabaseLike {
  const refuse = (): never => {
    throw new Error('IndexedDB is unavailable')
  }
  return {
    objectStoreNames: { contains: () => false },
    createObjectStore: refuse,
    transaction: refuse,
    close: () => undefined,
    onversionchange: null,
  }
}

/** POD-7170: the store-wide meta row that says stub-level records live in the index only. */
const STUBS_IN_INDEX_KEY = 'stubs-in-index'

const isStubsInIndexFlag = (row: StoredMeta): boolean =>
  row.principal === STORE_PRINCIPAL && row.key === STUBS_IN_INDEX_KEY
