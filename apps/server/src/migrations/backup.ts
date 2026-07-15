/**
 * Pre-migration database backup (#43): before a boot advances the schema of a
 * database that already holds real tables, the file (+ -wal/-shm sidecars) is
 * copied to a timestamped sibling, keeping the last MIGRATION_BACKUPS_TO_KEEP.
 * The drizzle applier calls this before letting the migrator run.
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** How many pre-migration backups to retain per database file. */
export const MIGRATION_BACKUPS_TO_KEEP = 3

/** True when the backup file name (not a -wal/-shm sidecar) belongs to `dbFile`. */
function isBackupMain(name: string, dbFile: string): boolean {
  return name.startsWith(`${dbFile}.backup-v`) && !name.endsWith('-wal') && !name.endsWith('-shm')
}

/**
 * Copies the on-disk database (plus -wal/-shm sidecars when present) to a
 * timestamped sibling before a schema-advancing run, then prunes to the last
 * MIGRATION_BACKUPS_TO_KEEP backups.
 *
 * Safety: called at startup while this process holds the ONLY connection
 * (Podium's server is the single writer), after `PRAGMA wal_checkpoint(TRUNCATE)`
 * folded the WAL into the main file — so a plain file copy is a consistent
 * snapshot. Returns the backup path, or undefined when nothing was copied.
 * `label` becomes the filename's `.backup-v<label>-<stamp>` segment; keep the
 * `v` prefix so `pruneBackups` reclaims every backup.
 */
export function backupDatabase(
  db: SqlDatabase,
  dbPath: string,
  label: string,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  // Fold WAL content into the main DB file so the copy is self-consistent.
  // Harmless no-op under non-WAL journal modes. Must run outside a transaction.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${label}-${stamp}`
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
