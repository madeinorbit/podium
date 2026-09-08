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
 * BOTH SHAPES AT ONCE, because drizzle's remote callback cannot tell us which is
 * wanted. A builder read (`select()...all()`) decodes POSITIONALLY through
 * drizzle's field mapper, while a raw read (`db.all(sql\`…\`)`) has no fields and
 * hands whatever we return straight to the caller, which reads it BY NAME. Both
 * arrive at this callback as method 'all' -- rc.4's sqlite-proxy session maps its
 * `values` primitive onto 'all' too -- so there is no flag to branch on.
 *
 * The previous implementation was Object.values(), which is correct for the
 * builder path and silently destroys the names for the raw one: every field read
 * back undefined, so conversation and transcript SEARCH returned nothing and
 * MemorySearchService dropped every row for want of a machineId (POD-3680).
 *
 * A Proxy over the values array satisfies both: indices and array methods hit the
 * array, and anything else falls through to the original named row. Array.isArray
 * and spreading still see an array, which is what drizzle's mapper needs.
 *
 * One known shadow: a column literally named `length`, or a numeric name, is
 * taken by the array. No column in this schema is either.
 */
function proxyRowValues(row: unknown): unknown[] {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === 'object') {
    const named = row as Record<string, unknown>
    const values = Object.values(named)
    return new Proxy(values, {
      get: (target, prop, receiver) =>
        !Reflect.has(target, prop) && typeof prop === 'string' && prop in named
          ? named[prop]
          : Reflect.get(target, prop, receiver),
      has: (target, prop) =>
        Reflect.has(target, prop) || (typeof prop === 'string' && prop in named),
    })
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
