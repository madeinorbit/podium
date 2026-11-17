/**
 * THE STORE'S DRIZZLE INSTANCE ON POSTGRES, WITH SQLITE'S RESULT SHAPES [POD-6979,
 * POD-6958 design 2.1 step 3].
 *
 * Repositories end a query in `.get()`, `.all()`, `.run()` or `.values()`, which is
 * SQLite's prepared-query surface; a Postgres prepared query has only `.execute()`. This
 * module subclasses `drizzle-orm/pg-proxy`'s session, the way `StoreRemoteSession`
 * subclasses sqlite-proxy's (`sync-drizzle.ts`), so every query it prepares carries the
 * same four methods with SQLite's shapes:
 *
 * | method   | result                                                          |
 * |----------|-----------------------------------------------------------------|
 * | `get`    | the first row, or `undefined`                                   |
 * | `all`    | every row                                                       |
 * | `values` | every row as an array of its values, in column order            |
 * | `run`    | `{ rows: [], changes, lastInsertRowid: undefined }`             |
 *
 * The raw forms (`db.all(sql)`, `db.get(sql)`, `db.run(sql)`, `db.values(sql)`) are added
 * to the database with the same shapes: they are what the store's whole raw statements
 * use (design 1.1, "Raw statements"). Each returns a query whose `execute(values)` runs
 * it, as SQLite's raw queries do, so `executeRaw` and the bound views work unchanged.
 *
 * Every statement goes through the store's {@link QueryClient} with the intent SQLite's
 * session gives it: a builder SELECT reads, every other builder query and every raw
 * statement writes. Values are converted by the driver's type handlers (`pg-types.ts`),
 * not here.
 *
 * `lastInsertRowid` has no Postgres value; its three users move to `RETURNING` first
 * (design 1.1). Drizzle's `batch` is not provided: no repository uses it.
 */

import { bindTables } from '@podium/sync/adapters/sqlite/prepared'
import {
  type EmptyRelations,
  fillPlaceholders,
  NoopLogger,
  type Query,
  QueryPromise,
  type SQLWrapper,
  sql,
} from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { PgAsyncPreparedQuery } from 'drizzle-orm/pg-core/async'
import { PgRemoteDatabase } from 'drizzle-orm/pg-proxy'
import { PgRemoteSession } from 'drizzle-orm/pg-proxy/session'
import { bindingFor, type PgTableSet } from './binding'
import type { QueryClient, SqlParam, SqlRunResult, StatementIntent } from './driver'
import type { StoreDrizzle } from './sync-drizzle'

type PrepareMode = 'arrays' | 'objects' | 'raw'
type QueryMetadata = { type: 'select' | 'update' | 'delete' | 'insert'; tables: string[] }

/** SQLite's `run` result shape. */
export type PgRunResult = SqlRunResult & { readonly rows: readonly unknown[] }

function valuesOf(row: unknown): unknown[] {
  if (Array.isArray(row)) return row
  if (row !== null && typeof row === 'object') return Object.values(row)
  return [row]
}

/**
 * A query prepared on the store's Postgres session: drizzle's own prepared query (its
 * placeholders, mapper and `execute`), plus SQLite's `get`, `all`, `run` and `values`.
 */
export class StorePgPreparedQuery extends PgAsyncPreparedQuery<never> {
  constructor(
    private readonly client: QueryClient,
    private readonly intent: StatementIntent,
    query: Query,
    mapper: ((rows: unknown[]) => unknown) | undefined,
    mode: PrepareMode,
    queryMetadata: QueryMetadata | undefined,
  ) {
    super(
      async (params?: unknown[]) => {
        const rows = await fetchRows(client, intent, statementText(query), params ?? [])
        return mode === 'arrays' ? rows.map(valuesOf) : rows
      },
      query,
      mapper,
      mode,
      new NoopLogger(),
      undefined,
      queryMetadata,
      undefined,
    )
  }

  private filled(values: Record<string, unknown> | undefined): SqlParam[] {
    const query = this.getQuery()
    return (
      query.params.length === 0 ? query.params : fillPlaceholders(query.params, values ?? {})
    ) as SqlParam[]
  }

  /** Every row, mapped as drizzle maps them. */
  async all(values?: Record<string, unknown>): Promise<unknown[]> {
    return (await this.execute(values)) as unknown as unknown[]
  }

  /** The first row, or `undefined`. */
  async get(values?: Record<string, unknown>): Promise<unknown> {
    return (await this.all(values))[0]
  }

  /** Every row as its values in column order, unmapped. */
  async values(values?: Record<string, unknown>): Promise<unknown[][]> {
    const rows = await fetchRows(
      this.client,
      this.intent,
      statementText(this.getQuery()),
      this.filled(values),
    )
    return rows.map(valuesOf)
  }

  /** Run for its effect: `{ rows: [], changes, lastInsertRowid }`, as on SQLite. */
  async run(values?: Record<string, unknown>): Promise<PgRunResult> {
    const text = statementText(this.getQuery())
    const params = this.filled(values)
    // QueryClient.run declares a write. A SELECT run for its effect still reads.
    const result =
      this.intent === 'write'
        ? await this.client.run(text, ...params)
        : (await this.client.batch([{ sql: text, params, method: 'run', intent: 'read' }]))[0]?.run
    if (result === undefined) throw new Error(`driver returned no run result for: ${text}`)
    return { rows: [], ...result }
  }
}

function statementText(query: Query): string {
  const tagged = (query as Query & { _sql?: string[] })._sql
  return tagged ? tagged.join(' ') : query.sql
}

async function fetchRows(
  client: QueryClient,
  intent: StatementIntent,
  text: string,
  params: readonly unknown[],
): Promise<unknown[]> {
  const bound = params as SqlParam[]
  return intent === 'read'
    ? await client.all(text, ...bound)
    : await client.writeAll(text, ...bound)
}

/**
 * The store's Postgres session. Every query drizzle prepares on it is a
 * {@link StorePgPreparedQuery} over the store's client; the proxy callback the base
 * class keeps is never called.
 */
class StorePgSession extends PgRemoteSession<EmptyRelations> {
  /** Every query this session has prepared: builder terminals, `.prepare()` and raw calls. */
  preparations = 0

  constructor(
    private readonly queryClient: QueryClient,
    dialect: PgDialect,
  ) {
    super(
      async () => {
        throw new Error('the store Postgres session prepares every query itself')
      },
      dialect,
      {},
    )
  }

  override prepareQuery(
    query: Query,
    mode: PrepareMode,
    _name: string | boolean,
    mapper: ((rows: unknown[]) => unknown) | undefined,
    queryMetadata?: QueryMetadata,
  ): StorePgPreparedQuery {
    this.preparations += 1
    // As on SQLite (`StoreRemoteSession`): a builder SELECT reads; every other
    // builder query, and every raw statement (which carries no metadata), writes.
    const intent: StatementIntent = queryMetadata?.type === 'select' ? 'read' : 'write'
    return new StorePgPreparedQuery(this.queryClient, intent, query, mapper, mode, queryMetadata)
  }
}

type RawMethod = 'all' | 'get' | 'run' | 'values'

/**
 * A raw statement, kept rather than awaited: `execute(values)` runs it with its
 * placeholder values and awaiting it runs it with none, as SQLite's raw queries do.
 */
export class StorePgRaw<T> extends QueryPromise<T> {
  constructor(
    private readonly prepared: StorePgPreparedQuery,
    private readonly method: RawMethod,
  ) {
    super()
  }

  override async execute(values?: Record<string, unknown>): Promise<T> {
    return (await this.prepared[this.method](values)) as T
  }

  /** The statement and its parameters, as drizzle's `toSQL()` gives them. */
  toSQL(): Query {
    return this.prepared.getQuery()
  }
}

/** The Postgres database with SQLite's raw methods. */
class StorePgDatabase extends PgRemoteDatabase<EmptyRelations> {
  constructor(
    private readonly storeDialect: PgDialect,
    private readonly storeSession: StorePgSession,
  ) {
    super(storeDialect, storeSession, {})
  }

  private raw<T>(query: SQLWrapper | string, method: RawMethod): StorePgRaw<T> {
    const built = typeof query === 'string' ? sql.raw(query) : query.getSQL()
    const prepared = this.storeSession.prepareQuery(
      this.storeDialect.sqlToQuery(built),
      'raw',
      false,
      undefined,
    )
    return new StorePgRaw<T>(prepared, method)
  }

  all<T = unknown>(query: SQLWrapper | string): StorePgRaw<T[]> {
    return this.raw<T[]>(query, 'all')
  }

  get<T = unknown>(query: SQLWrapper | string): StorePgRaw<T> {
    return this.raw<T>(query, 'get')
  }

  run(query: SQLWrapper | string): StorePgRaw<PgRunResult> {
    return this.raw<PgRunResult>(query, 'run')
  }

  values<T extends unknown[] = unknown[]>(query: SQLWrapper | string): StorePgRaw<T[]> {
    return this.raw<T[]>(query, 'values')
  }

  batch(): never {
    throw new Error('drizzle batch is not provided on the Postgres store: no repository uses it')
  }
}

/**
 * The store's drizzle instance on Postgres over `client`, bound to `tables`, typed as
 * the SQLite instance every definition is written against. The table cast is
 * `bindingFor`'s (`binding.ts`); this one cast is the database's, and the schema parity
 * check, the dialect census and the two-engine suite are what make both safe
 * (design 2.1 step 2).
 */
export function buildPgStoreDrizzle(client: QueryClient, tables: PgTableSet): StoreDrizzle {
  const dialect = new PgDialect()
  const db = new StorePgDatabase(dialect, new StorePgSession(client, dialect))
  return bindTables(db, bindingFor('pg', tables)) as unknown as StoreDrizzle
}
