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
export type StoreDialect = 'sqlite'

/** The table set a store on `dialect` binds to its drizzle instance. */
export function bindingFor(dialect: StoreDialect): StoreTables {
  switch (dialect) {
    case 'sqlite':
      return sqliteTables
  }
}
