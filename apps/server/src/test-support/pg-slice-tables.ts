/**
 * THE TWO-ENGINE SLICE'S POSTGRES TABLES, AND A STORE OVER THEM [POD-6995, POD-6978,
 * POD-6958 design 2.1, 2.3].
 *
 * `store/read-watermarks.ts` and `store/quota-history.ts` run on both engines from one
 * query source. On Postgres their definitions build on the generated Postgres schema
 * (`migrations/pg/schema.ts`, with the sync package's `adapters/pg/schema.ts`), the
 * twins of the SQLite tables in the native types of design 2.3, under the SQLite export
 * names, so `bindingFor('pg', …)` hands each definition its `t.recapWatermarks` and
 * `t.quotaWindows`. `migrations/pg/schema-parity.test.ts` and its type test hold every
 * twin to its SQLite table, which is what makes the binding's one cast safe.
 *
 * {@link openSliceStore} is the slice's store: the repositories' queries on the test
 * run's engine. On SQLite it is a migrated in-memory database through the store
 * executor, as before; on the `server-store-pg` lane a fresh clone of the run's template,
 * which the Postgres baseline migration built (POD-6981), through the Postgres driver (strict timestamps on, the leg's default) and
 * the Postgres query layer over the generated tables.
 */

import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import * as pgSchema from '../migrations/pg/schema'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import type { StoreQueries } from '../store/executor/sync-drizzle'
import { openMigratedTestDatabase } from './migrated-database'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The store's Postgres table set: the server schema's twins and the sync tables' twins. */
export const PG_SLICE_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })

/** The slice's repositories' store on the run's engine. */
export interface SliceStore {
  readonly engine: TestStoreEngine
  /** What the repositories are constructed with, as `store.ts` constructs them. */
  readonly queries: StoreQueries
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  close(): Promise<void>
}

/** The slice's store on the test run's engine (`PODIUM_TEST_STORE_ENGINE`). */
export async function openSliceStore(): Promise<SliceStore> {
  if (testStoreEngine() !== 'pg') {
    const database = openMigratedTestDatabase()
    return {
      engine: 'sqlite',
      queries: stageASeam(database),
      probeTarget: { db: database },
      close: async () => database.close(),
    }
  }
  // The clone holds the whole Postgres schema: the run's template is the migration
  // chain's baseline (POD-6981).
  const { url } = await clonePgTestDatabase()
  // The statement probe's hub, keyed by an object of the store's own, as the bun
  // driver's is keyed by its database; the lane's intent audit grades it too.
  const connection = {}
  const hub = statementProbeHubFor(connection)
  attachLaneIntentAudit(hub)
  const executor: RootStoreExecutor<QueryClient> = createStoreExecutor<QueryClient>({
    driver: instrumentDriver(createPgStoreDriver({ url, poolSize: 2 }), hub),
    queryLayer: pgQueryLayer(PG_SLICE_TABLES),
    startOpen: true,
  })
  return {
    engine: 'pg',
    queries: executor.queries,
    probeTarget: { db: connection },
    close: async () => await executor.close(),
  }
}
