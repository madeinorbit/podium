/**
 * THE MOBILE REPLICA STORAGE ADAPTER — SQLite (ADR 6 D1, D3, D4, D5.1, D4.7).
 *
 * ADR 6 D1 names SQLite as the durable engine for mobile replica entities, cursor,
 * outbox and overlay, with `AsyncStorage` for small UI preferences ONLY — never for
 * the replica payload, "including 'degraded'" (D4.4.4). This adapter is that
 * decision as code: four tables in ONE database file (`./schema.ts`), one
 * `BEGIN IMMEDIATE … COMMIT` spanning all of them, and no AsyncStorage on any path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADAPTER DOES THAT THE WEB ONE COULD NOT: PUBLISH AFTER DURABILITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The kernel port is synchronous — `readCursor()`/`readEntities()`/`read()` return
 * values, `applyAtomic()` returns `void`, and `SyncSpanParticipant.publish` "MUST
 * NOT await". IndexedDB is asynchronous, so POD-374 was forced into one compromise
 * it documents at length: for the cache port's `void` methods it publishes the
 * in-memory mirror BEFORE the durable commit resolves, because there is nowhere to
 * put the promise.
 *
 * SQLite's synchronous API has no such hazard. `BEGIN IMMEDIATE`, the staged
 * statements and `COMMIT` all run to completion inside one call, so:
 *
 *   EVERY PUBLICATION IN THIS ADAPTER IS STRICTLY AFTER THE COMMIT RETURNED,
 *   including the ones POD-374 could not make wait.
 *
 * That is not a stylistic win, it is D4.7 — "SQLite transactions commit before the
 * adapter resolves the kernel write; best-effort flush on `AppState` change is
 * insufficient as the sole durability mechanism". There is no flush hook in this
 * file, no `AppState` listener and no write-behind queue, and `lifecycle.test.ts`
 * asserts their ABSENCE with a probe that can say yes. The write-behind bridge ADR 6
 * cites as the thing being replaced (`client-core/src/replica/async-storage.ts`,
 * "crash between sync cache write and flush loses the queue tail") is precisely the
 * shape that must not reappear.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HYDRATE ONCE, MIRROR IN MEMORY, COMMIT THROUGH ONE NATIVE TRANSACTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - `open()` reads every row of every table into an in-memory MIRROR. From then on
 *     the mirror answers every synchronous read. (SQLite could serve them directly;
 *     the mirror exists because DEGRADED mode must keep a session alive with no
 *     durable store behind it, and a read path that only worked while durable would
 *     have to be written twice.)
 *   - A write STAGES into a span-private draft plus a list of SQL statements.
 *   - Commit opens ONE transaction, re-checks preconditions against DURABLE rows,
 *     issues the staged statements, and commits.
 *   - The mirror is swapped in — and `onCommit` adoptions run — after that returned.
 *
 * The mirror is therefore never ahead of durable truth while the store is `durable`.
 * When it deliberately IS ahead — after a quota denial — the mode says so
 * (`degraded-memory`) and the degradation is surfaced, which is D4.4 exactly.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CRASH IS, AND WHY THE TESTS OPEN A SECOND CONNECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Because reads are served from a mirror, a "crash" that keeps this object alive
 * proves nothing: it re-reads the very memory the crash was supposed to destroy.
 * That is the fixture-certifying-itself shape POD-306 found, and POD-374 measured
 * the sharper version of it — the shared conformance suite stayed GREEN under a
 * mutant giving each staged write its own transaction, because `failNextCommit`
 * fires before the adapter's native transaction opens. THE CONFORMANCE SUITE IS
 * BLIND TO WHAT THIS FILE DOES INSIDE ITS TRANSACTION. `crash.test.ts` is the gate
 * that is not: it kills at every boundary INSIDE one live transaction and reads back
 * through a connection of its own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRECONDITIONS ARE RE-CHECKED INSIDE THE NATIVE TRANSACTION (ADR 6 D4.6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OutboxStoreMutation.expect` is checked twice: once against the mirror when the
 * mutation is staged (so `apply` can return `{ok: false, conflicts}` to a caller
 * that can still re-stage), and once with `SELECT`s issued INSIDE the transaction,
 * against the durable rows. D4.6 is written for web's multi-TAB case; the mobile
 * equivalent is a second connection to the same file — a share extension, a
 * notification-service process, or the app restarted while the old process is still
 * finishing — and the durable re-check is what binds across all of them, because
 * each has its own mirror. A conflict there raises `SyncCommitConflict` and rolls the
 * whole transaction back.
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
  ALL_TABLES,
  applySchema,
  dropSchema,
  ENTITY_TABLE,
  INDEX_TABLE,
  META_TABLE,
  migrateSchema,
  OUTBOX_TABLE,
  REPLICA_SCHEMA_VERSION,
  readSchemaVersion,
  type StoredOutboxRecord,
} from './schema'
import { isNotDatabaseError, isQuotaError, type SqlDatabaseLike, type SqlValue } from './sql'

/** The mirror's composite key. The separator is written as an ESCAPE and never as a
 *  literal NUL: a raw 0x00 makes the file binary, so `grep -n` and agent search
 *  wrappers answer "no match" for code that is right there (scripts/check-no-nul-bytes.ts,
 *  which is what caught it here). A NUL is still the right separator, because an
 *  entity kind containing the delimiter would otherwise collide two distinct keys. */
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
/** Most values bound in one `IN (…)` list. */
const IN_LIST_MAX = 400

/** The state of a marker the index has no members for: only the server can answer it. */
const NOT_INDEXED = Object.freeze({ lastReadAt: 0, stale: false, indexed: false })

export type DurabilityMode = 'durable' | 'degraded-memory' | 'unavailable'

/**
 * ADR 6 D4.4 clause 3 — "the UI is EXPLICITLY informed: offline guarantees are
 * suspended; reload may cold-start".
 *
 * A callback and not a log line, and REQUIRED at construction for the same reason
 * `OutboxConfig.onStoreUnreadable` is: making the one silent-degradation path a
 * mandatory parameter is how "explicitly surfaced" becomes a compile-time obligation
 * instead of something an integrator means to wire up later.
 */
export interface DurabilityDegradation {
  readonly mode: Exclude<DurabilityMode, 'durable'>
  /** `quota` is D4.4; `corrupt` is D4.5; `unavailable` is "no usable SQLite here at all". */
  readonly cause: 'quota' | 'corrupt' | 'unavailable'
  readonly error: unknown
}

export interface SqliteStoreOptions {
  /** Retire unsupported entity cache rows without changing cursors or the outbox. */
  readonly retainEntity?: (entity: string) => boolean
  /** Open (or create) the replica database file. Called again after a poison clear. */
  readonly openDatabase: () => SqlDatabaseLike
  /**
   * Async open used by browser SQLite implementations whose worker and OPFS VFS
   * need asynchronous initialization before synchronous transactions are safe.
   */
  readonly openDatabaseAsync?: () => Promise<SqlDatabaseLike>
  /**
   * Remove the underlying file, so a poisoned or newer-version store can be
   * recreated (D4.5 / D6).
   *
   * REQUIRED, and that is the point: "corruption clears and cold-starts, never
   * wedges boot" is only true if the caller supplied a way to clear. An optional
   * hook would let an integrator ship a client that wedges on a file it cannot read,
   * and the failure would appear on a user's device rather than at this call site.
   */
  readonly deleteDatabase: () => void
  /** Async counterpart used for browser SQLite recovery. */
  readonly deleteDatabaseAsync?: () => Promise<void>
  /** REQUIRED — see {@link DurabilityDegradation}. */
  readonly onDegraded: (degradation: DurabilityDegradation) => void
  /** Called after every open with what the secret scrub found (POD-419).
   *  Optional, and deliberately not the mechanism anything depends on — see the
   *  same option on the IndexedDB adapter. */
  readonly onSecretsScrubbed?: (report: SecretScrubReport) => void
}

/** An outbox row as SQLite returns it. */
interface OutboxRow {
  readonly principal: string
  readonly mutation_id: MutationId
  readonly ordinal: number
  readonly record: string
}

/** One staged SQL statement, issued into the commit transaction verbatim and IN ORDER. */
interface SqlOp {
  readonly sql: string
  readonly params: SqlValue[]
}

/** The post-state one span has staged, per region, plus the statements that produce it. */
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
  indexWritten: boolean
  readonly outbox: Map<string, StoredOutboxRecord[]>
  readonly ops: SqlOp[]
  /** Re-checked inside the native transaction against durable rows (D4.6). */
  readonly expectations: { principal: string; expectation: OutboxRecordExpectation }[]
  touchedCache: boolean
  touchedOutbox: boolean
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
  touchedCache: false,
  touchedOutbox: false,
})

/**
 * The span this adapter hands out.
 *
 * `commit()` is synchronous, and here that is the whole story rather than half of it:
 * the durable transaction runs inside this call, so `publishAll()` below it is
 * unambiguously after durability and a failure THROWS from the call that caused it.
 *
 * There is deliberately no `durable` promise. `IdbSpan` needs one because IndexedDB
 * reports a commit long after `commit()` returns; here it would be a promise that is
 * always already settled, and the first draft of this file proved that is not merely
 * redundant — a rejected one, on a path that also throws, is an UNHANDLED REJECTION
 * whenever the throw is what the caller actually catches. An async seam kept "for
 * symmetry" over a synchronous engine is a liability, not a courtesy.
 */
class SqlSpan implements OwnedSyncSpan {
  private readonly participants: SyncSpanParticipant[] = []
  private readonly adoptions: (() => void)[] = []
  private state: 'open' | 'discarded' | 'published' = 'open'

  constructor(private readonly settle: (span: SqlSpan) => void) {}

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
    this.settle(this)
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

  /** Called only after SQLite's COMMIT returned. */
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
 * One physical SQLite store, handing out one pair of ports per principal.
 *
 * Construct with `SqliteSyncStore.open(...)`; the constructor is private because a
 * store whose mirror has not been hydrated would answer every read with an empty
 * slice, and an empty slice is indistinguishable from a cold client.
 */
export class SqliteSyncStore {
  private mode: DurabilityMode = 'durable'
  /** Flipped by the corruption injector. */
  private corrupt = false
  // POD-7115: a stub is kept only in its record type's stub table.
  // POD-7159: the resident set, not a copy of the disk.
  private readonly entities = new Map<string, RowMirror>()
  private readonly metas = new Map<string, CacheMeta>()
  /** POD-7159: per principal, the disk index (always in memory). */
  private readonly indexes = new Map<string, DiskIndex>()
  private readonly outboxRows = new Map<string, StoredOutboxRecord[]>()
  private readonly views = new Map<string, SqliteStoreView>()
  private readonly drafts = new Map<SqlSpan, SpanDraft>()
  private nextOrdinal = 0
  /** What a rebuild of the index scrubbed, reported with the open's scrub. */
  private rebuildScrub: SecretScrubReport = EMPTY_SCRUB_REPORT
  /** Spans opened by `unitOfWork.transact`, so `cacheWrites` can exclude them. */
  private readonly transactSpans = new WeakSet<SqlSpan>()

  transactCount = 0
  outboxCommits = 0
  cacheCommits = 0

  private constructor(
    private readonly db: SqlDatabaseLike,
    private readonly options: SqliteStoreOptions,
  ) {}

  /**
   * Open, version-check and hydrate.
   *
   * A failed upgrade leaves the file available for the next launch to retry.
   * Only SQLite's whole-file format error permits replacing the file (D4.5).
   */
  static async open(options: SqliteStoreOptions): Promise<SqliteSyncStore> {
    try {
      return await SqliteSyncStore.openFile(options)
    } catch (error) {
      if (!isNotDatabaseError(error)) return SqliteSyncStore.unavailable(options, error)
      let recovered: SqliteSyncStore
      try {
        if (options.deleteDatabaseAsync) await options.deleteDatabaseAsync()
        else options.deleteDatabase()
        recovered = await SqliteSyncStore.openFile(options)
      } catch (fatal) {
        return SqliteSyncStore.unavailable(options, fatal)
      }
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error })
      return recovered
    }
  }

  private static async openFile(options: SqliteStoreOptions): Promise<SqliteSyncStore> {
    const db = options.openDatabaseAsync
      ? await options.openDatabaseAsync()
      : options.openDatabase()
    const store = new SqliteSyncStore(db, options)
    let mismatch: SchemaVersionMismatch | undefined
    try {
      mismatch = store.prepareSchema()
      await store.hydrate()
      // POD-419: scrub material written by earlier builds on every open.
      store.scrubSecrets()
    } catch (error) {
      store.close()
      throw error
    }
    if (mismatch !== undefined)
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error: mismatch })
    return store
  }

  private static unavailable(options: SqliteStoreOptions, error: unknown): SqliteSyncStore {
    const store = new SqliteSyncStore(unavailableDatabase(), options)
    store.degrade('unavailable', 'unavailable', error)
    return store
  }

  /** ADR 6 D4 — surfaced, never silent. */
  durability(): DurabilityMode {
    if (this.corrupt) return 'unavailable'
    return this.mode
  }

  /** One principal's pair of ports over this one physical store (ADR 6 D4.1). */
  viewFor(principal: string): SqliteStoreView {
    const existing = this.views.get(principal)
    if (existing !== undefined) return existing
    const view = new SqliteStoreView(this, principal)
    this.views.set(principal, view)
    return view
  }

  /**
   * Erase one principal's entity, cursor and authored-work regions atomically.
   * This is lifecycle retention/sign-out, not D7 cache healing, so reaching the
   * outbox is intentional.
   */
  async erasePrincipal(principal: string): Promise<void> {
    this.guardReadable()
    await this.unitOfWork.transact(async (span) => {
      const draft = this.draftFor(span)
      this.indexDraft(draft, principal).clearAll()
      draft.ops.push(
        {
          sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ?`,
          params: [principal],
        },
        {
          sql: `DELETE FROM ${META_TABLE} WHERE principal = ?`,
          params: [principal],
        },
        {
          sql: `DELETE FROM ${OUTBOX_TABLE} WHERE principal = ?`,
          params: [principal],
        },
      )
      draft.diskOnly.delete(principal)
      draft.entities.set(principal, new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror()))
      draft.metas.set(principal, EMPTY_CACHE_META)
      draft.outbox.set(principal, [])
      draft.touchedCache = true
      draft.touchedOutbox = true
    })
    this.views.delete(principal)
  }

  /**
   * ADR 2 D10's unit of work over one `BEGIN IMMEDIATE … COMMIT`.
   *
   * The body does LOCAL STORAGE WORK ONLY and the transaction is not opened until it
   * has returned. On IndexedDB that shape is forced (a transaction auto-closes on an
   * unrelated await); here it is chosen, and for a reason that survives the
   * technology change: an awaiting body inside `BEGIN IMMEDIATE` would hold SQLite's
   * write lock across an authority round trip, so any other writer — another
   * connection, a share extension — would block on the network rather than on the
   * disk. Staging first keeps the lock held for the duration of the statements only.
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
        this.drafts.delete(span)
        throw error
      }
      // Throws from HERE if the transaction failed — there is no promise to await,
      // because the commit already happened inside this call.
      span.commit()
      return result
    },
  }

  /**
   * Everything is durable by the time the call that wrote it returned, so there is
   * nothing to wait for.
   *
   * Kept because the crash and lifecycle suites use it as the seam that would have
   * to exist if this adapter ever grew a write-behind queue — and because callers
   * written against `IndexedDbSyncStore` may await it. It is NOT a flush: a store
   * that needed one to be durable would fail `lifecycle.test.ts`'s
   * kill-without-flush case, which never calls this.
   */
  async settled(): Promise<void> {
    return await Promise.resolve()
  }

  /**
   * Re-read every table from SQLite, replacing the mirror.
   *
   * This is the COLD-START read, and exposing it is what lets a recovery in a test be
   * a real one. It refuses while the store is degraded — the mirror is deliberately
   * ahead of durable truth there, and re-reading would silently discard the user's
   * work.
   */
  async rehydrate(): Promise<void> {
    if (this.durability() !== 'durable') return
    await this.hydrate()
  }

  /**
   * Re-read the OUTBOX table alone, replacing that part of the mirror — the
   * fresh-truth read `OutboxStorePort.read()` needs (POD-4810).
   *
   * The kernel Outbox calls `read()` before EVERY state change, to rebase on what
   * another connection may have committed. It used to be `rehydrate()`, which
   * SELECTed and JSON-parsed every entity row on the JS thread: right after a
   * 21,901-row cold sync a phone spent seconds per state change on rows the
   * outbox never returns, and a send is several state changes. Refuses while
   * degraded for the same reason `rehydrate` does.
   */
  rehydrateOutbox(): void {
    if (this.durability() !== 'durable') return
    this.adoptOutboxRows(this.selectOutboxRows())
  }

  /** Test/injector seam: ADR 6 D4.5 / ADR 2 D7 rung 5 — the store cannot be read. */
  setCorrupt(corrupt: boolean): void {
    this.corrupt = corrupt
  }

  close(): void {
    if (this.foldTimer !== undefined) clearTimeout(this.foldTimer)
    try {
      this.db.close()
    } catch {
      // A connection killed mid-transaction refuses to close cleanly. SQLite rolls
      // the open transaction back when the handle is released either way, which is
      // exactly the power-loss recovery `crash.test.ts` relies on.
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private beginOwnSpan(): SqlSpan {
    return new SqlSpan((span) => {
      this.commitSpan(span)
    })
  }

  /** `ReplicaCacheStore.beginSpan()`'s implementation. */
  beginSpan(): OwnedSyncSpan {
    return this.beginOwnSpan()
  }

  draftFor(span: SyncSpan): SpanDraft {
    const owned = span as SqlSpan
    const existing = this.drafts.get(owned)
    if (existing !== undefined) return existing
    const draft = newDraft()
    this.drafts.set(owned, draft)
    span.join({
      // The veto phase. The durable re-check that needs SQLite happens inside the
      // transaction, in `commitDraft`.
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

  /**
   * Stage a lone operation and commit it in its own transaction (D10 clause 2).
   *
   * Synchronous throughout, so the mirror publishes after the commit even for the
   * cache port's `void` methods — the asymmetry POD-374 had to accept and this
   * adapter does not.
   */
  autocommit(stage: (draft: SpanDraft, span: SyncSpan) => void): void {
    const span = this.beginOwnSpan()
    const draft = this.draftFor(span)
    stage(draft, span)
    span.commit()
  }

  /**
   * The durable half of a span: prepare, transact, publish.
   *
   * No queue. IndexedDB needed one because two `readwrite` transactions over the same
   * stores can interleave and resolve in either order; a synchronous SQLite
   * transaction cannot be interleaved by anything in this process, because nothing
   * else runs until `COMMIT` returns. D10's "independent calls are serialized" is
   * therefore a property of the technology here rather than something to enforce.
   */
  private commitSpan(span: SqlSpan): void {
    const draft = this.drafts.get(span) ?? newDraft()
    // The draft is final once its span commits: its index rows join its statements.
    this.stageIndexRows(draft)
    try {
      span.runPrepare()
    } catch (error) {
      span.discardAll()
      this.drafts.delete(span)
      throw error
    }
    if (draft.ops.length === 0) {
      // Nothing durable to do — a span that enrolled only in-memory adoptions.
      span.publishAll()
      return
    }
    if (this.durability() !== 'durable') {
      // D4.4.2 — degraded for the remainder of the session. The write applies to the
      // mirror and to NOTHING ELSE: never AsyncStorage (D4.4.4), and never a durable
      // store that has already refused.
      span.publishAll()
      return
    }
    try {
      this.commitDraft(draft)
    } catch (error) {
      if (isQuotaError(error)) this.degrade('degraded-memory', 'quota', error)
      // The transaction rolled back, so the durable side is byte-identical to what it
      // was. Dropping the drafts keeps the mirror there too — PRE, never torn (D4.1)
      // — and no adoption runs, so no observation escaped (D10).
      span.discardAll()
      this.drafts.delete(span)
      throw error
    }
    if (draft.touchedOutbox) this.outboxCommits += 1
    if (draft.touchedCache && !this.transactSpans.has(span)) this.cacheCommits += 1
    span.publishAll()
  }

  /**
   * ONE native transaction over all four tables.
   *
   * The precondition re-check happens HERE, inside it, against durable rows: this is
   * the version-check ADR 6 D4.6 asks for, and it is the only check that can see a
   * write committed by another connection, because another connection has its own
   * mirror.
   *
   * `BEGIN IMMEDIATE` rather than `BEGIN`: a deferred transaction takes its write
   * lock at the first write, so the `SELECT`s below would run under a read lock that
   * another writer could invalidate before the lock was upgraded — the read-then-write
   * race the re-check exists to close, reintroduced one keyword lower.
   */
  private commitDraft(draft: SpanDraft): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (draft.expectations.length > 0) {
        const select = this.db.prepare(
          `SELECT record FROM ${OUTBOX_TABLE} WHERE principal = ? AND mutation_id = ?`,
        )
        const conflicts: string[] = []
        for (const { principal, expectation } of draft.expectations) {
          const row = select.get(principal, expectation.mutationId) as
            | { record?: string }
            | undefined
          const durableState =
            row?.record === undefined
              ? 'absent'
              : (JSON.parse(row.record) as OutboxRecord | undefined)?.state
          if (durableState !== expectation.expect) conflicts.push(expectation.mutationId)
        }
        if (conflicts.length > 0) throw new SyncCommitConflict(conflicts)
      }
      for (const op of draft.ops) this.db.prepare(op.sql).run(...op.params)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A connection that has died mid-transaction cannot roll back — and does not
        // need to. SQLite's journal makes the next connection to open the file undo
        // the uncommitted transaction, which is what power loss actually looks like
        // and what `crash.test.ts` asserts against a second connection.
      }
      throw error
    }
  }

  /**
   * Remove every classified secret member from every stored row, in ONE
   * `BEGIN IMMEDIATE … COMMIT` over all three tables.
   *
   * The mirror is updated only after COMMIT returns, which is this adapter's
   * rule everywhere else and matters especially here: a mirror scrubbed ahead of
   * its durable write would report clean to every in-process reader while the
   * material sat in the file. `secret-scrub.test.ts` reads back through a SECOND
   * CONNECTION for exactly that reason.
   */
  private scrubSecrets(): void {
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

    const cursors = planSecretScrub(
      [...this.metas].map(([principal, meta]) => ({
        address: `meta[${principal}/${CURSOR_META_KEY}]`,
        row: { principal },
        value: meta.cursor,
      })),
    )

    const outboxRows: { principal: string; index: number; stored: StoredOutboxRecord }[] = []
    for (const [principal, slice] of this.outboxRows)
      slice.forEach((stored, index) => {
        outboxRows.push({ principal, index, stored })
      })
    // Every row in every state: terminal and dead-lettered entries keep the
    // author's `input` verbatim and are the ones a live-queue scrub misses.
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

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const rewrite of entities.rewrites) {
        const { principal, record } = rewrite.row
        this.db
          .prepare(
            `UPDATE ${ENTITY_TABLE} SET value = ? WHERE principal = ? AND entity = ? AND entity_id = ?`,
          )
          .run(JSON.stringify(rewrite.value), principal, record.entity, record.entityId)
      }
      for (const rewrite of cursors.rewrites) {
        this.db
          .prepare(`UPDATE ${META_TABLE} SET value = ? WHERE principal = ? AND key = ?`)
          .run(JSON.stringify(rewrite.value), rewrite.row.principal, CURSOR_META_KEY)
      }
      for (const rewrite of outbox.rewrites) {
        const { stored } = rewrite.row
        this.db
          .prepare(`UPDATE ${OUTBOX_TABLE} SET record = ? WHERE principal = ? AND mutation_id = ?`)
          .run(JSON.stringify(rewrite.value), stored.principal, stored.mutationId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // As in `commitDraft`: a connection that died mid-transaction cannot roll
        // back and does not need to — the journal undoes it on next open, and the
        // scrub runs again there.
      }
      throw error
    }

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

  /** Publish a committed draft into the mirror. Runs only after COMMIT returned. */
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
      this.autocommit((draft) => {
        for (const principal of principals) {
          this.indexDraft(draft, principal)
          draft.foldIndex.add(principal)
        }
        draft.touchedCache = true
      })
    } catch {
      // Left for the next commit.
    }
  }

  /** POD-7159 — the statements of a draft's index changes, one per key, in its transaction. */
  private stageIndexRows(draft: SpanDraft): void {
    if (draft.indexWritten) return
    draft.indexWritten = true
    for (const [principal, index] of draft.indexes) {
      const changes = indexChanges(index)
      // POD-7160: one journal row per commit; a clear or a re-bucket writes
      // every bucket again after the old rows go, a fold the journal's buckets.
      const writes = planIndexWrite(
        index,
        changes,
        (key, entry) => this.rowForIndex(draft, principal, key, entry),
        draft.foldIndex.has(principal),
      )
      if (writes.deleteAll)
        draft.ops.push({
          sql: `DELETE FROM ${INDEX_TABLE} WHERE principal = ?`,
          params: [principal],
        })
      for (const key of writes.deletes) draft.ops.push(deleteIndexOp(principal, key))
      for (const [key, value] of writes.puts) draft.ops.push(putIndexOp(principal, key, value))
      if (index.indexWrite?.kind === 'journal') this.scheduleIndexFold(principal)
      // An instance's state rides in its marker row.
      if (changes.instances.size > 0) {
        const markers = (draft.metas.get(principal) ?? this.metaOf(principal)).instances
        for (const [key, state] of changes.instances) {
          const marker = markers.get(key)
          if (state === null || marker === undefined) continue
          draft.ops.push(
            metaOp(principal, {
              kind: 'put',
              key: instanceMetaKey(key),
              value: markerWithState(marker, state),
            }),
          )
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

  private prepareSchema(): SchemaVersionMismatch | undefined {
    if (readSchemaVersion(this.db) === REPLICA_SCHEMA_VERSION) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Another opener may have upgraded the file while this one waited for the lock.
      const version = readSchemaVersion(this.db)
      let mismatch: SchemaVersionMismatch | undefined
      if (version !== null && version > REPLICA_SCHEMA_VERSION) {
        mismatch = new SchemaVersionMismatch(version)
        dropSchema(this.db)
      }
      if (version === null || mismatch !== undefined) {
        applySchema(this.db)
        this.writeIndexFlag()
      } else if (version < REPLICA_SCHEMA_VERSION) {
        migrateSchema(this.db, version)
      }
      this.db.exec('COMMIT')
      return mismatch
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Closing a dead connection rolls back its transaction.
      }
      throw error
    }
  }

  /** An empty store's index is built: the flag says so. */
  /** POD-7170: the file keeps stub-level records in their index entries only (its rows hold none). */
  private stubsInIndex = false

  /** Stage, once per store, the flag that says so, with the first stub-level record written. */
  noteStubInIndex(draft: SpanDraft): void {
    if (this.stubsInIndex) return
    this.stubsInIndex = true
    draft.ops.push(metaOp(STORE_PRINCIPAL, { kind: 'put', key: STUBS_IN_INDEX_KEY, value: true }))
  }

  /**
   * POD-7170 — an unreadable index of a file whose stubs live in it: every
   * cached row, marker and index row goes, and the cache starts cold (a first
   * download). The outbox stays: the user's unsent writes are not cache.
   */
  private clearCacheRegion(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`DELETE FROM ${ENTITY_TABLE}`)
      this.db.exec(`DELETE FROM ${META_TABLE}`)
      this.db.exec(`DELETE FROM ${INDEX_TABLE}`)
      this.writeIndexFlag()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A dead connection needs no rollback: the journal undoes it on next open.
      }
      throw error
    }
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    this.stubsInIndex = false
    this.adoptOutboxRows(this.selectOutboxRows())
  }

  private writeIndexFlag(): void {
    this.db
      .prepare(
        `INSERT INTO ${INDEX_TABLE} (principal, key, value) VALUES (?, ?, ?)
         ON CONFLICT(principal, key) DO UPDATE SET value = excluded.value`,
      )
      .run(STORE_PRINCIPAL, INDEX_BUILT_META_KEY, JSON.stringify(INDEX_FORMAT))
  }

  retainsEntity(entity: string): boolean {
    return this.options.retainEntity?.(entity) ?? true
  }

  /**
   * The cold-start read (POD-7159): the metadata, the outbox and the disk
   * index, whole, and NO entity row. Memory then gets the resident set: the
   * policy collections and what they come with (and every row of a device
   * without a policy), read by key. A store without an index (written before
   * version 3, or seeded raw) is rebuilt from its rows once, in one
   * transaction; a crash there repeats the rebuild.
   */
  private async hydrate(): Promise<void> {
    const meta = this.db.prepare(`SELECT principal, key, value FROM ${META_TABLE}`).all() as {
      principal: string
      key: string
      value: string
    }[]
    const stored = this.db.prepare(`SELECT principal, key, value FROM ${INDEX_TABLE}`).all() as {
      principal: string
      key: string
      value: string
    }[]
    const outbox = this.selectOutboxRows()
    const built = stored.some(
      (row) =>
        row.principal === STORE_PRINCIPAL &&
        row.key === INDEX_BUILT_META_KEY &&
        row.value === JSON.stringify(INDEX_FORMAT),
    )
    const buckets: { principal: string; entries: DecodedEntry[] }[] = []
    const counts = new Map<string, number>()
    let readable = built
    const journals: { principal: string; key: string; value: unknown }[] = []
    for (const row of stored) {
      if (row.principal === STORE_PRINCIPAL) continue
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch {
        value = undefined
      }
      // POD-7160: a journal row applies over the buckets, after them.
      if (isJournalKey(row.key)) {
        journals.push({ principal: row.principal, key: row.key, value })
        continue
      }
      const entries = decodeBucket(value)
      if (entries === undefined) readable = false
      else buckets.push({ principal: row.principal, entries })
      counts.set(row.principal, Math.max(counts.get(row.principal) ?? 0, storedBucketCount(value)))
    }
    const journalRows = this.decodeJournals(journals)
    if (journalRows === undefined) readable = false
    const stubsInIndex = meta.some(
      (row) => row.principal === STORE_PRINCIPAL && row.key === STUBS_IN_INDEX_KEY,
    )
    if (!readable) {
      // POD-7170: a file this build wrote keeps stub-level records in the
      // index only, so its rows cannot rebuild it: start the cache cold.
      if (stubsInIndex) this.clearCacheRegion()
      else await this.rebuildIndex()
      return
    }
    this.stubsInIndex = stubsInIndex
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
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
    // Their index entries go with the next write of their bucket.
    if (excluded.length > 0) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const removeRow = this.db.prepare(
          `DELETE FROM ${ENTITY_TABLE} WHERE principal = ? AND entity = ? AND entity_id = ?`,
        )
        for (const row of excluded) {
          const { entity, entityId } = splitRowKey(row.key)
          removeRow.run(row.principal, entity, entityId)
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    for (const principal of new Set([...this.metas.keys(), ...this.indexes.keys()]))
      await this.loadResident(principal, async (keys) => this.readStoredRows(principal, keys))
    this.adoptOutboxRows(outbox)
  }

  private decodeMetas(meta: readonly { principal: string; key: string; value: string }[]): void {
    const metaRows = new Map<string, { key: string; value: unknown }[]>()
    for (const row of meta) {
      if (row.principal === STORE_PRINCIPAL) continue
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch {
        // An unreadable optional row is no marker, never a boot refusal.
        continue
      }
      const rows = metaRows.get(row.principal) ?? []
      rows.push({ key: row.key, value })
      metaRows.set(row.principal, rows)
    }
    for (const [principal, rows] of metaRows) {
      this.metas.set(principal, decodeCacheMeta(rows))
      for (const [key, state] of decodeMarkerStates(rows))
        this.indexOf(principal).putInstance(key, state)
    }
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
    for (const key of [...index.instanceKeys()])
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
   * The index of a store written without one (version 2 or earlier, or rows
   * seeded raw), built once from every row: each record's entry, each
   * marker's members by its rule. One transaction writes it with the flag
   * that says it exists, so a crash before COMMIT leaves the file as it was
   * and the next open builds it again. Nothing is dropped.
   */
  private async rebuildIndex(): Promise<void> {
    const entities = this.db
      .prepare(
        `SELECT principal, entity, entity_id, value, revision, provenance, part, as_of FROM ${ENTITY_TABLE}`,
      )
      .all() as StoredEntityRow[]
    const meta = this.db.prepare(`SELECT principal, key, value FROM ${META_TABLE}`).all() as {
      principal: string
      key: string
      value: string
    }[]
    const outbox = this.selectOutboxRows()
    this.entities.clear()
    this.metas.clear()
    this.indexes.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    this.decodeMetas(meta)
    const now = Date.now()
    const byPrincipal = new Map<string, Map<string, { row: EntityRecord; bytes: number }>>()
    const excluded: StoredEntityRow[] = []
    for (const stored of entities) {
      if (!this.retainsEntity(stored.entity)) {
        excluded.push(stored)
        continue
      }
      const row = entityRecordOf(stored)
      const rows = byPrincipal.get(stored.principal) ?? new Map()
      rows.set(rowKey(row.entity, row.entityId), { row, bytes: stored.value.length + 64 })
      byPrincipal.set(stored.principal, rows)
    }
    // Every row is read here once: scrub them all (POD-419), not only the resident ones.
    const scrubbed = planSecretScrub(
      [...byPrincipal].flatMap(([principal, rows]) =>
        [...rows.values()].map(({ row }) => ({
          address: `entities[${principal}/${row.entity}/${row.entityId}]`,
          row: { principal, record: row },
          value: row.value,
        })),
      ),
    )
    for (const rewrite of scrubbed.rewrites) {
      const { principal, record } = rewrite.row
      const rows = byPrincipal.get(principal)
      const key = rowKey(record.entity, record.entityId)
      const held = rows?.get(key)
      if (held !== undefined) rows?.set(key, { ...held, row: { ...record, value: rewrite.value } })
    }
    this.rebuildScrub = { ...scrubbed.report, scanned: 0 }
    const puts: SqlOp[] = []
    for (const principal of new Set([...byPrincipal.keys(), ...this.metas.keys()])) {
      const rows =
        byPrincipal.get(principal) ?? new Map<string, { row: EntityRecord; bytes: number }>()
      const cacheMeta = this.metaOf(principal)
      const index = this.indexOf(principal)
      const records = new Map<string, EntityRecord>()
      for (const [key, { row }] of rows) records.set(key, row)
      const built = buildIndex({
        rows: records,
        bytes: (key) => rows.get(key)?.bytes ?? 64,
        markers: cacheMeta.instances,
        policy: cacheMeta.policy,
        now,
      })
      const mirror = this.mirrorOf(principal)
      const buckets = new Map<number, (readonly [string, RecordEntry, EntityRecord])[]>()
      // POD-7160: buckets of a bounded size, as many as the records need.
      const count = bucketCountFor(built.entries.size)
      index.setBucketCount(count)
      for (const [key, entry] of built.entries) {
        const row = records.get(key) as EntityRecord
        index.putRecord(key, entry)
        const bucket = bucketOf(key, count)
        const list = buckets.get(bucket)
        if (list === undefined) buckets.set(bucket, [[key, entry, row]])
        else list.push([key, entry, row])
        if (row.part === 'stub') mirror.set(key, row)
        else mirror.putStubOf(row.entity, row.entityId, row.value)
      }
      for (const [bucket, entries] of buckets)
        puts.push(putIndexOp(principal, indexBucketKey(bucket), encodeBucket(entries, count)))
      for (const [key, state] of built.states) {
        index.putInstance(key, state)
        const marker = cacheMeta.instances.get(key)
        if (marker !== undefined)
          puts.push(
            metaOp(principal, {
              kind: 'put',
              key: instanceMetaKey(key),
              value: markerWithState(marker, state),
            }),
          )
      }
      // What a record comes with is recorded on it now, not as markers of its own.
      if (built.comesWithMarkers.length > 0) {
        const gone = new Set(built.comesWithMarkers)
        for (const key of gone)
          puts.push(metaOp(principal, { kind: 'delete', key: instanceMetaKey(key) }))
        this.metas.set(principal, {
          ...cacheMeta,
          instances: new Map([...cacheMeta.instances].filter(([key]) => !gone.has(key))),
        })
      }
    }
    try {
      this.db.exec('BEGIN IMMEDIATE')
      // A rebuild interrupted earlier left nothing (it is one transaction), but
      // a store seeded raw may hold stray entries: start clean.
      this.db.exec(`DELETE FROM ${INDEX_TABLE}`)
      const removeRow = this.db.prepare(
        `DELETE FROM ${ENTITY_TABLE} WHERE principal = ? AND entity = ? AND entity_id = ?`,
      )
      for (const row of excluded) removeRow.run(row.principal, row.entity, row.entity_id)
      for (const rewrite of scrubbed.rewrites) {
        const { principal, record } = rewrite.row
        this.db
          .prepare(
            `UPDATE ${ENTITY_TABLE} SET value = ? WHERE principal = ? AND entity = ? AND entity_id = ?`,
          )
          .run(JSON.stringify(rewrite.value), principal, record.entity, record.entityId)
      }
      for (const op of puts) this.db.prepare(op.sql).run(...op.params)
      this.writeIndexFlag()
      this.db.exec('COMMIT')
    } catch {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A dead connection needs no rollback: the journal undoes it on next open.
      }
      // The index could not be written (rolled back whole, so the file is as
      // it was): this session keeps every row in memory, as a store without an
      // index did, and the next open builds it again.
      for (const [principal, rows] of byPrincipal) {
        installResidentRows(
          this.mirrorOf(principal),
          this.indexOf(principal),
          [...rows.values()].map(({ row }) => row).filter((row) => row.part !== 'stub'),
        )
        this.indexOf(principal).setInMemory(this.metaOf(principal).instances.keys(), true)
      }
      this.adoptOutboxRows(outbox)
      return
    }
    for (const [principal, rows] of byPrincipal)
      await this.loadResident(principal, async (keys) =>
        keys.flatMap((key) => {
          const held = rows.get(key)
          return held === undefined ? [] : [held.row]
        }),
      )
    for (const principal of this.metas.keys())
      if (!byPrincipal.has(principal)) await this.loadResident(principal, async () => [])
    this.adoptOutboxRows(outbox)
  }

  /**
   * POD-7159 — rows of one principal read from disk by key, a few `IN (…)`
   * lists per record type. Synchronous: every commit has already returned.
   * Secret material an earlier build left is removed from what is read, and
   * from the file.
   */
  readStoredRows(principal: string, keys: readonly string[]): EntityRecord[] {
    if (keys.length === 0) return []
    this.guardReadable()
    if (this.durability() === 'unavailable') return []
    const byEntity = new Map<string, string[]>()
    for (const key of keys) {
      const { entity, entityId } = splitRowKey(key)
      const ids = byEntity.get(entity)
      if (ids === undefined) byEntity.set(entity, [entityId])
      else ids.push(entityId)
    }
    const rows: EntityRecord[] = []
    for (const [entity, ids] of byEntity)
      for (let at = 0; at < ids.length; at += IN_LIST_MAX) {
        const chunk = ids.slice(at, at + IN_LIST_MAX)
        const found = this.db
          .prepare(
            `SELECT principal, entity, entity_id, value, revision, provenance, part, as_of FROM ${ENTITY_TABLE}
             WHERE principal = ? AND entity = ? AND entity_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(principal, entity, ...chunk) as StoredEntityRow[]
        for (const row of found) rows.push(entityRecordOf(row))
      }
    const scrub = planSecretScrub(
      rows.map((record, at) => ({
        address: `entities[${principal}/${record.entity}/${record.entityId}]`,
        row: at,
        value: record.value,
      })),
    )
    if (scrub.rewrites.length === 0) return rows
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const rewrite of scrub.rewrites) {
        const record = rows[rewrite.row] as EntityRecord
        rows[rewrite.row] = { ...record, value: rewrite.value }
        this.db
          .prepare(
            `UPDATE ${ENTITY_TABLE} SET value = ? WHERE principal = ? AND entity = ? AND entity_id = ?`,
          )
          .run(JSON.stringify(rewrite.value), principal, record.entity, record.entityId)
      }
      this.db.exec('COMMIT')
    } catch {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // See `commitDraft`.
      }
    }
    return rows
  }

  /**
   * BY ORDINAL, not by primary key. SQLite hands rows back in PK order when asked
   * for none, which for the outbox is `mutation_id` order — so hydrating without
   * this would silently re-order the queue on every cold start and break ADR 3
   * D12's FIFO. On mobile a cold start is routine, not exceptional.
   */
  private selectOutboxRows(): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT principal, mutation_id, ordinal, record FROM ${OUTBOX_TABLE} ORDER BY ordinal ASC`,
      )
      .all() as OutboxRow[]
  }

  /**
   * Replace the outbox mirror with durable rows. `nextOrdinal` only ever grows
   * here: `hydrate` zeroes it first, so a cold read is unchanged, and an
   * outbox-only re-read must not hand out an ordinal already taken.
   */
  private adoptOutboxRows(outbox: readonly OutboxRow[]): void {
    this.outboxRows.clear()
    for (const row of outbox) {
      const slice = this.outboxRows.get(row.principal) ?? []
      slice.push({
        principal: row.principal,
        mutationId: row.mutation_id,
        ordinal: row.ordinal,
        record: JSON.parse(row.record) as unknown,
      })
      this.outboxRows.set(row.principal, slice)
      this.nextOrdinal = Math.max(this.nextOrdinal, row.ordinal + 1)
    }
  }

  // ── mirror accessors used by the views ───────────────────────────────────

  guardReadable(): void {
    if (this.corrupt) throw new ReplicaStoreCorruptError()
  }

  entitiesOf(principal: string): RowMirror {
    return this.entities.get(principal) ?? new RowMirror()
  }

  metaOf(principal: string): CacheMeta {
    return this.metas.get(principal) ?? EMPTY_CACHE_META
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

/** A store written by a build that knew a different layout (D5.1, forward-only). */
export class SchemaVersionMismatch extends Error {
  constructor(readonly found: number) {
    super(
      `replica database is at schema version ${found}, this build knows ${REPLICA_SCHEMA_VERSION} — clearing and cold starting (ADR 6 D5.1/D6)`,
    )
    this.name = 'SchemaVersionMismatch'
  }
}

/**
 * One principal's two ports.
 *
 * `cache` has no outbox method, so `discardCache()` CANNOT reach the queue — the
 * structural defence `replica/ports.ts` exists to hold, carried through to the
 * durable adapter. A discard stages deletions for this principal's ENTITY and CURSOR
 * rows only, and the `outbox` table is not among the ones it names.
 */
export class SqliteStoreView {
  readonly cache: ReplicaCacheStore
  readonly outbox: OutboxStorePort

  constructor(
    store: SqliteSyncStore,
    private readonly principal: string,
  ) {
    this.cache = new SqliteCacheStore(store, principal)
    this.outbox = new SqliteOutboxStore(store, principal)
  }

  /** The principal this pair is bound to. Diagnostics only; nothing branches on it. */
  get boundTo(): string {
    return this.principal
  }
}

class SqliteCacheStore implements ReplicaCacheStore {
  constructor(
    private readonly store: SqliteSyncStore,
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

  async readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]> {
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
    // Degraded, memory is ahead of the file: nothing may leave it.
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
    // A lone single-region write may autocommit (D10 clause 2). It reaches SQLite
    // synchronously, so by the time this `void` method returns the row is durable —
    // there is no window in which the caller could read back something that is not.
    this.store.autocommit((draft) => {
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
      draft.ops.push({
        sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ?`,
        params: [this.principal],
      })
      const index = this.store.indexDraft(draft, this.principal)
      index.clearAll()
      const next = new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror())
      draft.diskOnly.delete(this.principal)
      draft.entities.set(this.principal, next)
      draft.touchedCache = true
      for (const row of rows) {
        if (!this.store.retainsEntity(row.entity)) continue
        const key = rowKey(row.entity, row.entityId)
        next.set(key, row)
        const op = upsertEntityOp(this.principal, row)
        index.row(key, row, undefined, sizeOf(op))
        // POD-7170: a stub lives in its index entry only.
        if (row.part !== 'stub') draft.ops.push(op)
        else this.store.noteStubInIndex(draft)
      }
      // The markers and policy described the rows this replaces.
      this.resetMeta(draft)
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
    this.store.autocommit(install)
  }

  discardCache(): void {
    this.store.guardReadable()
    // Reaches entities and the cache's metadata. The `outbox` table is not named
    // here, and there is no method on this port through which it could be.
    this.store.autocommit((draft) => {
      draft.diskOnly.delete(this.principal)
      draft.entities.set(
        this.principal,
        new ChangedKeyDraft<EntityRecord, RowMirror>(new RowMirror()),
      )
      draft.ops.push({
        sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ?`,
        params: [this.principal],
      })
      this.store.indexDraft(draft, this.principal).clearAll()
      this.resetMeta(draft)
      draft.touchedCache = true
    })
  }

  durability(): DurabilityMode {
    return this.store.durability()
  }

  private stage(draft: SpanDraft, mutation: CacheMutation): void {
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

  /** Forget the cursor, markers, policy and load state: every metadata row of this principal. */
  private resetMeta(draft: SpanDraft): void {
    draft.ops.push({
      sql: `DELETE FROM ${META_TABLE} WHERE principal = ?`,
      params: [this.principal],
    })
    draft.metas.set(this.principal, EMPTY_CACHE_META)
    draft.touchedCache = true
  }

  /** The cursor, markers, policy and load state a mutation leaves, staged with their writes. */
  private stageMeta(draft: SpanDraft, mutation: CacheMutation): void {
    const before = draft.metas.get(this.principal) ?? this.store.metaOf(this.principal)
    const next = nextCacheMeta(before, mutation)
    if (next.writes.length === 0) return
    for (const write of next.writes) draft.ops.push(metaOp(this.principal, write))
    draft.metas.set(this.principal, next.meta)
    draft.touchedCache = true
  }

  /**
   * IN ORDER, never grouped by kind. A frame carrying `remove(seq 1)` then
   * `upsert(seq 2)` for one entity must leave it PRESENT, and the staged statements
   * are appended in the same order so the transaction reproduces it exactly (ADR 2
   * D9/D13 — order is the correctness property).
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
        const statement = upsertEntityOp(this.principal, row)
        const before = index.record(key)?.level
        index.row(key, row, op.kind === 'upsert' ? op.holders : undefined, sizeOf(statement))
        if (row.part !== 'stub') draft.ops.push(statement)
        else {
          // POD-7170: a stub-level record has no entity row (its index entry
          // stores the stub); one taken back to its stub drops its whole row.
          this.store.noteStubInIndex(draft)
          if (before === 'main')
            draft.ops.push({
              sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ? AND entity = ? AND entity_id = ?`,
              params: [this.principal, op.entity, op.entityId],
            })
        }
        continue
      }
      index.row(key, null)
      // `remove` (tombstone, global) and `evict` (this principal's view only) both
      // drop the row from THIS principal's slice — and under a per-principal keyspace
      // that is the whole difference, because an evict must not touch anybody else's
      // copy. Amendment 1 D14.5's distinction is preserved upstream in the envelope's
      // op and, for the port, by `cacheOperations()`.
      slice.delete(key)
      draft.ops.push({
        sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ? AND entity = ? AND entity_id = ?`,
        params: [this.principal, op.entity, op.entityId],
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

/** The statement of one metadata write. */
function metaOp(principal: string, write: MetaWrite): SqlOp {
  if (write.kind === 'put')
    return {
      sql: `INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)
            ON CONFLICT(principal, key) DO UPDATE SET value = excluded.value`,
      params: [principal, write.key, JSON.stringify(write.value)],
    }
  if (write.kind === 'delete')
    return {
      sql: `DELETE FROM ${META_TABLE} WHERE principal = ? AND key = ?`,
      params: [principal, write.key],
    }
  return {
    sql: `DELETE FROM ${META_TABLE} WHERE principal = ? AND key >= ? AND key < ?`,
    params: [principal, INSTANCE_META_PREFIX, INSTANCE_META_END],
  }
}

class SqliteOutboxStore implements OutboxStorePort {
  constructor(
    private readonly store: SqliteSyncStore,
    private readonly principal: string,
  ) {}

  /**
   * The fresh-truth read — at open, and before every kernel Outbox state change.
   *
   * It re-reads the outbox table from SQLite first, and that is what makes a
   * recovery in a test an honest one: a read that only returned the mirror would
   * report what a surviving object still held rather than what committed — and
   * what lets a rebase see another connection's committed work. ONLY the outbox
   * table, never the entity rows (POD-4810): see `rehydrateOutbox`. It refuses
   * while degraded, so it can never roll the mirror back past work the session is
   * holding in memory by design.
   */
  async read(): Promise<readonly OutboxRecord[]> {
    this.store.guardReadable()
    this.store.rehydrateOutbox()
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
    this.store.autocommit((draft) => {
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
      draft.ops.push({
        sql: `DELETE FROM ${OUTBOX_TABLE} WHERE principal = ? AND mutation_id = ?`,
        params: [this.principal, id],
      })
    }
    for (const record of mutation.put ?? []) {
      const at = rows.findIndex((row) => row.mutationId === record.mutationId)
      // A replacing put KEEPS the record's existing position (the port's stated
      // contract); only a first put appends. Reusing the ordinal is what carries that
      // across a cold start.
      const ordinal = at >= 0 ? (rows[at] as StoredOutboxRecord).ordinal : this.store.takeOrdinal()
      const serialized = JSON.stringify(record)
      const row: StoredOutboxRecord = {
        principal: this.principal,
        mutationId: record.mutationId,
        ordinal,
        // Through a JSON round trip, because that is what the column holds: anything
        // that survives only by object identity fails here the same way it would on
        // device, which is the class of bug ADR 6 D4 exists to catch.
        record: JSON.parse(serialized) as unknown,
      }
      if (at >= 0) rows[at] = row
      else rows.push(row)
      draft.ops.push({
        sql: `INSERT INTO ${OUTBOX_TABLE} (principal, mutation_id, ordinal, record) VALUES (?, ?, ?, ?)
              ON CONFLICT(principal, mutation_id) DO UPDATE SET ordinal = excluded.ordinal, record = excluded.record`,
        params: [this.principal, record.mutationId, ordinal, serialized],
      })
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

/** An entity row as SQLite gives it back. */
interface StoredEntityRow {
  principal: string
  entity: string
  entity_id: string
  value: string
  revision: number | null
  provenance: string
  part: string | null
  as_of: number | null
}

/** A stored row, as the port's record. A row without provenance is no row of this file. */
function entityRecordOf(row: StoredEntityRow): EntityRecord {
  if (row.provenance === null)
    throw new Error(`entity row ${row.entity}/${row.entity_id} has no provenance`)
  return {
    entity: row.entity,
    entityId: row.entity_id,
    value: JSON.parse(row.value) as unknown,
    revision: row.revision ?? undefined,
    provenance: JSON.parse(row.provenance) as EntityRecord['provenance'],
    ...(row.part === 'stub' ? { part: 'stub' as const } : {}),
    ...(typeof row.as_of === 'number' ? { asOf: row.as_of } : {}),
  }
}

/** The stored size of an entity statement's row: its serialized value. */
const sizeOf = (op: SqlOp): number => {
  const value = op.params[3]
  return (typeof value === 'string' ? value.length : 0) + 64
}

const putIndexOp = (principal: string, key: string, value: unknown): SqlOp => ({
  sql: `INSERT INTO ${INDEX_TABLE} (principal, key, value) VALUES (?, ?, ?)
        ON CONFLICT(principal, key) DO UPDATE SET value = excluded.value`,
  params: [principal, key, JSON.stringify(value)],
})

const deleteIndexOp = (principal: string, key: string): SqlOp => ({
  sql: `DELETE FROM ${INDEX_TABLE} WHERE principal = ? AND key = ?`,
  params: [principal, key],
})

const upsertEntityOp = (principal: string, row: EntityRecord): SqlOp => ({
  sql: `INSERT INTO ${ENTITY_TABLE} (principal, entity, entity_id, value, revision, provenance, part, as_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(principal, entity, entity_id) DO UPDATE SET
          value = excluded.value, revision = excluded.revision, provenance = excluded.provenance,
          part = excluded.part, as_of = excluded.as_of`,
  params: [
    principal,
    row.entity,
    row.entityId,
    JSON.stringify(row.value),
    row.revision ?? null,
    JSON.stringify(row.provenance),
    row.part ?? null,
    row.asOf ?? null,
  ],
})

/** The stand-in for "there is no usable SQLite here" — every call throws, nothing is durable. */
function unavailableDatabase(): SqlDatabaseLike {
  const refuse = (): never => {
    throw new Error('SQLite is unavailable')
  }
  return {
    prepare: refuse,
    exec: refuse,
    close: () => undefined,
  }
}

/** Named for the tables one transaction must span; re-exported for the suites. */
export { ALL_TABLES }

/** POD-7170: the store-wide meta row that says stub-level records live in the index only. */
const STUBS_IN_INDEX_KEY = 'stubs-in-index'
