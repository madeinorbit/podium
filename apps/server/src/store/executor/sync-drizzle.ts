/** Async query builders and transaction ports bound to the store executor. */

import type { WorkspaceId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import {
  bindTables,
  boundTables,
  type CrossWorkspaceEntry,
  type FillValues,
  type FleetHandle,
  fleetHandle,
  type PreparedAccessor,
  type PreparedFamilyAccessor,
  preparedAcross as preparedAcrossOn,
  preparedFamily as preparedFamilyOn,
  preparedGlobal as preparedGlobalOn,
  prepared as preparedOn,
  type QueryHandle,
  queryHandle,
  type WorkspaceHandle,
} from '@podium/sync/adapters/sqlite/prepared'
import type { EmptyRelations } from 'drizzle-orm'
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch'
import type { SQLiteAsyncRaw } from 'drizzle-orm/sqlite-core'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { type AsyncRemoteCallback, SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { type PreparedQueryConfig, SQLiteRemoteSession } from 'drizzle-orm/sqlite-proxy/session'
import type { InstallTableExport } from '../workspace-manifest'
import { bindingFor, type StoreDialect, type StoreTables } from './binding'
import { currentStoreContext, runRootStatementIn } from './context'
import type { QueryClient, SqlRunResult, StatementIntent } from './driver'
import { GLOBAL_CONTEXT, type StoreContext, workspaceContext } from './executor'

export {
  type Bound,
  CallerWorkspaceValueError,
  type CrossWorkspaceEntry,
  CrossWorkspaceStatementError,
  type FillValues,
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  notInListOf,
  param,
  placeholdersFor,
  preparedFamilyOverflows,
  sameWorkspace,
  shapeOf,
  WORKSPACE,
  WorkspaceScopeError,
  WorkspaceStatementInGlobalTransactionError,
} from '@podium/sync/adapters/sqlite/prepared'
export type { StoreTables } from './binding'

/**
 * The install tables only: what a global definition's `t` carries, so a global
 * definition that names a workspace table does not compile [POD-6959 design
 * 2.4]. The same object as {@link StoreTables}, typed narrower.
 */
export type GlobalTables = Pick<StoreTables, InstallTableExport>

/**
 * A query handle: the store's drizzle instance with the context its repository
 * was built for. A global repository holds one with the global context.
 */
export type StoreDb = QueryHandle<StoreDrizzle>

/**
 * A workspace's query handle. It extends {@link StoreDb}, so a workspace
 * repository may run global definitions; a workspace definition takes only this.
 */
export type WorkspaceDb = WorkspaceHandle<StoreDrizzle>

/** The fleet handle: the only handle a cross-workspace read runs on. */
export type FleetDb = FleetHandle<StoreDrizzle>

/**
 * ONE QUERY, PREPARED ONCE PER STORE, BUILT FROM THE STORE'S TABLES [POD-6147,
 * POD-6977]. `prepared((db, t) => db.select().from(t.issues)…)`: `t` is the
 * table set bound to the store's drizzle instance (`./binding.ts`), so a
 * definition names no table it imports. The package's function under the
 * store's types; it is the same function, so each definition's registered site
 * stays its own line (the query-plan audit maps definitions by it).
 */
export const prepared: <P>(
  build: (db: StoreDrizzle, t: StoreTables) => P,
) => PreparedAccessor<StoreDrizzle, P> = preparedOn

/** A bounded set of prepared queries, one per shape; see the package's `preparedFamily`. */
export const preparedFamily: <K extends string | number, P>(
  build: (db: StoreDrizzle, t: StoreTables, key: K) => P,
) => PreparedFamilyAccessor<StoreDrizzle, K, P> = preparedFamilyOn

/** A global definition: install tables only, run on any store handle (POD-6959 design 2.4). */
export const preparedGlobal: <P>(
  build: (db: StoreDrizzle, t: GlobalTables) => P,
) => (db: StoreDb) => P = preparedGlobalOn

/** A cross-workspace read, named by its allowlist entry, run on the fleet handle. */
export const preparedAcross: <P>(
  entry: CrossWorkspaceEntry,
  build: (db: StoreDrizzle, t: StoreTables) => P,
) => (db: FleetDb) => P = preparedAcrossOn

/**
 * The tables bound to `db`, for the rare call site outside a definition that
 * needs a column of the same engine (a guard another helper builds).
 */
export function storeTables(db: StoreDrizzle): StoreTables {
  return boundTables(db) as StoreTables
}

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
      remoteCallback(queryClient, 'read', false),
      dialect,
      {},
    )
    this.arrayReadingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'read', true),
      dialect,
      {},
    )
    this.arrayWritingSession = new SQLiteRemoteSession(
      remoteCallback(queryClient, 'write', true),
      dialect,
      {},
    )
  }

  override prepareQuery<T extends Omit<PreparedQueryConfig, 'run'>>(...args: PrepareArguments) {
    this.preparations += 1
    const intent = args[5]?.type === 'select' ? 'read' : 'write'
    const arrays = args[1] === 'arrays'
    const prepared = arrays
      ? (intent === 'read' ? this.arrayReadingSession : this.arrayWritingSession).prepareQuery<T>(
          ...args,
        )
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
        rows:
          row === undefined
            ? (undefined as unknown as unknown[])
            : (resultRow(row, arrayRows) as unknown[]),
      }
    }
    const rows =
      intent === 'read' ? await client.all(sql, ...params) : await client.writeAll(sql, ...params)
    return { rows: rows.map((row) => resultRow(row, arrayRows)) }
  }
}

function buildStoreDrizzle(client: QueryClient): StoreDrizzle {
  const dialect = new SQLiteDialect()
  return bindTables(
    new SqliteRemoteDatabase('async', dialect, new StoreRemoteSession(client, dialect), {}),
    bindingFor('sqlite'),
  ) as unknown as StoreDrizzle
}

/**
 * THE ENGINE'S QUERY LAYER [POD-6979]: which drizzle dialect, over which tables, a
 * store's one drizzle instance is built on. Chosen with the driver: the executor
 * refuses a layer whose dialect is not its driver's. The Postgres layer is
 * `pgQueryLayer` (`pg-drizzle.ts`), passed in by the Postgres opener, so a SQLite
 * store never loads drizzle's Postgres modules.
 */
export interface QueryLayer {
  readonly dialect: StoreDialect
  build(client: QueryClient): StoreDrizzle
}

/** The SQLite query layer: sqlite-proxy over the SQLite schema. */
export const SQLITE_QUERY_LAYER: QueryLayer = Object.freeze({
  dialect: 'sqlite' as const,
  build: buildStoreDrizzle,
})

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
  raw: SQLiteAsyncRaw<T> | { readonly execute: (values?: FillValues) => Promise<T> },
  values: Record<string, unknown> = {},
): Promise<T> {
  // A bound view (a workspace handle's) fills the workspace; a bare raw
  // statement takes the values as they are. A method call either way, so the
  // bare statement keeps its receiver.
  return await (raw as { execute(values: Record<string, unknown>): Promise<T> }).execute(values)
}

/**
 * WHAT A GLOBAL REPOSITORY IS HANDED [POD-6959 design 2.4]: the global handle
 * and a transaction runner that opens with the global context (and joins any
 * open transaction, since a workspace's work may include install tables).
 */
export interface GlobalQueries {
  readonly db: StoreDb
  /** Creates a root transaction or joins the enclosing transaction when nested. */
  readonly createOrJoinTransaction: TransactionRunner
  /**
   * LEGACY until POD-7010 moves the repositories onto handles: the bare drizzle
   * instance, which a workspace definition's accessor still takes unbound.
   */
  readonly rootDb: StoreDrizzle
}

/**
 * WHAT A WORKSPACE REPOSITORY IS HANDED: the workspace's handle, which fills the
 * `workspaceId` of every workspace statement, and a transaction runner that
 * opens with the workspace's context and joins only that workspace's work.
 * Made by {@link workspaceQueries}, once per workspace's repository set.
 */
export interface WorkspaceQueries {
  readonly db: WorkspaceDb
  readonly createOrJoinTransaction: TransactionRunner
}

/**
 * WHAT A WORKSPACE REPOSITORY IS HANDED UNTIL ITS SCOPING TASK LANDS (POD-7015
 * to POD-7023): its workspace's queries, plus the bare drizzle instance its
 * definitions still run on unbound.
 *
 * The transaction runner is the workspace's, so every transaction such a
 * repository opens is for its workspace already. Its statements bind once the
 * repository reads `db` instead of `rootDb`; that task also narrows the
 * repository's constructor from {@link StoreQueries} to {@link WorkspaceQueries}.
 * It satisfies {@link StoreQueries} structurally, which is how the repositories
 * accept it with no change to their files.
 */
export type LegacyWorkspaceQueries = WorkspaceQueries & Pick<GlobalQueries, 'rootDb'>

/**
 * LEGACY until each repository's scoping task narrows its constructor to
 * {@link GlobalQueries} or {@link WorkspaceQueries}: the shape every repository
 * constructor names today. A {@link LegacyWorkspaceQueries} satisfies it.
 */
export type StoreQueries = GlobalQueries

/** {@link workspaceQueries} with the legacy `rootDb`, for the repository set of one workspace. */
export function legacyWorkspaceQueries(
  base: GlobalQueries,
  workspaceId: WorkspaceId,
): LegacyWorkspaceQueries {
  return Object.freeze({ ...workspaceQueries(base, workspaceId), rootDb: base.rootDb })
}

/**
 * The executor's ambient transaction: it opens a root transaction with
 * `context` (global when omitted) or joins the current one under the join rules.
 */
export type ExecutorTransaction = <T>(fn: () => Promise<T>, context?: StoreContext) => Promise<T>

/** The executor transaction behind each store's queries, for {@link workspaceQueries}. */
const transactionsOf = new WeakMap<GlobalQueries, ExecutorTransaction>()

/** The dialect of each store's queries, for {@link workspaceQueries}. */
const dialectsOf = new WeakMap<GlobalQueries, StoreDialect>()

/**
 * One workspace's queries over the store's drizzle instance: the same prepared
 * statements as every other workspace, bound to this one. Called once per
 * workspace repository set (POD-7010's `StoreDatabase.workspace(id)`); a bound
 * view is cached per handle, so a handle made per call would rebind every call.
 */
export function workspaceQueries(base: GlobalQueries, workspaceId: WorkspaceId): WorkspaceQueries {
  const transact = transactionsOf.get(base)
  if (transact === undefined) {
    throw new Error('workspace queries are made from the queries a store executor built')
  }
  const context = workspaceContext(workspaceId)
  // On Postgres a root statement of this workspace tells the driver its workspace,
  // so a root write takes the workspace's lock (POD-6958 design 2.4). SQLite's
  // single connection serialises every write, so its handles run statements as is.
  const runAtRoot = dialectsOf.get(base) === 'pg' ? runRootStatementIn : undefined
  return Object.freeze({
    db: queryHandle(base.rootDb, context, currentStoreContext, runAtRoot),
    createOrJoinTransaction: async <T>(fn: () => Promise<T>) => await transact(fn, context),
  })
}

/** The fleet handle over the store's drizzle instance, for cross-workspace reads. */
export function fleetDb(base: GlobalQueries): FleetDb {
  return fleetHandle(base.rootDb)
}

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
export function storeQueriesOver(
  client: QueryClient,
  transact: ExecutorTransaction,
  layer: QueryLayer = SQLITE_QUERY_LAYER,
): GlobalQueries {
  const rootDb = layer.build(client)
  const queries: GlobalQueries = {
    db: queryHandle(rootDb, GLOBAL_CONTEXT, currentStoreContext),
    rootDb,
    /**
     * ROOT AND NESTED ARE THE SAME CALL [POD-3498].
     *
     * There is no `if (enclosing)` branch, and adding one back is the bug this
     * replaced. `transact` here is the executor's AMBIENT form: it resolves
     * `currentScope()` and, inside an open transaction scope, calls
     * `transactOn(scope.frame, fn)` — which opens a SAVEPOINT under the enclosing
     * frame. Joining is what the executor already does; the port only has to ask.
     */
    createOrJoinTransaction: async (fn) => await transact(fn, GLOBAL_CONTEXT),
  }
  transactionsOf.set(queries, transact)
  dialectsOf.set(queries, layer.dialect)
  return queries
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
    async (fn, context) => await (await executor).transact(async () => await fn(), context),
  )
}
