/**
 * Forward-only schema migration runner.
 *
 * The migration chain OWNS the schema (Phase 1): a fresh database is built
 * entirely by the numbered migrations below, and an existing database (legacy
 * DDL path, stamped baseline 1) converges onto the identical schema through
 * migration 002's defensive guards. convergence.test.ts pins that both paths
 * produce byte-identical sqlite_master output. The only schema objects NOT
 * versioned here are the environment-conditional FTS5 tables/triggers — the
 * conversations repository (re)ensures those per boot, because their existence
 * depends on the runtime SQLite build.
 *
 * Rules:
 *  - Migrations are numbered, forward-only, and each runs in its own
 *    transaction (DDL is transactional in SQLite).
 *  - A database whose version is NEWER than the code refuses to open with a
 *    clear error (downgrade protection).
 *  - Re-running is idempotent: already-applied versions are skipped.
 */

import type { SqlDatabase } from '@podium/core/sqlite'
import { up as coreSchema } from './002-core-schema'
import { up as hardeningIndexes } from './003-hardening-indexes'
import { up as issuesUniqueRepoSeq } from './004-issues-unique-repo-seq'

export interface Migration {
  /** Positive, unique, strictly increasing across the list. */
  version: number
  /** Short human-readable label recorded in schema_version. */
  name: string
  /** Applies the schema change. Runs inside a transaction — do not BEGIN/COMMIT. */
  up: (db: SqlDatabase) => void
}

/** The server's migration list. Append only — never renumber or edit applied entries. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    // No-op marker: databases built by the legacy SessionStore.migrate() DDL
    // stamped version 1 with no structural change; 002 owns the real DDL.
    up: () => {},
  },
  { version: 2, name: 'core-schema', up: coreSchema },
  { version: 3, name: 'hardening-indexes', up: hardeningIndexes },
  { version: 4, name: 'issues-unique-repo-seq', up: issuesUniqueRepoSeq },
]

/** Highest schema version the running code knows about. */
export function codeSchemaVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations[migrations.length - 1]?.version ?? 0
}

/** Current version recorded in the database (0 when never migrated). */
export function dbSchemaVersion(db: SqlDatabase): number {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
    .get()
  if (table === undefined) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

function validate(migrations: Migration[]): void {
  let prev = 0
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new Error(
        `migrations must have positive, strictly increasing integer versions (got ${m.version} after ${prev})`,
      )
    }
    prev = m.version
  }
}

/**
 * Applies all pending migrations. Returns the versions applied in this run.
 * Throws (without touching the schema) when the DB is newer than the code.
 */
export function runMigrations(db: SqlDatabase, migrations: Migration[] = MIGRATIONS): number[] {
  validate(migrations)
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  )
  const current = dbSchemaVersion(db)
  const target = codeSchemaVersion(migrations)
  if (current > target) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${target}). ` +
        `Upgrade the Podium server (or restore the matching database) — downgrades are not supported.`,
    )
  }
  const applied: number[] = []
  const insert = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const m of migrations) {
    if (m.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db)
      insert.run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(
        `migration ${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    applied.push(m.version)
  }
  return applied
}
