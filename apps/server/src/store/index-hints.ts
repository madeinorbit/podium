/**
 * NAMED INDEXES ON SQLITE (POD-7034 and its kin): a FROM that is an `INDEXED BY`
 * clause, and the bare-column selection such a FROM needs. Postgres has no index
 * hints; its arm reads the table and its planner picks from its own statistics.
 *
 * The selection is built from the table a definition is handed (`t`), so no
 * repository imports a table object from the schema module (POD-6959).
 */

import { getTableColumns, type InferSelectModel, type SQL, sql, type Table } from 'drizzle-orm'
import { dialectOf } from './executor/dialect-prepared'
import type { StoreDrizzle } from './executor/sync-drizzle'

/** `table INDEXED BY index` on SQLite, the table alone on Postgres. */
export function throughIndex(db: StoreDrizzle, table: Table, index: string): SQL {
  return dialectOf(db) === 'pg' ? sql`${table}` : sql`${table} INDEXED BY ${sql.raw(index)}`
}

/**
 * Every column by its bare name, mapped as the table maps it, for a FROM that is
 * an `INDEXED BY` clause rather than the table object: drizzle refuses a table
 * column over a raw FROM.
 */
export type BareColumns<T extends Table> = {
  [K in keyof InferSelectModel<T>]: SQL<InferSelectModel<T>[K]>
}

const built = new WeakMap<Table, unknown>()

export function bareColumns<T extends Table>(table: T): BareColumns<T> {
  const hit = built.get(table)
  if (hit !== undefined) return hit as BareColumns<T>
  const columns = Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      sql`${sql.identifier(column.name)}`.mapWith(column),
    ]),
  ) as BareColumns<T>
  built.set(table, columns)
  return columns
}
