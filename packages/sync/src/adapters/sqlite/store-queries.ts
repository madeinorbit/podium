/**
 * THE STORE'S QUERY CAPABILITY, NARROWED TO WHAT THIS ADAPTER USES (POD-3338 for
 * the port, POD-3416 for what it now carries; spec §6 rules 20, 27a, 27b, 34a).
 *
 * `SyncRepository` is the one repository in the set that is not in `apps/server`,
 * so it was the one still handed the raw connection after [0.12] bound every
 * other constructor to the executor. A package may not import an app, and rule 2
 * deliberately keeps the executor inside persistence rather than in
 * `@podium/runtime` — so the package DECLARES the interface it requires and the
 * server's seam satisfies it. That is dependency inversion, and it is the
 * pattern this epic already set one file away: `./server-tables.ts` injected the
 * two server-owned tables for exactly this reason.
 *
 * WHY THE TYPES ARE STRUCTURAL AND NOT `typeof StoreQueries`. Naming the server's
 * binding is the import this file exists to avoid — the same reasoning
 * `./server-tables.ts` records, and it is the whole reason the shapes below are
 * spelled out rather than referenced. `apps/server`'s `StoreQueries`
 * (`store/executor/sync-drizzle.ts`) satisfies {@link StoreQueries} structurally,
 * so a member this adapter depends on cannot be dropped from the seam without a
 * compile error at the composition root.
 *
 * WHAT IT NAMED BEFORE THE CONVERSION, AND WHY IT CHANGED. Until POD-3416 this
 * port named `legacy` — the executor's raw `bun:sqlite` handle — because the
 * adapter still issued hand-written statements and the query layer was
 * asynchronous. Rule 20's own text said the port "grows a query-layer member when
 * the adapter's own conversion wave gives it one to use", and rule 27a then gave
 * Stage A a SYNCHRONOUS drizzle instance to convert onto. So the raw connection
 * is gone from this port entirely, which is the other half of what rule 20 wanted
 * from it: nothing in this package reads the executor's `legacy` field any more,
 * and POD-3267 can delete it.
 *
 * WHY THERE IS NO REFUSAL HERE ANY MORE. The seam is optional on the executor (a
 * fake or a remote driver has no `bun:sqlite` connection), and it used to be
 * optional on this port too, so `SyncRepository`'s constructor threw when it was
 * absent. Rule 27b moved that check: `apps/server`'s `store.ts` asserts the seam
 * ONCE, where the whole repository set is constructed, so no repository carries a
 * branch for a case its own constructor cannot produce.
 *
 * WHAT B1 DOES TO IT. The asynchronous pair satisfies the same two-member shape,
 * so the flip replaces what fills it and leaves this declaration's SHAPE alone —
 * `rootDb` becomes the async instance and `createOrJoinTransaction` returns a
 * promise. That is what
 * makes the existing suite the flip's oracle.
 *
 * This type is the ADAPTER's and it stays here: `check-boundaries` rule 11 keeps
 * the kernel free of SQLite and of anything under `adapters/`, and drizzle is on
 * its forbidden-specifier list for kernel modules.
 */

import type { EmptyRelations } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core'

/**
 * What a write reports back.
 *
 * `bigint` is the driver's, not a widening: SQLite row ids exceed
 * `Number.MAX_SAFE_INTEGER` and the handle says so. `appendChanges` reads
 * `lastInsertRowid` to derive the seqs it just assigned, so this is a member the
 * adapter genuinely depends on rather than a shape copied over wholesale.
 */
export interface SyncRunResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

/**
 * The drizzle database this adapter queries through.
 *
 * `transaction` IS OMITTED DELIBERATELY, so `this.db.transaction(...)` is a
 * COMPILE ERROR rather than a convention [spec rule 45]. Drizzle's own
 * transaction keeps its own nesting state and would issue a fresh BEGIN inside a
 * span the store already opened; {@link StoreQueries.createOrJoinTransaction} is the only
 * boundary, and it is the same omission `apps/server`'s `SyncDrizzle` makes.
 *
 * `'sync'` is the result kind — every terminal method returns its value rather
 * than a promise, which is what Stage A requires and what B1 changes.
 */
export type SyncDrizzle = Omit<
  SQLiteAsyncDatabase<'sync', SyncRunResult, EmptyRelations>,
  'transaction'
>

/**
 * WHAT THE COMPOSITION ROOT HANDS {@link SyncRepository} alongside the tables: a
 * query builder and a transaction, together.
 *
 * The pair is one object because they are one capability — a repository that can
 * query can also open a span, and splitting them into two constructor parameters
 * made the construction line read as if it were handing over a bare handle.
 *
 * `createOrJoinTransaction` is NOT a method on the drizzle instance, and that
 * is deliberate
 * twice over. Drizzle's own `db.transaction()` exists on this driver, but it
 * opens a span the EXECUTOR does not know about — lane selection and the
 * post-commit mechanisms would not see it, and the span lint's opener list is by
 * name. And wrapping drizzle to add a method would mean re-exposing its whole
 * builder surface, which is the query-DSL this epic decided (POD-3242) not to own.
 *
 * IT IS ALSO WHAT KEEPS NESTING SAFE ACROSS THE PACKAGE BOUNDARY. The server's
 * implementation is the nesting-safe runtime helper over the SAME connection the
 * composition root's own spans run on, so a `SessionStore.transact` wrapping an
 * `appendChanges` still degrades the inner span to a savepoint.
 */
export type TransactionRunner = <T>(fn: () => T) => T

export interface StoreQueries {
  /** The root drizzle instance a repository queries through. */
  readonly rootDb: SyncDrizzle
  /** Creates a root transaction or joins the enclosing transaction when nested. */
  readonly createOrJoinTransaction: TransactionRunner
}
