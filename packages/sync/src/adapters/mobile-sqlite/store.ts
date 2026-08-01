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

import type { MutationId } from '@podium/protocol'
import type {
  OutboxApplyResult,
  OutboxRecordExpectation,
  OutboxStoreMutation,
  OutboxStorePort,
} from '../../outbox/ports'
import type { OutboxRecord } from '../../outbox/records'
import type {
  CacheMutation,
  OwnedSyncSpan,
  ReplicaCacheStore,
  SyncSpan,
  SyncSpanParticipant,
  SyncUnitOfWork,
} from '../../replica/ports'
import { ReplicaStoreCorruptError } from '../../replica/ports'
import type { Cursor, EntityRecord } from '../../replica/types'
import { SyncCommitConflict } from '../../span'
import { mergeScrubReports, planSecretScrub, type SecretScrubReport } from '../secret-scrub'
import {
  ALL_TABLES,
  applySchema,
  CURSOR_KEY,
  dropSchema,
  ENTITY_TABLE,
  META_TABLE,
  OUTBOX_TABLE,
  readSchemaVersion,
  REPLICA_SCHEMA_VERSION,
  type StoredOutboxRecord,
} from './schema'
import { isQuotaError, type SqlDatabaseLike, type SqlValue } from './sql'

/** The mirror's composite key. The separator is written as an ESCAPE and never as a
 *  literal NUL: a raw 0x00 makes the file binary, so `grep -n` and agent search
 *  wrappers answer "no match" for code that is right there (scripts/check-no-nul-bytes.ts,
 *  which is what caught it here). A NUL is still the right separator, because an
 *  entity kind containing the delimiter would otherwise collide two distinct keys. */
const rowKey = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

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
  /** Open (or create) the replica database file. Called again after a poison clear. */
  readonly openDatabase: () => SqlDatabaseLike
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
  /** REQUIRED — see {@link DurabilityDegradation}. */
  readonly onDegraded: (degradation: DurabilityDegradation) => void
  /** Called after every open with what the secret scrub found (POD-419).
   *  Optional, and deliberately not the mechanism anything depends on — see the
   *  same option on the IndexedDB adapter. */
  readonly onSecretsScrubbed?: (report: SecretScrubReport) => void
}

/** One staged SQL statement, issued into the commit transaction verbatim and IN ORDER. */
interface SqlOp {
  readonly sql: string
  readonly params: SqlValue[]
}

/** The post-state one span has staged, per region, plus the statements that produce it. */
interface SpanDraft {
  /** principal → key → row. Absent principal means "untouched". */
  readonly entities: Map<string, Map<string, EntityRecord>>
  readonly cursors: Map<string, Cursor | null>
  readonly outbox: Map<string, StoredOutboxRecord[]>
  readonly ops: SqlOp[]
  /** Re-checked inside the native transaction against durable rows (D4.6). */
  readonly expectations: { principal: string; expectation: OutboxRecordExpectation }[]
  touchedCache: boolean
  touchedOutbox: boolean
}

const newDraft = (): SpanDraft => ({
  entities: new Map(),
  cursors: new Map(),
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
  /** Flipped by the corruption injector and by a hydrate that could not decode. */
  private corrupt = false
  private readonly entities = new Map<string, Map<string, EntityRecord>>()
  private readonly cursors = new Map<string, Cursor | null>()
  private readonly outboxRows = new Map<string, StoredOutboxRecord[]>()
  private readonly views = new Map<string, SqliteStoreView>()
  private readonly drafts = new Map<SqlSpan, SpanDraft>()
  private nextOrdinal = 0
  /** Spans opened by `unitOfWork.transact`, so `cacheWrites` can exclude them. */
  private readonly transactSpans = new WeakSet<SqlSpan>()

  transactCount = 0
  outboxCommits = 0
  cacheCommits = 0

  private constructor(
    private db: SqlDatabaseLike,
    private readonly options: SqliteStoreOptions,
  ) {}

  /**
   * Open, version-check and hydrate.
   *
   * D4.5 — a store that cannot be opened or decoded is CLEARED and the client cold
   * starts. Boot never wedges and nothing throws past this boundary: a poisoned
   * store that threw here would take the whole app down on launch, which is strictly
   * worse than re-bootstrapping from the Authority. On mobile that matters more than
   * on web, because the user cannot open devtools and clear it themselves.
   */
  static async open(options: SqliteStoreOptions): Promise<SqliteSyncStore> {
    let db: SqlDatabaseLike
    try {
      db = options.openDatabase()
    } catch (error) {
      // The file exists and is not a database this driver will open at all.
      const recovered = recoverFile(options, error)
      if (recovered.kind === 'unavailable') {
        const store = new SqliteSyncStore(unavailableDatabase(), options)
        store.degrade('unavailable', 'unavailable', recovered.error)
        return store
      }
      const store = new SqliteSyncStore(recovered.db, options)
      store.initializeFresh()
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error })
      store.mode = 'durable'
      return store
    }

    const store = new SqliteSyncStore(db, options)
    try {
      const version = readSchemaVersion(db)
      if (version === null) {
        // A brand-new file, or one this adapter has never written. Nothing to lose.
        store.initializeFresh()
      } else if (version !== REPLICA_SCHEMA_VERSION) {
        // FORWARD-ONLY (D5.1). A higher version was written by a build that knew
        // more than this one; a lower one has no upgrade arm at version 1. Both take
        // D6's upgrade-or-rebootstrap posture rather than reading a layout they do
        // not understand — and this is where a future version's migration goes.
        throw new SchemaVersionMismatch(version)
      }
      store.hydrate()
      // POD-419: material written by an EARLIER build is removed before this
      // store answers its first read. See `../secret-scrub.ts` for why this runs
      // on every open rather than in a version-gated arm — and note that the
      // version arm above would not have caught it anyway: an upgrade that
      // rebootstraps drops the rows, but a store already AT this version never
      // enters it.
      store.scrubSecrets()
      return store
    } catch (error) {
      // Version mismatch, decode failure, or an unreadable table: clear the whole
      // replica database and proceed as a cold client (D4.5). The outbox is lost with
      // it, which is why this path is LOUD rather than silent.
      try {
        store.clearAll()
      } catch {
        const recovered = recoverFile(options, error)
        if (recovered.kind === 'unavailable') {
          const unavailable = new SqliteSyncStore(unavailableDatabase(), options)
          unavailable.degrade('unavailable', 'unavailable', recovered.error)
          return unavailable
        }
        store.db = recovered.db
        store.initializeFresh()
      }
      options.onDegraded({ mode: 'degraded-memory', cause: 'corrupt', error })
      store.mode = 'durable'
      return store
    }
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
      draft.entities.set(principal, new Map())
      draft.cursors.set(principal, null)
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
  rehydrate(): void {
    if (this.durability() !== 'durable') return
    this.hydrate()
  }

  /** Test/injector seam: ADR 6 D4.5 / ADR 2 D7 rung 5 — the store cannot be read. */
  setCorrupt(corrupt: boolean): void {
    this.corrupt = corrupt
  }

  close(): void {
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
      [...this.cursors].map(([principal, value]) => ({
        address: `meta[${principal}/${CURSOR_KEY}]`,
        row: { principal },
        value,
      })),
    )

    const outboxRows: { principal: string; index: number; stored: StoredOutboxRecord }[] = []
    for (const [principal, slice] of this.outboxRows)
      slice.forEach((stored, index) => outboxRows.push({ principal, index, stored }))
    // Every row in every state: terminal and dead-lettered entries keep the
    // author's `input` verbatim and are the ones a live-queue scrub misses.
    const outbox = planSecretScrub(
      outboxRows.map((row) => ({
        address: `outbox[${row.principal}/${row.stored.mutationId}]`,
        row,
        value: row.stored.record,
      })),
    )

    const report = mergeScrubReports(entities.report, cursors.report, outbox.report)
    if (report.rewritten === 0) {
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
          .run(JSON.stringify(rewrite.value), rewrite.row.principal, CURSOR_KEY)
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
      this.cursors.set(rewrite.row.principal, rewrite.value as Cursor | null)
    for (const rewrite of outbox.rewrites) {
      const { principal, index, stored } = rewrite.row
      const slice = this.outboxRows.get(principal)
      if (slice) slice[index] = { ...stored, record: rewrite.value }
    }
    this.options.onSecretsScrubbed?.(report)
  }

  /** Swap a committed draft into the mirror. Runs only after COMMIT returned. */
  private applyDraftToMirror(draft: SpanDraft): void {
    for (const [principal, rows] of draft.entities) this.entities.set(principal, rows)
    for (const [principal, cursor] of draft.cursors) this.cursors.set(principal, cursor)
    for (const [principal, rows] of draft.outbox) this.outboxRows.set(principal, rows)
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

  private initializeFresh(): void {
    applySchema(this.db)
    this.entities.clear()
    this.cursors.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
  }

  private hydrate(): void {
    const entities = this.db
      .prepare(
        `SELECT principal, entity, entity_id, value, revision, provenance FROM ${ENTITY_TABLE}`,
      )
      .all() as {
      principal: string
      entity: string
      entity_id: string
      value: string
      revision: number | null
      provenance: string
    }[]
    const meta = this.db.prepare(`SELECT principal, key, value FROM ${META_TABLE}`).all() as {
      principal: string
      key: string
      value: string
    }[]
    // BY ORDINAL, not by primary key. SQLite hands rows back in PK order when asked
    // for none, which for the outbox is `mutation_id` order — so hydrating without
    // this would silently re-order the queue on every cold start and break ADR 3
    // D12's FIFO. On mobile a cold start is routine, not exceptional.
    const outbox = this.db
      .prepare(
        `SELECT principal, mutation_id, ordinal, record FROM ${OUTBOX_TABLE} ORDER BY ordinal ASC`,
      )
      .all() as { principal: string; mutation_id: string; ordinal: number; record: string }[]

    this.entities.clear()
    this.cursors.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    for (const row of entities) {
      // The column is NOT NULL, so this is unreachable in a well-formed file — and a
      // file where it fires is not one. Throwing takes the D4.5 path (clear and cold
      // start) instead of quietly hydrating an entity with no provenance, which the
      // port's type says cannot exist.
      if (row.provenance === null) {
        throw new Error(`entity row ${row.entity}/${row.entity_id} has no provenance`)
      }
      const slice = this.entities.get(row.principal) ?? new Map<string, EntityRecord>()
      slice.set(rowKey(row.entity, row.entity_id), {
        entity: row.entity,
        entityId: row.entity_id,
        value: JSON.parse(row.value) as unknown,
        revision: row.revision ?? undefined,
        provenance: JSON.parse(row.provenance) as EntityRecord['provenance'],
      })
      this.entities.set(row.principal, slice)
    }
    for (const row of meta) {
      if (row.key === CURSOR_KEY) this.cursors.set(row.principal, JSON.parse(row.value) as Cursor)
    }
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

  private clearAll(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      dropSchema(this.db)
      applySchema(this.db)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // See `commitDraft`: a dead connection needs no rollback.
      }
      throw error
    }
    this.entities.clear()
    this.cursors.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
  }

  // ── mirror accessors used by the views ───────────────────────────────────

  guardReadable(): void {
    if (this.corrupt) throw new ReplicaStoreCorruptError()
  }

  entitiesOf(principal: string): Map<string, EntityRecord> {
    return this.entities.get(principal) ?? new Map()
  }

  cursorOf(principal: string): Cursor | null {
    return this.cursors.get(principal) ?? null
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
    return this.store.cursorOf(this.principal)
  }

  readEntities(): readonly EntityRecord[] {
    this.store.guardReadable()
    return [...this.store.entitiesOf(this.principal).values()]
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    this.store.guardReadable()
    return this.store.entitiesOf(this.principal).get(rowKey(entity, entityId))
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
      const next = new Map<string, EntityRecord>()
      draft.entities.set(this.principal, next)
      draft.touchedCache = true
      for (const row of rows) {
        next.set(rowKey(row.entity, row.entityId), row)
        draft.ops.push(upsertEntityOp(this.principal, row))
      }
      let head = cursor
      for (const mutation of buffered) {
        this.applyOperations(draft, next, mutation)
        if (mutation.cursor !== undefined) head = mutation.cursor
      }
      this.setCursor(draft, head)
    }
    if (span !== undefined) {
      install(this.store.draftFor(span))
      return
    }
    this.store.autocommit(install)
  }

  discardCache(): void {
    this.store.guardReadable()
    // Reaches entities and the cursor. The `outbox` table is not named here, and
    // there is no method on this port through which it could be.
    this.store.autocommit((draft) => {
      draft.entities.set(this.principal, new Map())
      draft.cursors.set(this.principal, null)
      draft.ops.push({
        sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ?`,
        params: [this.principal],
      })
      draft.ops.push({
        sql: `DELETE FROM ${META_TABLE} WHERE principal = ? AND key = ?`,
        params: [this.principal, CURSOR_KEY],
      })
      draft.touchedCache = true
    })
  }

  durability(): DurabilityMode {
    return this.store.durability()
  }

  private stage(draft: SpanDraft, mutation: CacheMutation): void {
    const slice = this.slice(draft)
    this.applyOperations(draft, slice, mutation)
    if (mutation.cursor !== undefined) this.setCursor(draft, mutation.cursor)
  }

  /**
   * IN ORDER, never grouped by kind. A frame carrying `remove(seq 1)` then
   * `upsert(seq 2)` for one entity must leave it PRESENT, and the staged statements
   * are appended in the same order so the transaction reproduces it exactly (ADR 2
   * D9/D13 — order is the correctness property).
   */
  private applyOperations(
    draft: SpanDraft,
    slice: Map<string, EntityRecord>,
    mutation: CacheMutation,
  ): void {
    draft.touchedCache = true
    for (const op of mutation.operations) {
      if (op.kind === 'upsert') {
        const row: EntityRecord = {
          entity: op.entity,
          entityId: op.entityId,
          value: op.value,
          revision: op.revision,
          provenance: op.provenance,
        }
        slice.set(rowKey(op.entity, op.entityId), row)
        draft.ops.push(upsertEntityOp(this.principal, row))
        continue
      }
      // `remove` (tombstone, global) and `evict` (this principal's view only) both
      // drop the row from THIS principal's slice — and under a per-principal keyspace
      // that is the whole difference, because an evict must not touch anybody else's
      // copy. Amendment 1 D14.5's distinction is preserved upstream in the envelope's
      // op and, for the port, by `cacheOperations()`.
      slice.delete(rowKey(op.entity, op.entityId))
      draft.ops.push({
        sql: `DELETE FROM ${ENTITY_TABLE} WHERE principal = ? AND entity = ? AND entity_id = ?`,
        params: [this.principal, op.entity, op.entityId],
      })
    }
  }

  private setCursor(draft: SpanDraft, cursor: Cursor): void {
    draft.cursors.set(this.principal, cursor)
    draft.touchedCache = true
    draft.ops.push({
      sql: `INSERT INTO ${META_TABLE} (principal, key, value) VALUES (?, ?, ?)
            ON CONFLICT(principal, key) DO UPDATE SET value = excluded.value`,
      params: [this.principal, CURSOR_KEY, JSON.stringify(cursor)],
    })
  }

  /** This principal's rows as the draft has them so far, copied on first touch. */
  private slice(draft: SpanDraft): Map<string, EntityRecord> {
    const staged = draft.entities.get(this.principal)
    if (staged !== undefined) return staged
    const copy = new Map(this.store.entitiesOf(this.principal))
    draft.entities.set(this.principal, copy)
    return copy
  }
}

class SqliteOutboxStore implements OutboxStorePort {
  constructor(
    private readonly store: SqliteSyncStore,
    private readonly principal: string,
  ) {}

  /**
   * The cold-start read.
   *
   * It rehydrates from SQLite first, and that is what makes a recovery in a test an
   * honest one: a read that only returned the mirror would report what a surviving
   * object still held rather than what committed. `rehydrate()` refuses while
   * degraded, so it can never roll the mirror back past work the session is holding
   * in memory by design.
   */
  async read(): Promise<readonly OutboxRecord[]> {
    this.store.guardReadable()
    this.store.rehydrate()
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

const upsertEntityOp = (principal: string, row: EntityRecord): SqlOp => ({
  sql: `INSERT INTO ${ENTITY_TABLE} (principal, entity, entity_id, value, revision, provenance)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(principal, entity, entity_id) DO UPDATE SET
          value = excluded.value, revision = excluded.revision, provenance = excluded.provenance`,
  params: [
    principal,
    row.entity,
    row.entityId,
    JSON.stringify(row.value),
    row.revision ?? null,
    JSON.stringify(row.provenance),
  ],
})

/** Delete the file and open a fresh one; report whether that was possible at all. */
function recoverFile(
  options: SqliteStoreOptions,
  cause: unknown,
): { kind: 'db'; db: SqlDatabaseLike } | { kind: 'unavailable'; error: unknown } {
  try {
    options.deleteDatabase()
    return { kind: 'db', db: options.openDatabase() }
  } catch (fatal) {
    return { kind: 'unavailable', error: fatal ?? cause }
  }
}

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
