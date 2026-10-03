/** Async query builders and transaction ports bound to the store executor. */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { EmptyRelations } from 'drizzle-orm'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { SqliteRemoteDatabase, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { SQLiteRemoteSession, type PreparedQueryConfig } from 'drizzle-orm/sqlite-proxy/session'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { QueryClient, SqlRunResult, StatementIntent } from './driver'

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
 * convention (spec rule 45). The executor's ambient `transact` is how a span nests;
 * there is nothing left for drizzle's own transaction to do here.
 */
type SpanScopeDrizzle = Omit<FullStoreDrizzle, 'transaction'>

const transactionScope = new AsyncLocalStorage<SpanScopeDrizzle>()

export function currentTransaction(): StoreDrizzle | undefined {
  return transactionScope.getStore() as StoreDrizzle | undefined
}

/**
 * Builder reads decode positionally; raw reads also expose column names
 * (POD-3680). Drizzle rc.4 drops the declared result mode at its remote callback,
 * so StoreRemoteSession selects the shape while preparing the query.
 *
 * Raw results keep both shapes in one ordinary array. Named cells are copied
 * once as non-enumerable data properties, preserving iteration and JSON output.
 * Builder results need only the positional cells and skip those properties.
 * Array members retain precedence over column names, as in the old adapter.
 */
function rowValues(row: unknown, namedColumns: boolean): unknown[] {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === 'object') {
    const named = row as Record<string, unknown>
    const values = Object.values(named)
    if (namedColumns) {
      for (const [index, name] of Object.keys(named).entries()) {
        if (Reflect.has(values, name)) continue
        Object.defineProperty(values, name, {
          value: values[index],
          writable: true,
          configurable: true,
        })
      }
    }
    return values
  }
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
  private readonly arrayReadingSession: SQLiteRemoteSession<EmptyRelations>
  private readonly arrayWritingSession: SQLiteRemoteSession<EmptyRelations>
  private readonly intents = new WeakMap<object, StatementIntent>()
  private readonly arrayQueries = new WeakSet<object>()

  constructor(
    private readonly queryClient: QueryClient,
    dialect: SQLiteDialect,
  ) {
    super(remoteCallback(queryClient, 'write', true), dialect, {})
    this.readingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'read', true), dialect, {},
    )
    this.arrayReadingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'read', false), dialect, {},
    )
    this.arrayWritingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'write', false), dialect, {},
    )
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(...args: PrepareArguments) {
    const intent = args[5]?.type === 'select' ? 'read' : 'write'
    const arrays = args[1] === 'arrays'
    const prepared =
      arrays
        ? (intent === 'read'
            ? this.arrayReadingSession
            : this.arrayWritingSession).prepareQuery<T>(...args)
        : intent === 'read'
          ? this.readingSession.prepareQuery<T>(...args)
          : super.prepareQuery<T>(...args)
    this.intents.set(prepared, intent)
    if (arrays) this.arrayQueries.add(prepared)
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
      remoteCallback(this.queryClient, 'write', true),
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
        return results.map((result, index) => {
          const namedColumns = !this.arrayQueries.has(prepared[index]!)
          return {
            rows:
              batch[index]?.method === 'get'
                ? result.rows.length === 0
                  ? (undefined as unknown as unknown[])
                  : rowValues(result.rows[0], namedColumns)
                : result.rows.map((row) => rowValues(row, namedColumns)),
            ...result.run,
          }
        })
      },
    )
    // The upstream batch API types builders, but uses only their _prepare hook.
    // Preserve tuple result types while supplying the already prepared queries.
    const items = prepared.map((query) => ({ _prepare: () => query })) as unknown as T
    return await delegate.batch(items)
  }
}

function remoteCallback(
  client: QueryClient,
  intent: StatementIntent,
  namedColumns: boolean,
): AsyncRemoteCallback {
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
      return {
        rows: row === undefined
          ? (undefined as unknown as unknown[])
          : rowValues(row, namedColumns),
      }
    }
    const rows =
      intent === 'read' ? await client.all(sql, ...params) : await client.writeAll(sql, ...params)
    return { rows: rows.map((row) => rowValues(row, namedColumns)) }
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

/** Named callback seam so the effect graph never classifies every anonymous function here. */
export type PreparedQueryForDb<P> = (db: StoreDrizzle) => P

/**
 * ONE PREPARED QUERY PER DRIZZLE INSTANCE [POD-3854].
 *
 * WHAT PREPARING BUYS. `.get()` and `.all()` on a builder are `_prepare().get()`
 * and `_prepare().all()`, and `_prepare` is the expensive half: it serialises the
 * statement through the dialect and generates a row mapper over the selection
 * list, per call. `.prepare()` is the SAME `_prepare()`, kept. Everything after
 * it is byte-identical — `fillPlaceholders`, then the remote callback below,
 * then the executor's ambient router — so intent, lane, span scope,
 * statement-probe attribution and the driver's per-connection statement cache
 * all see exactly what the fluent form showed them. Only the rebuilding goes.
 *
 * WHY "PER INSTANCE" IS THE WHOLE POINT. A prepared query also closes over the
 * remote callback it was prepared against, and that callback is bound to ONE
 * `QueryClient`. `buildStoreDrizzle` makes a new instance per transaction over
 * that transaction's frame-pinned client, which is what `currentTransaction()`
 * hands a repository's `db` getter. Preparing once per STORE would therefore
 * pin every read to the root client and quietly take reads out of the enclosing
 * transaction — the one failure mode this cache exists to make impossible.
 * Keying on the instance leaves `currentTransaction() ?? rootDb` deciding which
 * client runs the statement, exactly as the fluent form does.
 *
 * The lifetimes line up with the call counts. The root instance is one object
 * for the store's life, so every read outside a transaction — the hot path this
 * is for — hits the cache. A transaction's instance prepares once per
 * transaction and is collected with it, and once per transaction is strictly
 * less than the once per CALL the fluent form was already paying.
 */
export function preparedPerDb<P>(build: (db: StoreDrizzle) => P): PreparedQueryForDb<P> {
  const cache = new WeakMap<object, P>()
  return (db) => {
    const key = db as unknown as object
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const made = build(db)
    cache.set(key, made)
    return made
  }
}

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
