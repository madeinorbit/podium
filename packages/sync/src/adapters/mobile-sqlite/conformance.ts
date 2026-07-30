/**
 * THE MOBILE SQLite INSTANTIATION of POD-373's cross-hop conformance suite.
 *
 * `suite.ts` is not edited to admit it and nothing in it is assumed here — that is
 * the parameterization working. What this file supplies is the four fault injectors
 * and the four counters `instantiation.ts` declares, over a REAL `SqliteSyncStore`
 * on a REAL SQLite database file.
 *
 * ─── WHAT THIS SUITE IS AND IS NOT EVIDENCE FOR ──────────────────────────────
 *
 * POD-374 measured the limit and it applies here verbatim: `failNextCommit` fires
 * BEFORE this adapter's `BEGIN IMMEDIATE`, so the suite's `base/crash-between-writes`
 * gate cannot observe what happens INSIDE the native transaction. An adapter giving
 * every staged write its own transaction — the ADR 2 D10 non-compliance — passes all
 * 30 cases. **A green run here is evidence that this adapter satisfies the KERNEL's
 * contract, not that it satisfies D4.1 on the engine.** That second claim is
 * `crash.test.ts`'s, which kills at every boundary inside one live transaction, and
 * `conformance.test.ts` states the split rather than leaving a reader to infer it.
 *
 * ─── WHERE EACH INJECTOR FAILS, AND WHY IT IS THERE ──────────────────────────
 *
 * `setWritesDenied` refuses at the PORT, before anything stages — the semantics
 * `suite.ts` asserts against (the denial surfaces as a rejection, the store is
 * byte-identical afterwards, and the same operation succeeds once space is freed).
 * It deliberately does NOT flip the adapter's durability mode, because the suite's
 * case proves recoverability while D4.4's mode flip is for the remainder of the
 * session.
 *
 * That leaves the arm the suite's injector cannot reach: a denial arriving
 * MID-TRANSACTION from the engine, after earlier statements in the same transaction
 * have already run. That is covered in `quota.test.ts` against `FaultySqlDatabase`,
 * not here — different instants, different claims, exactly as `instantiation.ts`
 * says of `setWritesDenied` versus `failNextCommit`.
 */

import { QuotaExceededError } from '../../conformance/in-memory'
import type {
  ConformanceStorage,
  ConformanceStorageView,
  ObservedCacheOperation,
  SyncInstantiation,
} from '../../conformance/instantiation'
import type { OutboxApplyResult, OutboxStoreMutation, OutboxStorePort } from '../../outbox/ports'
import type { OutboxRecord } from '../../outbox/records'
import type { CacheMutation, ReplicaCacheStore } from '../../replica/ports'
import type { Cursor, EntityRecord } from '../../replica/types'
import type { OwnedSyncSpan, SyncSpan, SyncUnitOfWork } from '../../span'
import { SqliteSyncStore } from './store'
import { freshDatabaseFile, sqliteEngine } from './test-support'

/** Reads pass through; writes are gated. A gate over reads would turn every quota
 *  case into a corruption case, which has its own injector. */
class GatedCache implements ReplicaCacheStore {
  constructor(
    private readonly inner: ReplicaCacheStore,
    private readonly gate: { denied: unknown | undefined },
    private readonly observe: (mutation: CacheMutation) => void,
  ) {}

  readCursor(): Cursor | null {
    return this.inner.readCursor()
  }
  readEntities(): readonly EntityRecord[] {
    return this.inner.readEntities()
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.inner.read(entity, entityId)
  }
  beginSpan(): OwnedSyncSpan {
    return this.inner.beginSpan()
  }
  applyAtomic(mutation: CacheMutation, span?: SyncSpan): void {
    this.refuseIfDenied()
    this.inner.applyAtomic(mutation, span)
    this.observe(mutation)
  }
  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
    span?: SyncSpan,
  ): void {
    this.refuseIfDenied()
    this.inner.installSnapshot(rows, cursor, buffered, span)
    for (const mutation of buffered) this.observe(mutation)
  }
  discardCache(): void {
    // A discard FREES space; refusing it would wedge a full device below D7's rung 5
    // with no way down the ladder.
    this.inner.discardCache()
  }
  durability(): 'durable' | 'degraded-memory' | 'unavailable' {
    return this.inner.durability()
  }

  private refuseIfDenied(): void {
    if (this.gate.denied !== undefined) throw this.gate.denied
  }
}

class GatedOutboxStore implements OutboxStorePort {
  constructor(
    private readonly inner: OutboxStorePort,
    private readonly gate: { denied: unknown | undefined },
  ) {}

  async read(): Promise<readonly OutboxRecord[]> {
    return await this.inner.read()
  }

  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult> {
    if (this.gate.denied !== undefined) throw this.gate.denied
    return await this.inner.apply(mutation, span)
  }
}

export class SqliteConformanceStorage implements ConformanceStorage {
  readonly unitOfWork: SyncUnitOfWork
  private armedCommitFailure: unknown | undefined
  private readonly views = new Map<string, ConformanceStorageView>()
  private readonly gate: { denied: unknown | undefined } = { denied: undefined }
  private readonly observedOperations: ObservedCacheOperation[] = []
  /** Surfaced degradations. Nothing in the suite reads them; a case that degraded
   *  silently would be invisible without somewhere for them to land. */
  readonly degradations: unknown[] = []

  private constructor(
    private readonly store: SqliteSyncStore,
    /** The real file this storage writes to — the seam `conformance.test.ts` uses to
     *  prove the suite is talking to an engine and not to a mirror. */
    readonly databaseFile: string,
  ) {
    // Wrapped so `failNextCommit` fires at the ONE instant the suite defines: after
    // `body` returned — every participant has enrolled — and before the opener
    // commits. Arming the store itself would be sticky, and a fault injector left
    // armed silently poisons the next case.
    this.unitOfWork = {
      transact: async <T>(body: (span: SyncSpan) => Promise<T>): Promise<T> =>
        await this.store.unitOfWork.transact(async (span) => {
          const result = await body(span)
          const armed = this.armedCommitFailure
          if (armed !== undefined) {
            this.armedCommitFailure = undefined
            throw armed
          }
          return result
        }),
    }
  }

  static async open(): Promise<SqliteConformanceStorage> {
    const { file } = freshDatabaseFile()
    const degradations: unknown[] = []
    const store = await SqliteSyncStore.open({
      openDatabase: () => sqliteEngine.open(file),
      deleteDatabase: () => {
        // A fresh temp file per case, so there is never a poisoned one to remove.
        // Left as a throw rather than a no-op: if the open path ever DID need to
        // clear here, silently succeeding would hide it.
        throw new Error('conformance storage does not expect a poisoned database')
      },
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })
    const storage = new SqliteConformanceStorage(store, file)
    storage.degradations.push(...degradations)
    return storage
  }

  failNextCommit(error: unknown = new QuotaExceededError('commit denied mid-transaction')): void {
    this.armedCommitFailure = error
  }

  viewFor(principal: string): ConformanceStorageView {
    const existing = this.views.get(principal)
    if (existing !== undefined) return existing
    const inner = this.store.viewFor(principal)
    const view: ConformanceStorageView = {
      cache: new GatedCache(inner.cache, this.gate, (mutation) => {
        for (const op of mutation.operations) {
          this.observedOperations.push({ kind: op.kind, entity: op.entity, entityId: op.entityId })
        }
      }),
      outbox: new GatedOutboxStore(inner.outbox, this.gate),
    }
    this.views.set(principal, view)
    return view
  }

  setWritesDenied(denied: boolean, error: unknown = new QuotaExceededError()): void {
    this.gate.denied = denied ? error : undefined
  }

  setCorrupt(corrupt: boolean): void {
    this.store.setCorrupt(corrupt)
  }

  unitOfWorkTransactions(): number {
    return this.store.transactCount
  }

  outboxWrites(): number {
    return this.store.outboxCommits
  }

  cacheWrites(): number {
    return this.store.cacheCommits
  }

  cacheOperations(): readonly ObservedCacheOperation[] {
    return [...this.observedOperations]
  }
}

export const sqliteInstantiation: SyncInstantiation = {
  name: 'mobile-sqlite',
  open: async () => await SqliteConformanceStorage.open(),
}
