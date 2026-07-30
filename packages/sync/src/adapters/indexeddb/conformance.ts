/**
 * THE IndexedDB INSTANTIATION of POD-373's cross-hop conformance suite.
 *
 * `suite.ts` is not edited to admit it and nothing in it is assumed here — that is
 * the parameterization working. What this file supplies is the four fault
 * injectors and the four counters `instantiation.ts` declares, over a REAL
 * `IndexedDbSyncStore` on a REAL IndexedDB engine.
 *
 * ─── WHERE EACH INJECTOR FAILS, AND WHY IT IS THERE ──────────────────────────
 *
 * `setWritesDenied` refuses at the PORT, before anything stages — which is the
 * semantics `suite.ts` asserts against (it requires the denial to surface as a
 * rejection, the store to be byte-identical afterwards, and the same operation to
 * succeed once space is freed). It deliberately does NOT flip the adapter's
 * durability mode, because the suite's case proves recoverability and D4.4's mode
 * flip is for the remainder of the session.
 *
 * That leaves the arm the suite's injector cannot reach: a denial that arrives
 * MID-TRANSACTION, from the engine, after earlier requests in the same transaction
 * have already been issued. That is where "does not partially apply" is a claim
 * about IndexedDB rather than about a gate, and where the mode flip and the
 * surfaced degradation live. It is covered in `quota.test.ts` against
 * `FaultyIdbFactory`, not here — the two are different instants and prove different
 * things, exactly as `instantiation.ts` says of `setWritesDenied` versus
 * `failNextCommit`.
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
import type { IdbFactoryLike } from './idb'
import { REPLICA_DB_NAME } from './schema'
import { IndexedDbSyncStore } from './store'
import { freshFactory } from './test-support'

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

class IndexedDbConformanceStorage implements ConformanceStorage {
  readonly unitOfWork: SyncUnitOfWork
  private armedCommitFailure: unknown | undefined
  private readonly views = new Map<string, ConformanceStorageView>()
  private readonly gate: { denied: unknown | undefined } = { denied: undefined }
  private readonly observedOperations: ObservedCacheOperation[] = []
  /** Surfaced degradations. Nothing in the suite reads them; a case that degraded
   *  silently would be invisible without somewhere for them to land. */
  readonly degradations: unknown[] = []

  constructor(private readonly store: IndexedDbSyncStore) {
    // Wrapped so `failNextCommit` fires at the ONE instant that matters: after
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

  static async open(): Promise<IndexedDbConformanceStorage> {
    const degradations: unknown[] = []
    const store = await IndexedDbSyncStore.open({
      factory: freshFactory(),
      databaseName: REPLICA_DB_NAME,
      onDegraded: (degradation) => {
        degradations.push(degradation)
      },
    })
    const storage = new IndexedDbConformanceStorage(store)
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

export const indexedDbInstantiation: SyncInstantiation = {
  name: 'indexeddb',
  open: async () => await IndexedDbConformanceStorage.open(),
}

/** Exposed so a test can open a store on a factory it controls. */
export type { IdbFactoryLike }
