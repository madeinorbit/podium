/** Async query builders and transaction ports bound to the store executor. */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { EmptyRelations } from 'drizzle-orm'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { SqliteRemoteDatabase, type AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy'
import { SQLiteRemoteSession, type PreparedQueryConfig } from 'drizzle-orm/sqlite-proxy/session'
import type { SQLiteAsyncRaw } from 'drizzle-orm/sqlite-core'
import type { QueryClient, SqlRunResult, StatementIntent } from './driver'

export {
  inListOf,
  inListSize,
  inListValues,
  notInListOf,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  preparedFamilyOverflows,
  shapeOf,
} from '@podium/sync/adapters/sqlite/prepared'

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

/**
 * Drizzle drops result mode at the remote callback. Keep it at preparation:
 * builder mappers need positional arrays, while raw queries consume named rows
 * (POD-3680). Copy each returned row once, with no per-cell forwarding.
 */
function resultRow(row: unknown, arrayRows: boolean): unknown {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === 'object') {
    return arrayRows ? Object.values(row) : { ...row }
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
  /** Every query this session has prepared: builder terminals, `.prepare()` and raw calls. */
  preparations = 0

  constructor(
    private readonly queryClient: QueryClient,
    dialect: SQLiteDialect,
  ) {
    super(remoteCallback(queryClient, 'write', false), dialect, {})
    this.readingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'read', false), dialect, {},
    )
    this.arrayReadingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'read', true), dialect, {},
    )
    this.arrayWritingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'write', true), dialect, {},
    )
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(...args: PrepareArguments) {
    this.preparations += 1
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
      remoteCallback(this.queryClient, 'write', false),
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
          const arrayRows = this.arrayQueries.has(prepared[index]!)
          return {
            rows:
              batch[index]?.method === 'get'
                ? result.rows.length === 0
                  ? (undefined as unknown as unknown[])
                  : (resultRow(result.rows[0], arrayRows) as unknown[])
                : result.rows.map((row) => resultRow(row, arrayRows)),
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
  arrayRows: boolean,
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
      // Upstream types even a raw get result as an array. In raw mode its
      // executor returns this named row directly, without a positional mapper.
      return {
        rows: row === undefined
          ? (undefined as unknown as unknown[])
          : (resultRow(row, arrayRows) as unknown[]),
      }
    }
    const rows =
      intent === 'read' ? await client.all(sql, ...params) : await client.writeAll(sql, ...params)
    return { rows: rows.map((row) => resultRow(row, arrayRows)) }
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

/**
 * HOW MANY QUERIES `db` HAS PREPARED, for the guard tests [POD-6147].
 *
 * Counted at the session's `prepareQuery`, where every builder terminal
 * (`.get()`, `.all()`, `.run()`), every `.prepare()` and every raw `db.all(sql)`
 * builds its SQL. A repository that prepares once leaves this flat while its
 * executions grow; one that rebuilds per call moves it once per call.
 */
export function preparationsOf(db: StoreDrizzle): number {
  return (db as unknown as { _: { session: StoreRemoteSession } })._.session.preparations
}

/**
 * Run a raw statement prepared once with {@link prepared} — `db.all(sql\`...\`)`
 * kept rather than awaited — with its placeholder values. Drizzle types those
 * values as `undefined`; this is the one cast.
 */
export async function executeRaw<T>(
  raw: SQLiteAsyncRaw<T>,
  values: Record<string, unknown> = {},
): Promise<T> {
  return await raw.execute(values as Record<string, undefined>)
}

export interface StoreQueries {
  /** The ambient async drizzle instance a repository queries through. */
  readonly rootDb: StoreDrizzle
  /** Creates a root transaction or joins the enclosing transaction when nested. */
  readonly createOrJoinTransaction: TransactionRunner
}

/** The executor's ambient transaction: it opens a root transaction or a savepoint under the current one. */
export type ExecutorTransaction = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * ONE DRIZZLE INSTANCE FOR THE STORE'S LIFE, INSIDE TRANSACTIONS AND OUT
 * [POD-6147].
 *
 * `client` is the executor's AMBIENT client: its router resolves `currentScope()`
 * for each statement as it executes, and inside a transaction that is the
 * transaction's frame. So the same instance, and every query prepared on it,
 * runs inside whatever transaction is current, and no repository needs to know
 * whether one is open.
 *
 * WHAT THIS REPLACED. Until POD-6147 each transaction carried a second drizzle
 * instance over a frame-pinned client in an AsyncLocalStorage, and a
 * repository's `db` getter picked it. It decided nothing the router does not
 * decide: the store's scope was set at exactly the points where the executor's
 * own scope is, so the two named the same frame. Where they could differ the
 * executor's is the intended one: `runAtRoot`, the post-commit drain and
 * `outsideTransaction` replace the executor's scope on purpose, and the pinned
 * instance would have sent their statements back into the transaction. What
 * the second instance did cost was one fresh set of builders per transaction,
 * so even queries prepared once per instance (`preparedPerDb`, POD-3854) were
 * prepared again in every transaction.
 */
export function storeQueriesOver(client: QueryClient, transact: ExecutorTransaction): StoreQueries {
  return {
    rootDb: buildStoreDrizzle(client) as unknown as StoreDrizzle,
    /**
     * ROOT AND NESTED ARE THE SAME CALL [POD-3498].
     *
     * There is no `if (enclosing)` branch, and adding one back is the bug this
     * replaced. `transact` here is the executor's AMBIENT form: it resolves
     * `currentScope()` and, inside an open transaction scope, calls
     * `transactOn(scope.frame, fn)` — which opens a SAVEPOINT under the enclosing
     * frame. Joining is what the executor already does; the port only has to ask.
     */
    createOrJoinTransaction: async (fn) => await transact(fn),
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
  return storeQueriesOver(client, async (fn) => await (await executor).transact(async () => await fn()))
}
