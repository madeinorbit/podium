/**
 * A current-schema database for tests that build one WITHOUT `SessionStore`
 * [POD-523].
 *
 * Sixteen suites construct a bare `openDatabase(':memory:')` and then call
 * `applyBaselineSchema` / `runDrizzleMigrations` on it, because they drive a single
 * repository or need to plant rows the repository would never write. They were
 * paying the same ~408 ms of migration replay as everyone else. This gives them the
 * same clone the store fixture uses.
 *
 * SEPARATE FROM `pre-migrated-store.ts` because that module is on the per-fork setup
 * path for all ~291 apps/server test files and must not pull in the migrator (see its
 * header). This one is imported only by the sixteen files that already imported the
 * migrator, so the fallback below costs them nothing new.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { openDatabase } from '@podium/runtime/sqlite'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { openSchemaClone, schemaImagePath } from './pre-migrated-store'

/**
 * A fresh database at the head of the migration chain.
 *
 * Falls back to running the chain when this run has no image — the A/B arm that
 * disables the fixture, and any lane whose `globalSetup` did not run. Same database
 * either way; only the cost differs.
 */
export function openMigratedTestDatabase(): SqlDatabase {
  if (schemaImagePath() !== undefined) return openSchemaClone()
  // Exactly what these suites did before: no pragmas of their own. A fresh
  // connection's `foreign_keys` default is the same on either path (both 0 under
  // bun:sqlite), so the clone does not quietly change constraint behaviour.
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  return db
}
