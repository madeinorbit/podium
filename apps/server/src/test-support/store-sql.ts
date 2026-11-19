/**
 * RAW SQL ON A TEST STORE, ON EITHER ENGINE [POD-7103].
 *
 * A store test sometimes needs a row no repository writes (a hand edit, a corrupt value, a
 * legacy column) or reads a column no repository returns. Reaching for the store's SQLite
 * handle (`store.db.prepare(…)`) ties the test to SQLite; these go through the store's own
 * drizzle instance instead, so a statement written with drizzle's `sql` template renders
 * each engine's placeholders and runs on the run's engine (`PODIUM_TEST_STORE_ENGINE`).
 *
 * Each call runs in the store's workspace transaction (joining one already open), as a
 * repository's own statement would: on Postgres a write outside one has no workspace lock.
 * A test store opens with no change log attached, so nothing these writes capture reaches
 * a commit on either engine (`StoreDatabase.attachChangeLog`).
 *
 * The values come back as each engine returns them: on Postgres a timestamp is ISO text, a
 * `json` column JSON text, a `boolean` a boolean and a `numeric` aggregate a string. A test
 * that compares them writes the statement so both engines return the same thing (cast in
 * SQL, or compare what the value means).
 */

import { type SQL, sql } from 'drizzle-orm'
import type { SessionStore } from '../store'
import type { LegacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { type TestStoreEngine, testStoreEngine } from './pg-test-database'

/** Raw statements on one test store. */
export interface StoreSql {
  /** The engine the store runs on. */
  readonly engine: TestStoreEngine
  /** Runs one statement and discards its rows. */
  run(statement: SQL): Promise<void>
  /** Every row one statement returns. */
  all<T>(statement: SQL): Promise<T[]>
  /** The first row one statement returns. */
  get<T>(statement: SQL): Promise<T | undefined>
  /** Runs `work` in one transaction: the calls inside it join it, and a throw rolls it back. */
  transaction<T>(work: () => Promise<T>): Promise<T>
}

/** Raw SQL on `store`'s database, in its workspace's transaction. */
export function storeSql(store: SessionStore): StoreSql {
  const { queries } = store as unknown as { queries: LegacyWorkspaceQueries }
  const all = async <T>(statement: SQL): Promise<T[]> =>
    (await queries.createOrJoinTransaction(async () => await queries.rootDb.all(statement))) as T[]
  return {
    engine: testStoreEngine(),
    run: async (statement) => {
      await queries.createOrJoinTransaction(async () => {
        await queries.rootDb.run(statement)
      })
    },
    all,
    get: async <T>(statement: SQL) => (await all<T>(statement))[0],
    transaction: async <T>(work: () => Promise<T>) =>
      (await queries.createOrJoinTransaction(work)) as T,
  }
}

/**
 * Counts the row UPDATEs that actually fire on `tables` from now on: an AFTER UPDATE trigger
 * on each records one row per updated row, on either engine. The count is the conserved
 * quantity of a "writes nothing when nothing changed" test; a no-op upsert that an engine
 * still rewrites shows up here. Returns the count so far, of one table or of all of them.
 */
export async function updateCounter(
  store: SessionStore,
  tables: readonly string[],
): Promise<(table?: string) => Promise<number>> {
  const raw = storeSql(store)
  await raw.run(sql`CREATE TABLE IF NOT EXISTS _update_probe (t TEXT)`)
  if (raw.engine === 'pg') {
    await raw.run(sql`CREATE OR REPLACE FUNCTION _update_probe_row() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN INSERT INTO _update_probe VALUES (TG_TABLE_NAME); RETURN NULL; END $$`)
  }
  for (const table of tables) {
    const trigger = sql.identifier(`_update_probe_${table}`)
    await raw.run(
      raw.engine === 'pg'
        ? sql`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${sql.identifier(table)}
            FOR EACH ROW EXECUTE FUNCTION _update_probe_row()`
        : sql`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${sql.identifier(table)}
            BEGIN INSERT INTO _update_probe VALUES (${sql.raw(`'${table}'`)}); END`,
    )
  }
  return async (table) => {
    const row = await raw.get<{ n: number | string }>(
      table === undefined
        ? sql`SELECT COUNT(*) AS n FROM _update_probe`
        : sql`SELECT COUNT(*) AS n FROM _update_probe WHERE t = ${table}`,
    )
    return Number(row?.n ?? 0)
  }
}

/** The primary key columns of `table`, in key order, from each engine's catalogue. */
async function primaryKeyOf(raw: StoreSql, table: string): Promise<string[]> {
  const rows = await raw.all<{ name: string }>(
    raw.engine === 'pg'
      ? sql`SELECT k.column_name AS name
            FROM information_schema.table_constraints c
            JOIN information_schema.key_column_usage k
              ON k.constraint_schema = c.constraint_schema AND k.constraint_name = c.constraint_name
            WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = current_schema()
              AND c.table_name = ${table}
            ORDER BY k.ordinal_position`
      : sql`SELECT name FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk`,
  )
  return rows.map((row) => row.name)
}

/**
 * One workspace's rows of `table`, every column, ordered by the table's primary key: the
 * same order on both engines, where SQLite's rowid (insertion order) has no Postgres twin. A
 * table with no primary key is ordered by every column, left to right.
 */
export async function workspaceRows(
  store: SessionStore,
  table: string,
  workspaceId: string,
): Promise<Record<string, unknown>[]> {
  const raw = storeSql(store)
  const key = await primaryKeyOf(raw, table)
  const order =
    key.length > 0
      ? sql.join(
          key.map((column) => sql.identifier(column)),
          sql`, `,
        )
      : sql`1`
  const rows = await raw.all<Record<string, unknown>>(
    sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${workspaceId} ORDER BY ${order}`,
  )
  if (key.length > 0) return rows
  const text = (row: Record<string, unknown>) => JSON.stringify(Object.values(row))
  return rows.sort((x, y) => (text(x) < text(y) ? -1 : text(x) > text(y) ? 1 : 0))
}
