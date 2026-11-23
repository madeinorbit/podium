/**
 * THE STORE'S TABLE BINDING [POD-6977, POD-6958 design §2.1].
 *
 * Every query definition takes its tables from here, as the `t` of
 * `prepared((db, t) => …)`, instead of importing them from
 * `migrations/schema.ts`. The set is bound to the store's drizzle instance when
 * the instance is made (`sync-drizzle.ts`), and `prepared` hands it to each
 * definition it builds on that instance.
 *
 * On SQLite the set is the schema module itself plus the sync adapter's tables,
 * the very objects the definitions imported before, so every statement renders
 * the SQL it always did. An engine with its own tables binds those instead,
 * cast to these types in {@link bindingFor} alone, and the same definition
 * source builds on them.
 */

import { sqliteSyncTables } from '@podium/sync/adapters/sqlite/sync-repository'
import * as schema from '../../migrations/schema'

/** The tables a definition's `t` carries: the server schema and the sync tables. */
export type StoreTables = typeof schema & typeof sqliteSyncTables

const sqliteTables: StoreTables = Object.freeze({ ...schema, ...sqliteSyncTables })

/** The engines a store can open on. */
export type StoreDialect = 'sqlite' | 'pg'

/**
 * A Postgres table set: the Postgres twins of the server schema and the sync tables,
 * under the same export names (POD-6978's `migrations/pg/schema.ts` and
 * `packages/sync/src/adapters/pg/schema.ts`; until they exist, a test's own twins).
 */
export type PgTableSet = Readonly<Record<string, unknown>>

/**
 * The table set a store on `dialect` binds to its drizzle instance.
 *
 * THE ONE CAST [design 2.1 step 2]. A Postgres table set is typed as the SQLite one,
 * so every definition is written, and typechecked, once. What makes the cast safe is
 * outside this function: the schema parity check proves each Postgres table has its
 * SQLite twin's property names and `$inferSelect`/`$inferInsert` types, the dialect
 * census builds every definition on the Postgres tables, and the two-engine suite runs
 * them.
 */
export function bindingFor(dialect: 'sqlite'): StoreTables
export function bindingFor(dialect: 'pg', tables: PgTableSet): StoreTables
export function bindingFor(dialect: StoreDialect, tables?: PgTableSet): StoreTables {
  switch (dialect) {
    case 'sqlite':
      return sqliteTables
    case 'pg':
      if (tables === undefined) throw new Error('a Postgres binding needs its table set')
      return Object.freeze({ ...tables }) as unknown as StoreTables
  }
}
