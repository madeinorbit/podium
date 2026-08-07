/**
 * The migration-chain half of the pre-migrated store fixture [POD-523]: it runs the
 * real 54 migrations once and takes the resulting page image.
 *
 * Split out from `pre-migrated-store.build.ts` so that importing the drizzle
 * migrator is confined to the cache-miss branch — see that file's header for why
 * the module graph is kept off the per-fork path.
 */

import { openDatabase, openDatabaseFromImage, serializeDatabase } from '@podium/runtime/sqlite'
import { appliedDrizzleNames, runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'

/**
 * A fresh database advanced to the head of the chain, as a page image.
 *
 * It is the byte image of a database built BY RUNNING THE REAL MIGRATIONS — not a
 * schema dump and not a checked-in file — so it carries exactly what the chain
 * produces: tables, indexes, triggers, the `__drizzle_migrations` ledger, and the
 * rows the ten migrations with DML insert. Nothing here transcribes the schema, so
 * nothing here can drift from it.
 */
export function buildSchemaImage(): Uint8Array {
  const db = openDatabase(':memory:')
  // The same window `SessionStore` opens for the migrator: the chain rebuilds
  // tables (create/copy/drop/rename), which with foreign keys on would
  // cascade-delete the rows it is copying.
  db.exec('PRAGMA foreign_keys = OFF')
  const applied = runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  if (applied.length !== DRIZZLE_MIGRATIONS.length) {
    throw new Error(
      `pre-migrated fixture: a fresh database should apply all ${DRIZZLE_MIGRATIONS.length} ` +
        `migrations, applied ${applied.length}`,
    )
  }
  const image = serializeDatabase(db)
  db.close()
  return image
}

/**
 * Refuse an image whose ledger is not exactly the manifest. The fingerprint already
 * makes a stale image a DIFFERENT file; this catches what a hash cannot — a
 * truncated write, a file left by another tool, a hand-edited cache.
 */
export function assertImageMatchesManifest(image: Uint8Array): void {
  const db = openDatabaseFromImage(image)
  try {
    const ledger = appliedDrizzleNames(db)
    const expected = DRIZZLE_MIGRATIONS.map((m) => m.name)
    const missing = expected.filter((name) => !ledger.has(name))
    if (missing.length > 0 || ledger.size !== expected.length) {
      throw new Error(
        `pre-migrated fixture: image does not match the migration manifest ` +
          `(ledger ${ledger.size}, manifest ${expected.length}` +
          `${missing.length > 0 ? `, missing ${missing.slice(0, 3).join(', ')}` : ''})`,
      )
    }
  } finally {
    db.close()
  }
}
