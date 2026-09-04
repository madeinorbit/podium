/**
 * THE SYNCHRONOUS DRIZZLE INSTANCE STAGE A CONVERTS ONTO [POD-3221 spec rule 27a].
 *
 * WHY THIS EXISTS. Stage A converts 39 repositories off raw prepared statements
 * while their methods stay SYNCHRONOUS — the flip that makes them async is B1,
 * and doing both at once would mean converting and re-awaiting every production
 * call site in one commit. But the executor's own {@link QueryClient} is fully
 * async, so there was nothing for a synchronous repository to convert onto. Four
 * waves found that within minutes of Stage A opening; rule 20 had recorded it a
 * day earlier.
 *
 * WHY THE EXECUTOR OWNS IT RATHER THAN EACH REPOSITORY. A repository that builds
 * its own drizzle instance needs the raw handle, and a file holding a raw handle
 * has not converted: rule 13 bans the import, and STAGE_A_UNCONVERTED's own
 * definition is that a file is unconverted until no raw handle survives in it.
 * Building it here means a repository imports `drizzle-orm` and the schema and
 * nothing else, so its ledger line comes off honestly rather than by exemption.
 *
 * WHY DRIZZLE'S OWN DRIVER RATHER THAN A HAND-ROLLED SYNCHRONOUS CLIENT. A
 * five-verb client over SQL text would force every repository through
 * `builder -> toSQL() -> client`, and drizzle's builder emits PHYSICAL column
 * names — so rows would come back keyed `snake_case` with none of the schema's
 * TypeScript names and none of the `$type` brands, and all seven waves would
 * hand-write mappers that B1 would then unpick. Drizzle's own execution path
 * does that mapping.
 *
 * WHAT B1 DOES TO IT. Rebinds this one field to the asynchronous driver and lets
 * the await pass add the awaits. The query BODIES do not change, which is what
 * makes the existing suite the flip's oracle.
 *
 * INTENT is declared by the terminal method — `.get()`/`.all()` on a select read;
 * `.run()`/`.returning()` on insert/update/delete write. That is a declaration at
 * the call site, not inference from SQL text, so rule 16 holds. POD-3391's lint
 * derives intent from the emitted SQL and fails where the two disagree.
 */

import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'

/** drizzle's own name for bun:sqlite's `Database`, taken off its signature rather
 *  than imported from `bun:sqlite`, which does not resolve without @types/bun. */
type DrizzleBunClient = Extract<Parameters<typeof drizzle>[0], { client: unknown }>['client']

/** The synchronous drizzle database Stage A repositories query through. */
export type SyncDrizzle = ReturnType<typeof buildSyncDrizzle>

/**
 * The client drizzle sees: OUR INSTRUMENTED WRAPPER, never the raw handle.
 *
 * POD-3395 measured why this matters. `bunSqliteClient()` returns the raw
 * `bun:sqlite` Database out of the WeakMap, and BOTH query probes patch the
 * SqlDatabase WRAPPER — `observeLegacyHandle` patches `holder.db.prepare` in
 * place, `attributeQueries` returns a delegating wrapper. A drizzle instance
 * built over the raw handle issues statements past both of them, so every
 * converted repository becomes INVISIBLE to the query-count feeds. The hot-path
 * gate's budget is "no increase", so counts falling toward zero as waves land
 * read as an improvement and the gate cannot fail. Silent, and in the direction
 * that looks like success.
 *
 * Drizzle's bun session calls exactly three things on a client — `exec`, `query`
 * and `transaction` — so routing it through the wrapper costs one small adapter
 * and leaves both probes working untouched.
 *
 * `transaction` REFUSES on purpose. Drizzle's own transaction keeps its own
 * nesting state, while `SessionStore.transact` and this seam share the depth
 * counter in `@podium/runtime/sqlite`; two registries over one connection
 * corrupt each other, and drizzle would emit BEGIN inside an open span. Refusing
 * here makes the wrong call impossible rather than merely discouraged.
 */
function clientOverWrapper(database: SqlDatabase): DrizzleBunClient {
  return {
    exec: (sql: string) => database.exec(sql),
    query: (sql: string) => database.prepare(sql),
    transaction: () => {
      throw new Error(
        'drizzle.transaction() is not available on the store seam: it keeps its own nesting ' +
          'state and would BEGIN inside a span the store already opened. Use the injected span.',
      )
    },
  } as unknown as DrizzleBunClient
}

function buildSyncDrizzle(database: SqlDatabase) {
  return drizzle({ client: clientOverWrapper(database) })
}

/**
 * Build the synchronous drizzle instance over `database`, or return undefined
 * when the handle is not bun-backed.
 *
 * UNDEFINED IS NOT AN ERROR HERE. The same store runs over a non-bun handle in
 * some tests and in the restore path, and those callers hold repositories that
 * have not been converted yet. A repository that needs this asserts it at its own
 * constructor, so the failure names the repository rather than the store.
 */
export function syncDrizzleOver(database: SqlDatabase): SyncDrizzle {
  return buildSyncDrizzle(database)
}

/**
 * THE SYNCHRONOUS SPAN Stage A repositories open [POD-3398 raised the gap].
 *
 * A repository that has given up its raw handle also gives up
 * `transaction(this.db, fn)` — and `executor.transact` is async, which Stage A may
 * not call. So the same seam carries the span: same savepoint semantics as the
 * runtime helper it replaces (it IS that helper, over the handle the executor
 * holds), synchronous, and retired at B1 when the call site becomes
 * `await executor.transact(...)`.
 *
 * WHY NOT drizzle's own `db.transaction(fn)`, which is synchronous on this driver:
 * the executor would not know the span exists, so lane selection and the
 * post-commit mechanisms would not see it — and the span lint's opener list is
 * by name, so a repository opening one reads as an UNNAMED transaction opener.
 * Routing through the store's port keeps the call site's SHAPE the same across the
 * flip, which is the property that makes a wave's commit survive B1 unedited.
 */
/**
 * WHAT A REPOSITORY IS HANDED: a query builder and a transaction, together.
 *
 * The pair is one object because they are one capability — a repository that can
 * query can also open a span, and splitting them into two constructor parameters
 * made `store.ts` read as if it were handing over a bare handle.
 *
 * `transact` is NOT a method on the drizzle instance, and that is deliberate
 * twice over. Drizzle's own `db.transaction()` exists on this driver, but it opens
 * a span the EXECUTOR does not know about — lane selection and the post-commit
 * mechanisms would not see it, and the span lint's opener list is by name. And
 * wrapping drizzle to add a method would mean re-exposing its whole builder
 * surface, which is the query-DSL we decided (POD-3242) not to own.
 *
 * THE ASYNC PAIR SATISFIES THIS SAME SHAPE, so the flip swaps what fills it and
 * leaves every construction site alone.
 */
export interface SyncQueries {
  /** The synchronous drizzle instance a repository queries through. */
  readonly db: SyncDrizzle
  /** A synchronous transaction, with the savepoint semantics of the runtime helper it replaces. */
  transact<T>(fn: () => T): T
}

/** The synchronous query capability over `database`, or undefined when it is not bun-backed. */
export function syncQueriesOver(database: SqlDatabase): SyncQueries {
  return { db: syncDrizzleOver(database), transact: (fn) => transaction(database, fn) }
}
