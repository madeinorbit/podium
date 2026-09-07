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
 * INTENT comes from the builder's query metadata, never the terminal method or
 * SQL text. SELECT declares read; mutations and missing metadata declare write.
 * RETURNING writes therefore retain write intent even when executed with .all().
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { EmptyRelations } from 'drizzle-orm'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { SqliteRemoteDatabase, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { SQLiteRemoteSession, type PreparedQueryConfig } from 'drizzle-orm/sqlite-proxy/session'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { QueryClient, SqlRunResult, StatementIntent } from './driver'

/** drizzle's own name for bun:sqlite's `Database`, taken off its signature rather
 *  than imported from `bun:sqlite`, which does not resolve without @types/bun. */
type DrizzleBunClient = Extract<Parameters<typeof drizzle>[0], { client: unknown }>['client']

/**
 * The synchronous drizzle database Stage A repositories query through.
 *
 * `transaction` IS OMITTED DELIBERATELY, so `this.db.transaction(...)` is a
 * COMPILE ERROR rather than a convention [spec rule 45].
 *
 * WHY: drizzle's own transaction keeps its own nesting state and would issue a
 * fresh BEGIN inside a span the store already opened. The store's span is the
 * only transaction boundary — it is what applies BEGIN IMMEDIATE (drizzle
 * defaults to DEFERRED), the bounded busy retry, and the post-commit tail.
 *
 * WHY A TYPE AND NOT THE RUNTIME STUB WE HAD: the stub lived in the client and
 * threw on `transaction()`. Measured, it also refuses the STORE'S OWN adapter,
 * which reaches drizzle's transaction on purpose — so it would have made the
 * async design impossible and sent the next reader back to hand-rolled
 * savepoints. A missing member cannot collide with our own call.
 *
 * The adapter inside this file holds the un-omitted type and can still call it.
 */
export type SyncDrizzle = Omit<ReturnType<typeof buildSyncDrizzle>, 'transaction'>

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
 * The synchronous drizzle query path calls `exec` and `query`, so the adapter
 * carries only those members. Repository transaction access is excluded by the
 * `SyncDrizzle` type above, outside the execution path.
 */
function clientOverWrapper(database: SqlDatabase): DrizzleBunClient {
  return {
    exec: (sql: string) => database.exec(sql),
    query: (sql: string) => database.prepare(sql),
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
 * `createOrJoinTransaction` is NOT a method on the drizzle instance, and that
 * is deliberate
 * twice over. Drizzle's own `db.transaction()` exists on this driver, but it opens
 * a span the EXECUTOR does not know about — lane selection and the post-commit
 * mechanisms would not see it, and the span lint's opener list is by name. And
 * wrapping drizzle to add a method would mean re-exposing its whole builder
 * surface, which is the query-DSL we decided (POD-3242) not to own.
 *
 * THE ASYNC PAIR SATISFIES THIS SAME SHAPE, so the flip swaps what fills it and
 * leaves every construction site alone.
 */
export type TransactionRunner = <T>(fn: () => Promise<T>) => Promise<T>

type FullStoreDrizzle = ReturnType<typeof buildStoreDrizzle>

/**
 * WHAT THE SPAN SCOPE CARRIES, with `transaction` OMITTED [POD-3498].
 *
 * The omission is the fix's guard, and it belongs at the type level because the
 * defect was a type confusion: the scope holds a proxy DATABASE built over the
 * transaction's client, and `.transaction()` on a database emits BEGIN. A nested
 * span therefore issued a second BEGIN on a connection that already had one open.
 *
 * Omitting the member makes reinstating that call a COMPILE ERROR rather than a
 * convention — the same choice, for the same reason, as {@link SyncDrizzle}
 * above (spec rule 45). The executor's ambient `transact` is how a span nests;
 * there is nothing left for drizzle's own transaction to do here.
 */
type SpanScopeDrizzle = Omit<FullStoreDrizzle, 'transaction'>

const transactionScope = new AsyncLocalStorage<SpanScopeDrizzle>()

export function currentTransaction(): StoreDrizzle | undefined {
  return transactionScope.getStore() as StoreDrizzle | undefined
}

function proxyRowValues(row: unknown): unknown[] {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === 'object') return Object.values(row)
  return [row]
}

type PrepareArguments = Parameters<SQLiteRemoteSession<EmptyRelations>['prepareQuery']>

/**
 * Drizzle rc.4 drops builder metadata at its remote callback boundary. Keep the
 * coupling here: delegate preparation, placeholders, caching and row mapping to
 * its session, choosing a callback from the declaration before it is dropped.
 * Prepared-query identity carries the same declaration through atomic batches.
 * Review this bridge when upgrading Drizzle; the adapter tests pin both paths.
 */
class StoreRemoteSession extends SQLiteRemoteSession<EmptyRelations> {
  private readonly readingSession: SQLiteRemoteSession<EmptyRelations>
  private readonly intents = new WeakMap<object, StatementIntent>()

  constructor(
    private readonly queryClient: QueryClient,
    dialect: SQLiteDialect,
  ) {
    super(remoteCallback(queryClient, 'write'), dialect, {})
    this.readingSession = new SQLiteRemoteSession(remoteCallback(queryClient, 'read'), dialect, {})
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(...args: PrepareArguments) {
    const intent = args[5]?.type === 'select' ? 'read' : 'write'
    const prepared =
      intent === 'read'
        ? this.readingSession.prepareQuery<T>(...args)
        : super.prepareQuery<T>(...args)
    this.intents.set(prepared, intent)
    return prepared
  }

  override async batch<T extends BatchItem<'sqlite'>[] | readonly BatchItem<'sqlite'>[]>(
    queries: T,
  ): Promise<BatchResponse<T>> {
    // SQLiteRemoteSession.batch consumes only _prepare(). Reuse those exact
    // prepared objects in its mapper rather than duplicating Drizzle's decoding.
    const prepared = queries.map((query) =>
      (
        query as unknown as { _prepare(): ReturnType<StoreRemoteSession['prepareQuery']> }
      )._prepare(),
    )
    const delegate = new SQLiteRemoteSession(
      remoteCallback(this.queryClient, 'write'),
      this.dialect,
      {},
      async (batch) => {
        const results = await this.queryClient.batch(
          batch.map(({ sql, params, method }, index) => ({
            sql,
            params,
            method: method === 'values' ? 'all' : method,
            intent: this.intents.get(prepared[index]!) ?? 'write',
          })),
        )
        return results.map((result, index) => ({
          rows:
            batch[index]?.method === 'get'
              ? result.rows.length === 0
                ? (undefined as unknown as unknown[])
                : proxyRowValues(result.rows[0])
              : result.rows.map(proxyRowValues),
          ...result.run,
        }))
      },
    )
    // The upstream batch API types builders, but uses only their _prepare hook.
    // Preserve tuple result types while supplying the already prepared queries.
    const items = prepared.map((query) => ({ _prepare: () => query })) as unknown as T
    return await delegate.batch(items)
  }
}

function remoteCallback(client: QueryClient, intent: StatementIntent): AsyncRemoteCallback {
  return async (sql, params, method) => {
    if (method === 'run') {
      // QueryClient.run declares write. A SELECT executed as run must still read.
      const result =
        intent === 'write'
          ? await client.run(sql, ...params)
          : (await client.batch([{ sql, params, method: 'run', intent }]))[0]?.run
      return { rows: [], ...result }
    }
    if (method === 'get') {
      const row =
        intent === 'read' ? await client.get(sql, ...params) : await client.writeGet(sql, ...params)
      return { rows: row === undefined ? (undefined as unknown as unknown[]) : proxyRowValues(row) }
    }
    const rows =
      intent === 'read' ? await client.all(sql, ...params) : await client.writeAll(sql, ...params)
    return { rows: rows.map(proxyRowValues) }
  }
}

function buildStoreDrizzle(client: QueryClient) {
  const dialect = new SQLiteDialect()
  return new SqliteRemoteDatabase('async', dialect, new StoreRemoteSession(client, dialect), {})
}

export type StoreDrizzle = Omit<
  import('drizzle-orm/sqlite-core').SQLiteAsyncDatabase<
    'async',
    SqlRunResult & { readonly rows?: readonly unknown[] },
    import('drizzle-orm').EmptyRelations
  >,
  'transaction'
>

export interface StoreQueries {
  /** The ambient async drizzle instance a repository queries through. */
  readonly rootDb: StoreDrizzle
  /** Creates a root transaction or joins the enclosing transaction when nested. */
  readonly createOrJoinTransaction: TransactionRunner
}

export type ExecutorTransaction = <T>(fn: (client: QueryClient) => Promise<T>) => Promise<T>

export function storeQueriesOver(client: QueryClient, transact: ExecutorTransaction): StoreQueries {
  const rootDb = buildStoreDrizzle(client)
  return {
    get rootDb() {
      return (transactionScope.getStore() ?? rootDb) as unknown as StoreDrizzle
    },
    /**
     * ROOT AND NESTED ARE THE SAME CALL [POD-3498].
     *
     * There is no `if (enclosing)` branch, and adding one back is the bug this
     * replaced. `transact` here is the executor's AMBIENT form: it resolves
     * `currentScope()` and, inside an open transaction scope, calls
     * `transactOn(scope.frame, fn)` — which opens a SAVEPOINT under the enclosing
     * frame. Joining is what the executor already does; the port only has to ask.
     *
     * WHAT THE BRANCH DID INSTEAD. The value this ALS carries is
     * `buildStoreDrizzle(txClient)` — a proxy DATABASE built over the transaction's
     * client, not a drizzle transaction OBJECT. `.transaction()` on a database
     * emits BEGIN, so a nested span issued a second BEGIN on a connection that
     * already had one open and SQLite refused it: `cannot start a transaction
     * within a transaction`. That is exactly what the file's own doc comments
     * above forbid — the code contradicted its comment.
     */
    createOrJoinTransaction: async (fn) =>
      await transact(
        async (txClient) => await transactionScope.run(buildStoreDrizzle(txClient), fn),
      ),
  }
}

/** The synchronous query capability over `database`, or undefined when it is not bun-backed. */
export function syncQueriesOver(database: SqlDatabase): StoreQueries {
  const executor = import('./bun-driver').then(({ createBunStoreExecutor }) =>
    createBunStoreExecutor({ database }),
  )
  const client: QueryClient = {
    run: async (sql, ...params) => await (await executor).drizzle.run(sql, ...params),
    get: async (sql, ...params) => await (await executor).drizzle.get(sql, ...params),
    all: async (sql, ...params) => await (await executor).drizzle.all(sql, ...params),
    writeGet: async (sql, ...params) => await (await executor).drizzle.writeGet(sql, ...params),
    writeAll: async (sql, ...params) => await (await executor).drizzle.writeAll(sql, ...params),
    batch: async (statements) => await (await executor).drizzle.batch(statements),
  }
  return storeQueriesOver(
    client,
    async (fn) => await (await executor).transact(async (tx) => fn(tx.drizzle)),
  )
}
