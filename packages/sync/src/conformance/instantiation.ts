/**
 * THE PARAMETERIZATION SEAM (POD-373).
 *
 * One conformance suite, run against N instantiations of the sync kernel's
 * STORAGE. The kernels themselves — `Replica`, `Outbox` — are constructed by the
 * suite and are never supplied by an instantiation, and that split is the whole
 * design:
 *
 *   - If a hop supplied the kernels, each hop could pass its own suite while
 *     running different kernel code, and "the same suite" would be a name rather
 *     than a fact. ADR 6 D3 says there is ONE storage port with platform adapters
 *     behind it; so the adapters are what varies and the kernel is what does not.
 *   - Everything an instantiation supplies here is therefore a port ADR 6 already
 *     names, plus the FAULT INJECTORS a chaos case needs. Nothing in this file
 *     knows what a Map, an IndexedDB transaction or a SQLite connection is.
 *
 * WHO PLUGS IN: POD-307 (client storage), POD-308 (wire cutover), POD-309
 * (upstream retirement), POD-374 (IndexedDB), POD-375 (mobile SQLite). Each
 * supplies a `SyncInstantiation` and calls `describeSyncConformance(it)`; nothing
 * in `suite.ts` may be edited to admit them, and nothing in `suite.ts` may assume
 * the in-memory one.
 *
 * WHAT AN INSTANTIATION MAY NOT DO: it may not observe or alter what the kernels
 * do. There is no hook here for "skip this case", no capability flags, and no
 * per-hop tolerance. A hop that cannot satisfy a case fails it.
 */

import type { OutboxStorePort } from '../outbox/ports'
import type { ReplicaCacheStore } from '../replica/ports'
import type { SyncUnitOfWork } from '../span'

/**
 * One operation the cache region was HANDED, as the storage port saw it.
 *
 * Recorded because the model-level remove-vs-evict distinction is not enough to
 * protect Amendment 1 D14.5, and this suite proved it: a mutant that made the Replica
 * hand the store `remove` for an eviction SURVIVED every assertion about
 * `exitKind`, the `evicted` event and the resulting cache contents. It survived
 * because the public projection reads the ENVELOPE's op while the in-memory adapter
 * deletes the row either way — so the two are indistinguishable downstream of a store
 * that treats them alike.
 *
 * A durable adapter need not. POD-374 and POD-375 may reasonably write a tombstone for
 * `remove` and simply drop the row for `evict`, and a replica handing them the wrong
 * kind would render a revoked share as a deletion on device while every in-memory
 * assertion stayed green. So the kind that CROSSES THE PORT is itself a conformance
 * obligation, and every instantiation must be able to report it.
 */
export interface ObservedCacheOperation {
  readonly kind: 'upsert' | 'remove' | 'evict'
  readonly entity: string
  readonly entityId: string
}

/** One principal's pair of ports over ONE physical store (ADR 6 D4.1). */
export interface ConformanceStorageView {
  /** Entities + cursor. Has no outbox method, so `discardCache()` cannot reach the queue. */
  readonly cache: ReplicaCacheStore
  /** The queue. A separate port over the SAME physical store. */
  readonly outbox: OutboxStorePort
}

/**
 * One physical store, as a hop supplies it.
 *
 * `viewFor` takes a principal because the privacy model explicitly supports two
 * principal-bound views over one physical store (ADR 6 D4.1 + Amendment 1 D15.3),
 * and half the scoped cases cannot be expressed without it: "a second principal
 * with a different slice" is not a second store.
 */
export interface ConformanceStorage {
  /** Stable per principal. Every view shares this physical store and its transactions. */
  viewFor(principal: string): ConformanceStorageView

  /**
   * ONE transaction across every region of this physical store (ADR 2 D10 /
   * ADR 6 D4.1). This is the seam the crash cases run against, and it must be a
   * REAL transaction for this adapter — a per-write fallback here is the D10
   * non-compliance, not a simplification.
   */
  readonly unitOfWork: SyncUnitOfWork

  /**
   * ADR 6 D4.4 — deny durable writes, as a quota-exhausted device does.
   *
   * The obligation on an adapter is that a denied write does NOT partially apply.
   * `false` restores writes, so a case can prove that work SURVIVED the denial
   * rather than only that the denial was reported.
   */
  setWritesDenied(denied: boolean, error?: unknown): void

  /** ADR 6 D4.5 / ADR 2 D7 rung 5 — the store cannot be read. */
  setCorrupt(corrupt: boolean): void

  /**
   * THE D10 CRASH WINDOW, exactly: fail the next `unitOfWork.transact` AFTER every
   * participant has enrolled its native write and BEFORE the shared transaction
   * commits. One-shot, so a case cannot accidentally leave it armed for the next.
   *
   * It is a separate injector from `setWritesDenied` because they fail at different
   * instants and prove different things. A denial refuses BEFORE enrolment, so no
   * participant ever staged; this fails BETWEEN enrolment and publication, which is
   * the only window in which a torn commit is even possible. A suite with only the
   * first would report the crash case green while never opening the window.
   */
  failNextCommit(error?: unknown): void

  /**
   * Transactions opened through `unitOfWork.transact`, committed or aborted.
   *
   * This is how "ONE transaction, not N" becomes an assertion instead of a
   * comment: a case that enrols two regions asserts this moved by exactly 1.
   */
  unitOfWorkTransactions(): number

  /**
   * Durable publications to the OUTBOX region.
   *
   * Two precise counters rather than one aggregate, and that is deliberate. An
   * aggregate would have to decide whether a span that enrolled both regions is
   * one publication or two, and either answer is wrong for one of the assertions
   * that needs it — so the suite would be reading a number whose meaning it could
   * not pin. A counter nobody can interpret is the same liability as a counter
   * stuck at zero.
   */
  outboxWrites(): number

  /** Durable publications to the CACHE region (entities + cursor). */
  cacheWrites(): number

  /**
   * Every operation the cache region was handed, in the order it was handed them.
   *
   * IN ORDER, and never regrouped: feed order IS the correctness property (ADR 2 D9),
   * and an adapter that reordered `remove(seq 1)` before `upsert(seq 2)` for one entity
   * would leave a re-created entity absent. Reporting the sequence is what lets the
   * suite assert order and operation KIND at the port rather than only at the
   * projection — see `ObservedCacheOperation` for the mutant that proved the
   * difference.
   */
  cacheOperations(): readonly ObservedCacheOperation[]
}

/**
 * A named storage instantiation. `open()` returns a fresh, empty physical store.
 *
 * There is deliberately no `close()` and no `reopen()`. A crash is modelled by
 * DISCARDING THE KERNELS and rebuilding them over the same `ConformanceStorage` —
 * which is what a real power loss does, and which is the only way to prove that
 * what survived is what actually committed rather than what an object still held.
 */
export interface SyncInstantiation {
  /** Appears in every test title, so a failure names the hop that produced it. */
  readonly name: string
  open(): Promise<ConformanceStorage>
}
