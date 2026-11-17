/**
 * THE POSTGRES STORE'S LIFECYCLE [POD-6994, POD-6958 design 2.7, 2.8].
 *
 * The Postgres implementation of the store-lifecycle port (`../store-lifecycle.ts`),
 * loaded only for a `postgres://` location, so a SQLite store never loads postgres.js.
 *
 * WHAT IT DOES AT OPEN. The ledger check (`preparePgStoreSchema`): a database behind
 * this build, or carrying a migration it does not know, is refused, because on hosted
 * migrating is a deploy step (`podium server migrate`). With `migrateAtBoot` (tests and
 * local development) it migrates instead. Then one pool and the store's executor over it,
 * on the Postgres query layer and the full twin of the store's tables.
 *
 * WHAT IT DOES NOT DO. The SQLite steps the port exists for are the platform's on hosted
 * Postgres (design 2.8): no pre-migration backup or recovery snapshot (backups and
 * point-in-time recovery), no planner statistics (autoanalyze; the deploy step runs
 * `ANALYZE`), no temp store, no WAL checkpoint, no transfer (hosted has none, design
 * 2.9, so its three steps refuse), and no one-time imports of legacy files (a Postgres
 * install has none).
 *
 * THE CAPTURE SWITCH (`store/executor/pg-capture-detached.ts`). Until the store attaches
 * its change capture, a write transaction drops its own capture rows just before COMMIT,
 * which is what SQLite's store does by having no capture triggers until then. After the
 * attach a write must drain what it captured, on both engines.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import type { QueryClient } from '../../store/executor/driver'
import { createStoreExecutor } from '../../store/executor/executor'
import { attachLaneIntentAudit } from '../../store/executor/lane-intent-audit'
import { captureDetachedDriver } from '../../store/executor/pg-capture-detached'
import { createPgStoreDriver } from '../../store/executor/pg-driver'
import { pgQueryLayer } from '../../store/executor/pg-drizzle'
import {
  installQueryAttributionProbe,
  instrumentDriver,
  statementProbeHubFor,
} from '../../store/executor/statement-probe'
import type { StoreLifecycle, StoreLifecycleOptions } from '../store-lifecycle'
import { preparePgStoreSchema } from './index'
import * as pgSchema from './schema'

/** The store's Postgres tables: the server schema's twins and the sync tables' twins. */
export const PG_STORE_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })

/** A step a Postgres store has no counterpart for (design 2.9: hosted has no transfer). */
class PgStoreHasNoTransferError extends Error {
  constructor(step: string) {
    super(`${step}: a Postgres store is not transferred; a server transfer moves a SQLite file`)
    this.name = 'PgStoreHasNoTransferError'
  }
}

/**
 * The key the store's statement probe hub is registered under. It stands where a
 * SQLite store has its database handle (`SessionStore.db`, the tests' raw reads), and
 * refuses any use as one, naming why, so a test reading SQLite rows directly fails
 * with the reason instead of an undefined call.
 */
function pgConnectionKey(): SqlDatabase {
  return new Proxy(Object.freeze({}), {
    get(_target, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined
      throw new TypeError(
        `a Postgres store has no SQLite handle (store.db.${key}): read through a ` +
          'repository, or list the test under sqliteOnly in apps/server/test-store-engines.json',
      )
    },
  }) as unknown as SqlDatabase
}

/** Open the lifecycle of the Postgres store at `url`. */
export async function openPgStoreLifecycle(
  url: string,
  options: StoreLifecycleOptions,
): Promise<StoreLifecycle> {
  const migrationStarted = performance.now()
  const applied = await preparePgStoreSchema(url, {
    ...(options.migrateAtBoot === undefined ? {} : { migrateAtBoot: options.migrateAtBoot }),
  })
  options.stage('migrations', migrationStarted)
  const connection = pgConnectionKey()
  const probes = statementProbeHubFor(connection)
  installQueryAttributionProbe(probes)
  // As the SQLite composition root: the lane's audit only when a corpus run asks.
  if (process.env.PODIUM_STATEMENT_INTENT_REPORT) attachLaneIntentAudit(probes)
  const openStarted = performance.now()
  const capture = captureDetachedDriver(createPgStoreDriver({ url }))
  const executor = createStoreExecutor<QueryClient>({
    driver: instrumentDriver(capture.driver, probes),
    queryLayer: pgQueryLayer(PG_STORE_TABLES),
    startOpen: true,
    ...options.sinks,
  })
  options.stage('store open', openStarted)
  return {
    executor,
    connection,
    applied,
    keepsPlannerStatistics: false,
    legacyIdentityStorage: false,
    async attachChangeCapture() {
      capture.attach()
    },
    async refreshPlannerStatistics() {},
    async serveTraffic() {},
    async schemaVersionForTransfer() {
      throw new PgStoreHasNoTransferError('schemaVersionForTransfer')
    },
    async checkpointForTransfer() {
      throw new PgStoreHasNoTransferError('checkpointForTransfer')
    },
    async setTransferFence() {
      throw new PgStoreHasNoTransferError('setTransferFence')
    },
    async retireImportedIdentityStorage() {},
    preflightUpdateBackup: () => ({ ok: true }),
    latestDatabaseSnapshot: () => undefined,
    discoverDatabaseSnapshots: () => false,
    async closeSnapshots() {},
  }
}
