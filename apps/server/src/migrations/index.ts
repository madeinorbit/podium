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
 * Rules (POLICY — read before adding a migration):
 *  - Migrations are numbered, forward-only, and ADDITIVE-ONLY: no destructive
 *    column drops or renames within a single release. When a column/table must
 *    go away, do it two-phase: release N stops reading/writing it, release N+1
 *    drops it — so a rollback of one release never faces a schema it cannot read.
 *  - Each migration runs in its OWN top-level transaction, its schema_version
 *    stamp committing atomically alongside the schema change [spec:SP-3fe2].
 *  - A database whose version is NEWER than the code refuses to open with a
 *    clear error (downgrade protection) — the stored version is authoritative.
 *  - Before a run that advances the version of a database that already holds
 *    real tables, the DB file (+ -wal/-shm sidecars) is copied to a timestamped
 *    backup next to it; the last 3 backups are kept (#43).
 *  - Re-running is idempotent: already-applied versions are skipped.
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { up as coreSchema } from './002-core-schema'
import { up as hardeningIndexes } from './003-hardening-indexes'
import { up as issuesUniqueRepoSeq } from './004-issues-unique-repo-seq'
import { up as issuesRepoIdIdentity } from './005-issues-repo-id-identity'
import { up as issuesFksChecks } from './006-issues-fks-checks'
import { up as issueDepsSingleParent } from './007-issue-deps-single-parent'
import { up as issuesRepoIdIndex } from './008-issues-repo-id-index'
import { up as issuesAudience } from './009-issues-audience'
import { up as issuesDropVerifyingStage } from './010-issues-drop-verifying-stage'
import { up as issueSessionSoftDelete } from './011-issues-soft-delete'
import { up as approvalRequests } from './012-approval-requests'
import { up as locks } from './013-locks'
import { up as machinesInventory } from './014-machines-inventory'
import { up as superagentPendingTurns } from './015-superagent-pending-turns'
import { up as issuesColor } from './016-issues-color'
import { up as sessionWorkingMsTotal } from './017-session-working-ms-total'

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
  { version: 5, name: 'issues-repo-id-identity', up: issuesRepoIdIdentity },
  { version: 6, name: 'issues-fks-checks', up: issuesFksChecks },
  { version: 7, name: 'issue-deps-single-parent', up: issueDepsSingleParent },
  { version: 8, name: 'issues-repo-id-index', up: issuesRepoIdIndex },
  { version: 9, name: 'issues-audience', up: issuesAudience },
  { version: 10, name: 'issues-drop-verifying-stage', up: issuesDropVerifyingStage },
  { version: 11, name: 'issue-session-soft-delete', up: issueSessionSoftDelete },
  { version: 12, name: 'approval-requests', up: approvalRequests },
  // Advisory named lease locks [spec:SP-85d1] — podium lock / merge-lock.
  { version: 13, name: 'locks', up: locks },
  { version: 14, name: 'machines-inventory', up: machinesInventory },
  { version: 15, name: 'superagent-pending-turns', up: superagentPendingTurns },
  // Issue colour slot [spec:SP-b4d1] — NULL = no colour (neutral slate flow).
  { version: 16, name: 'issues-color', up: issuesColor },
  { version: 17, name: 'session-working-ms-total', up: sessionWorkingMsTotal },
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

/** How many pre-migration backups to retain per database file. */
export const MIGRATION_BACKUPS_TO_KEEP = 3

/** True when the backup file name (not a -wal/-shm sidecar) belongs to `dbFile`. */
function isBackupMain(name: string, dbFile: string): boolean {
  return name.startsWith(`${dbFile}.backup-v`) && !name.endsWith('-wal') && !name.endsWith('-shm')
}

/**
 * Copies the on-disk database (plus -wal/-shm sidecars when present) to a
 * timestamped sibling before a version-advancing run, then prunes to the last
 * MIGRATION_BACKUPS_TO_KEEP backups.
 *
 * Safety: called at startup while this process holds the ONLY connection
 * (Podium's server is the single writer), after `PRAGMA wal_checkpoint(TRUNCATE)`
 * folded the WAL into the main file — so a plain file copy is a consistent
 * snapshot. Returns the backup path, or undefined when nothing was copied.
 */
export function backupBeforeMigration(
  db: SqlDatabase,
  dbPath: string,
  fromVersion: number,
  toVersion: number,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  // Fold WAL content into the main DB file so the copy is self-consistent.
  // Harmless no-op under non-WAL journal modes. Must run outside a transaction.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${fromVersion}-${toVersion}-${stamp}`
  copyFileSync(dbPath, backupPath)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`))
      copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`)
  }
  pruneBackups(dbPath)
  return backupPath
}

/** Keeps the newest MIGRATION_BACKUPS_TO_KEEP backup sets; deletes the rest. */
function pruneBackups(dbPath: string): void {
  const dir = dirname(dbPath)
  const dbFile = basename(dbPath)
  const mains = readdirSync(dir)
    .filter((name) => isBackupMain(name, dbFile))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  for (const stale of mains.slice(MIGRATION_BACKUPS_TO_KEEP)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(dir, `${stale.name}${suffix}`), { force: true })
    }
  }
}

/**
 * Applies all pending migrations. Returns the versions applied in this run.
 * Throws (without touching the schema) when the DB is newer than the code.
 */
export function runMigrations(
  db: SqlDatabase,
  migrations: Migration[] = MIGRATIONS,
  opts: { dbPath?: string } = {},
): number[] {
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
  // #43: snapshot the database before a version-advancing run — but only when
  // it already holds real tables (schema_version alone is a brand-new file).
  const hasPending = migrations.some((m) => m.version > current)
  if (hasPending && opts.dbPath !== undefined && opts.dbPath !== ':memory:') {
    const hasObjects = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_version' LIMIT 1`,
      )
      .get()
    if (hasObjects !== undefined) backupBeforeMigration(db, opts.dbPath, current, target)
  }

  const applied: number[] = []
  const insert = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const m of migrations) {
    if (m.version <= current) continue
    // Deliberately hand-rolled, NOT @podium/runtime/sqlite `transaction()`
    // [spec:SP-3fe2]: each migration must be its own top-level BEGIN IMMEDIATE
    // with the version stamp committing atomically alongside the schema change.
    // The nesting-safe helper would degrade this to a SAVEPOINT if a caller ever
    // wrapped runMigrations in a transaction — then a later migration's failure
    // could roll back earlier already-stamped migrations, breaking the
    // one-transaction-per-migration ordering guarantee.
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
