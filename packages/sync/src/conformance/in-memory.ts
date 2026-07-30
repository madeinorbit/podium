/**
 * The IN-MEMORY instantiation — the one CI runs (ADR 6 D1: "tests / private mode /
 * hard quota session — an in-memory adapter of the same port").
 *
 * It is a COMPOSITION, not a third fake. Both halves already ship from their own
 * roles for exactly this purpose (`replica/memory-store.ts`,
 * `outbox/test-doubles.ts`, both exported from the package with POD-373 named in
 * their headers), and re-implementing either here would give the suite a set of
 * semantics no kernel test shares — which is how five of POD-370's eight review
 * findings ended up being defects in a FAKE rather than in the kernel (POD-1130).
 *
 * What this file adds is only what a chaos case needs and neither double exposes:
 * a write-denial gate over the cache region, and two precise durable-publication
 * counters. Everything else is passed through.
 *
 * THE ONE THING WORTH READING: `unitOfWork` and `viewFor(...).cache` speak the
 * SAME `SyncSpan` port, which is what lets the crash cases run one real
 * transaction across both regions —
 *
 *     await unitOfWork.transact(async (span) => {
 *       await outbox.retireAllApplied(ids, span)   // enrols the queue region
 *       view.cache.applyAtomic(mutation, span)     // enrols entities + cursor
 *     })
 *
 * — with the opener committing once. That is POD-1146's stated gap closed against
 * a real transaction: both kernels' REAL store ports, one span, no double on
 * either side of the seam.
 */

import type { OutboxApplyResult, OutboxStoreMutation, OutboxStorePort } from '../outbox/ports'
import { InMemoryOutboxStore, InMemoryUnitOfWork } from '../outbox/test-doubles'
import type { OutboxRecord } from '../outbox/records'
import { InMemoryReplicaStore, type StoreView } from '../replica/memory-store'
import type { CacheMutation, ReplicaCacheStore } from '../replica/ports'
import type { OwnedSyncSpan, SyncSpan, SyncUnitOfWork } from '../span'
import type { Cursor, EntityRecord } from '../replica/types'
import type {
  ConformanceStorage,
  ConformanceStorageView,
  ObservedCacheOperation,
  SyncInstantiation,
} from './instantiation'

/** ADR 6 D4.4's denial, as a device reports it. */
export class QuotaExceededError extends Error {
  constructor(message = 'storage quota exceeded') {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/**
 * A write gate over the cache port.
 *
 * Reads pass through untouched, on purpose: ADR 6 D4.4 is about a DENIED WRITE,
 * and a gate that also blinded reads would turn every quota case into a
 * corruption case (D7 rung 5) and silently stop testing the thing it is named
 * for. Corruption has its own injector.
 */
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
    // Observed AFTER the denial check and BEFORE the write, so a refused operation is
    // not recorded as one the store was handed — the record is of what the port
    // accepted, not of what a caller attempted.
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
    // A bootstrap install carries the buffered frames' operations too; they cross the
    // same port and carry the same obligation.
    for (const mutation of buffered) this.observe(mutation)
  }
  discardCache(): void {
    // A discard is not denied by quota: it FREES space, and refusing it would wedge
    // a full device permanently below D7's rung 5 with no way down the ladder.
    this.inner.discardCache()
  }
  durability(): 'durable' | 'degraded-memory' | 'unavailable' {
    return this.inner.durability()
  }

  private refuseIfDenied(): void {
    if (this.gate.denied !== undefined) throw this.gate.denied
  }
}

/** The same gate over the outbox port, plus the durable-write counter. */
class GatedOutboxStore implements OutboxStorePort {
  constructor(
    private readonly inner: InMemoryOutboxStore,
    private readonly gate: { denied: unknown | undefined },
  ) {}

  async read(): Promise<readonly OutboxRecord[]> {
    return await this.inner.read()
  }

  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult> {
    if (this.gate.denied !== undefined) throw this.gate.denied
    return await this.inner.apply(mutation, span)
  }

  writes(): number {
    return this.inner.writes
  }

  setCorrupt(corrupt: boolean, error: unknown): void {
    this.inner.failRead = corrupt ? error : undefined
  }
}

class InMemoryConformanceStorage implements ConformanceStorage {
  readonly unitOfWork: SyncUnitOfWork
  private readonly uow = new InMemoryUnitOfWork()
  private armedCommitFailure: unknown | undefined
  private readonly physical = new InMemoryReplicaStore()
  private readonly views = new Map<string, ConformanceStorageView>()
  private readonly outboxStores: GatedOutboxStore[] = []
  private readonly innerCaches: StoreView['cache'][] = []
  private readonly gate: { denied: unknown | undefined } = { denied: undefined }
  private readonly observedOperations: ObservedCacheOperation[] = []

  constructor() {
    // Wrapped rather than handed over raw, so `failNextCommit` fires at the ONE
    // instant that matters: the throw happens after `body` returned — every
    // participant has enrolled — and before the opener calls `commit()`. Setting
    // `InMemoryUnitOfWork.failCommit` directly would be sticky, and a fault injector
    // that stays armed silently poisons the next case.
    this.unitOfWork = {
      transact: async <T>(body: (span: SyncSpan) => Promise<T>): Promise<T> =>
        await this.uow.transact(async (span) => {
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

  failNextCommit(error: unknown = new QuotaExceededError('commit denied mid-transaction')): void {
    this.armedCommitFailure = error
  }

  viewFor(principal: string): ConformanceStorageView {
    const existing = this.views.get(principal)
    if (existing !== undefined) return existing
    // Both regions come from ONE physical store: the cache view is
    // `InMemoryReplicaStore`'s (whose `beginSpan` belongs to the physical store, not
    // to the view), and the queue region is the outbox role's own durable double.
    const outbox = new GatedOutboxStore(new InMemoryOutboxStore(), this.gate)
    this.outboxStores.push(outbox)
    const inner = this.physical.viewFor(principal).cache
    this.innerCaches.push(inner)
    const view: ConformanceStorageView = {
      cache: new GatedCache(inner, this.gate, (mutation) => {
        for (const op of mutation.operations) {
          this.observedOperations.push({ kind: op.kind, entity: op.entity, entityId: op.entityId })
        }
      }),
      outbox,
    }
    this.views.set(principal, view)
    return view
  }

  setWritesDenied(denied: boolean, error: unknown = new QuotaExceededError()): void {
    this.gate.denied = denied ? error : undefined
  }

  setCorrupt(corrupt: boolean): void {
    // Every principal's view, not just the first. `InMemoryReplicaStore.setCorrupt`
    // reaches only its `default` view, and a corruption injector that silently
    // spared the second principal's cache would make every multi-principal rung-5
    // case pass for the wrong reason.
    for (const cache of this.innerCaches) cache.corrupt = corrupt
    for (const store of this.outboxStores) {
      store.setCorrupt(corrupt, new Error('outbox store unreadable'))
    }
  }

  unitOfWorkTransactions(): number {
    return this.uow.spans
  }

  outboxWrites(): number {
    return this.outboxStores.reduce((total, store) => total + store.writes(), 0)
  }

  /**
   * Publications by the CACHE region's own physical store: every autocommitted
   * `applyAtomic`/`installSnapshot`/`discardCache`, plus one per span the cache port
   * opened itself through `beginSpan()`.
   *
   * A cache write enrolled in a `unitOfWork.transact` span is NOT counted here — it
   * publishes as part of that transaction, and `unitOfWorkTransactions()` is the
   * counter that sees it. Splitting them is what lets a case say which seam
   * committed, instead of reading one total that could mean either.
   */
  cacheWrites(): number {
    return this.physical.transactions
  }

  cacheOperations(): readonly ObservedCacheOperation[] {
    return [...this.observedOperations]
  }
}

export const inMemoryInstantiation: SyncInstantiation = {
  name: 'in-memory',
  open: async () => new InMemoryConformanceStorage(),
}
