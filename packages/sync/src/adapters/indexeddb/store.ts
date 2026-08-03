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
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbTransactionLike,
  isQuotaError,
  requestAsPromise,
} from './idb'
import {
  ALL_STORES,
  CURSOR_KEY,
  ENTITY_STORE,
  META_STORE,
  OUTBOX_STORE,
  REPLICA_DB_NAME,
  REPLICA_SCHEMA_VERSION,
  type StoredEntity,
  type StoredMeta,
  type StoredOutboxRecord,
  upgradeSchema,
} from './schema'

const rowKey = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

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

export interface IndexedDbStoreOptions {
  readonly factory: IdbFactoryLike
  readonly databaseName?: string
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
  | { readonly kind: 'delete'; readonly store: string; readonly key: readonly unknown[] }

/** The post-state one span has staged, per region, plus the durable operations that produce it. */
interface SpanDraft {
  /** principal → key → row. Absent principal means "untouched". */
  readonly entities: Map<string, Map<string, EntityRecord>>
  readonly cursors: Map<string, Cursor | null>
  readonly outbox: Map<string, StoredOutboxRecord[]>
  readonly ops: IdbOp[]
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
export class IndexedDbSyncStore {
  private mode: DurabilityMode = 'durable'
  /** Flipped by the corruption injector and by a hydrate that could not decode. */
  private corrupt = false
  private readonly entities = new Map<string, Map<string, EntityRecord>>()
  private readonly cursors = new Map<string, Cursor | null>()
  private readonly outboxRows = new Map<string, StoredOutboxRecord[]>()
  private readonly views = new Map<string, IndexedDbStoreView>()
  private nextOrdinal = 0
  /** Serializes durable commits. Two transactions interleaving is the one race D10 forbids. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Spans opened by `unitOfWork.transact`, so `cacheWrites` can exclude them. */
  private readonly transactSpans = new WeakSet<IdbSpan>()
  /** Spans whose mirror publishes before durability — see `autocommitEager`. */
  private readonly eagerSpans = new WeakSet<IdbSpan>()

  transactCount = 0
  outboxCommits = 0
  cacheCommits = 0

  private constructor(
    private readonly db: IdbDatabaseLike,
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
      db = await openDatabase(options.factory, name)
    } catch (error) {
      // Includes `VersionError` — a store written by a NEWER build than this one.
      // D5.1 is forward-only, so the only honest move is to drop it and cold start.
      await deleteDatabase(options.factory, name)
      try {
        db = await openDatabase(options.factory, name)
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
      await store.clearAll()
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
      for (const row of this.entitiesOf(principal).values()) {
        draft.ops.push({
          kind: 'delete',
          store: ENTITY_STORE,
          key: [principal, row.entity, row.entityId],
        })
      }
      draft.entities.set(principal, new Map())
      draft.cursors.set(principal, null)
      draft.ops.push({ kind: 'delete', store: META_STORE, key: [principal, CURSOR_KEY] })
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
  }

  /** Everything enqueued so far has reached IndexedDB (or failed). */
  async settled(): Promise<void> {
    await this.queue.then(
      () => undefined,
      () => undefined,
    )
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
    await this.hydrate()
  }

  /** Test/injector seam: ADR 6 D4.5 / ADR 2 D7 rung 5 — the store cannot be read. */
  setCorrupt(corrupt: boolean): void {
    this.corrupt = corrupt
  }

  close(): void {
    this.db.close()
  }

  // ── internals ────────────────────────────────────────────────────────────

  private beginOwnSpan(): IdbSpan {
    return new IdbSpan(async (span) => await this.enqueueCommit(span))
  }

  /** `ReplicaCacheStore.beginSpan()`'s implementation — see the note on `IdbSpan`. */
  beginSpan(): OwnedSyncSpan {
    return this.beginOwnSpan()
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
   * Push the durable half of a span onto the serial queue.
   *
   * Serial and not concurrent: IndexedDB will happily run two `readwrite`
   * transactions over the same stores and resolve them in either order, and D10's
   * "independent calls are serialized" is what stops a later commit from
   * publishing its mirror swap before an earlier one.
   */
  private enqueueCommit(span: IdbSpan): Promise<void> {
    const eager = this.eagerSpans.has(span)
    const draftNow = this.drafts.get(span) ?? newDraft()
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
    }
    const run = this.queue.then(async () => {
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
        if (isQuotaError(error)) this.degrade('degraded-memory', 'quota', error)
        if (eager) {
          // The mirror already published and later writes may be staged on top of
          // it, so there is nothing sound to roll back to. The durable side is
          // untouched — the native transaction aborted whole — and the session
          // continues in memory with the degradation surfaced, which is D4.4
          // exactly. Any non-quota failure here is a store that cannot be written
          // to at all, so it degrades the same way rather than silently retrying.
          this.degrade('degraded-memory', 'corrupt', error)
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
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * ONE native transaction over all three object stores.
   *
   * The precondition re-check happens HERE, inside it, against durable rows: this
   * is the version-check ADR 6 D4.6 asks for, and it is the only check that can see
   * a write committed by another tab, because another tab is another connection
   * with its own mirror.
   */
  private async commitDraft(draft: SpanDraft): Promise<void> {
    const tx = this.db.transaction([...ALL_STORES], 'readwrite')
    const completion = transactionCompletion(tx)
    try {
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
      for (const op of draft.ops) {
        const store = tx.objectStore(op.store)
        if (op.kind === 'put') store.put(op.value)
        else store.delete(op.key)
      }
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
    await completion
  }

  /** Swap a committed draft into the mirror. Runs only after IndexedDB said complete. */
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

  private async hydrate(): Promise<void> {
    const tx = this.db.transaction([...ALL_STORES], 'readonly')
    const entities = (await requestAsPromise(
      tx.objectStore(ENTITY_STORE).getAll(),
    )) as StoredEntity[]
    const meta = (await requestAsPromise(tx.objectStore(META_STORE).getAll())) as StoredMeta[]
    const outbox = (await requestAsPromise(
      tx.objectStore(OUTBOX_STORE).getAll(),
    )) as StoredOutboxRecord[]
    this.entities.clear()
    this.cursors.clear()
    this.outboxRows.clear()
    this.nextOrdinal = 0
    for (const row of entities) {
      const slice = this.entities.get(row.principal) ?? new Map<string, EntityRecord>()
      slice.set(rowKey(row.entity, row.entityId), {
        entity: row.entity,
        entityId: row.entityId,
        value: row.value,
        revision: row.revision,
        provenance: row.provenance as EntityRecord['provenance'],
      })
      this.entities.set(row.principal, slice)
    }
    for (const row of meta) {
      if (row.key === CURSOR_KEY) this.cursors.set(row.principal, row.value as Cursor | null)
    }
    // BY ORDINAL, not by key. IndexedDB hands rows back in key order, which for the
    // outbox is `mutationId` order — so hydrating without this sort would silently
    // re-order the queue on every reload and break ADR 3 D12's FIFO.
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

    const cursorRows = [...this.cursors].map(([principal, value]) => ({ principal, value }))
    const cursors = planSecretScrub(
      cursorRows.map((row) => ({
        address: `meta[${row.principal}/${CURSOR_KEY}]`,
        row,
        value: row.value,
      })),
    )

    const outboxRows: { principal: string; index: number; stored: StoredOutboxRecord }[] = []
    for (const [principal, slice] of this.outboxRows)
      slice.forEach((stored, index) => outboxRows.push({ principal, index, stored }))
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

    const report = mergeScrubReports(entities.report, cursors.report, outbox.report)
    if (report.rewritten === 0) {
      this.options.onSecretsScrubbed?.(report)
      return
    }

    const tx = this.db.transaction([...ALL_STORES], 'readwrite')
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
      } satisfies StoredEntity)
    }
    for (const rewrite of cursors.rewrites) {
      tx.objectStore(META_STORE).put({
        principal: rewrite.row.principal,
        key: CURSOR_KEY,
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
      this.cursors.set(rewrite.row.principal, rewrite.value as Cursor | null)
    for (const rewrite of outbox.rewrites) {
      const { principal, index, stored } = rewrite.row
      const slice = this.outboxRows.get(principal)
      if (slice) slice[index] = { ...stored, record: rewrite.value }
    }
    this.options.onSecretsScrubbed?.(report)
  }

  private async clearAll(): Promise<void> {
    const tx = this.db.transaction([...ALL_STORES], 'readwrite')
    const completion = transactionCompletion(tx)
    for (const name of ALL_STORES) tx.objectStore(name).clear()
    await completion
    this.entities.clear()
    this.cursors.clear()
    this.outboxRows.clear()
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
  ): void {
    this.store.guardReadable()
    const install = (draft: SpanDraft): void => {
      // The atomic swap of ADR 2 D6.4: the staged slice REPLACES this principal's
      // rows, the buffered deltas apply on top, and the cursor commits — one
      // transaction, no half-installed replica.
      const current = this.slice(draft)
      for (const key of current.keys()) {
        const existing = current.get(key)
        if (existing === undefined) continue
        draft.ops.push({
          kind: 'delete',
          store: ENTITY_STORE,
          key: [this.principal, existing.entity, existing.entityId],
        })
      }
      const next = new Map<string, EntityRecord>()
      draft.entities.set(this.principal, next)
      draft.touchedCache = true
      for (const row of rows) {
        next.set(rowKey(row.entity, row.entityId), row)
        draft.ops.push({ kind: 'put', store: ENTITY_STORE, value: entityRow(this.principal, row) })
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
    this.store.autocommitEager(install)
  }

  discardCache(): void {
    this.store.guardReadable()
    // Reaches entities and the cursor. The outbox object store is not named here,
    // and there is no method on this port through which it could be.
    this.store.autocommitEager((draft) => {
      const current = this.slice(draft)
      for (const row of current.values()) {
        draft.ops.push({
          kind: 'delete',
          store: ENTITY_STORE,
          key: [this.principal, row.entity, row.entityId],
        })
      }
      draft.entities.set(this.principal, new Map())
      draft.cursors.set(this.principal, null)
      draft.ops.push({ kind: 'delete', store: META_STORE, key: [this.principal, CURSOR_KEY] })
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
   * `upsert(seq 2)` for one entity must leave it PRESENT, and the durable ops are
   * appended in the same order so the native transaction reproduces it exactly
   * (ADR 2 D9/D13 — order is the correctness property).
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
        draft.ops.push({ kind: 'put', store: ENTITY_STORE, value: entityRow(this.principal, row) })
        continue
      }
      // `remove` (tombstone, global) and `evict` (this principal's view only) both
      // drop the row from THIS principal's slice — and under a per-principal
      // keyspace that is the whole difference, because an evict must not touch
      // anybody else's copy. Amendment 1 D14.5's distinction is preserved upstream
      // in the envelope's op and, for the port, by `cacheOperations()`.
      slice.delete(rowKey(op.entity, op.entityId))
      draft.ops.push({
        kind: 'delete',
        store: ENTITY_STORE,
        key: [this.principal, op.entity, op.entityId],
      })
    }
  }

  private setCursor(draft: SpanDraft, cursor: Cursor): void {
    draft.cursors.set(this.principal, cursor)
    draft.touchedCache = true
    draft.ops.push({
      kind: 'put',
      store: META_STORE,
      value: { principal: this.principal, key: CURSOR_KEY, value: cursor } satisfies StoredMeta,
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

class IndexedDbOutboxStore implements OutboxStorePort {
  constructor(
    private readonly store: IndexedDbSyncStore,
    private readonly principal: string,
  ) {}

  /**
   * The cold-start read.
   *
   * It rehydrates from IndexedDB first, and that is what makes a recovery in a test
   * an honest one: a read that only returned the mirror would report what a
   * surviving object still held rather than what committed. `rehydrate()` refuses
   * while degraded and waits for the write queue, so it can never roll the mirror
   * back past work still in flight.
   */
  async read(): Promise<readonly OutboxRecord[]> {
    this.store.guardReadable()
    await this.store.rehydrate()
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

const entityRow = (principal: string, row: EntityRecord): StoredEntity => ({
  principal,
  entity: row.entity,
  entityId: row.entityId,
  value: row.value,
  revision: row.revision,
  provenance: row.provenance,
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

function openDatabase(factory: IdbFactoryLike, name: string): Promise<IdbDatabaseLike> {
  return new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(name, REPLICA_SCHEMA_VERSION)
    request.onupgradeneeded = () => {
      upgradeSchema(request.result)
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab is upgrading. Close so it is not blocked; this connection's
      // owner cold-starts rather than holding the whole origin hostage (D4.6).
      db.onversionchange = () => {
        db.close()
      }
      resolve(db)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB open failed'))
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
