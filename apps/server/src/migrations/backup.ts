/**
 * Pre-migration database backup (#43): before a boot advances the schema of a
 * database that already holds real tables, the file (+ -wal/-shm sidecars) is
 * copied to a timestamped sibling, keeping the last MIGRATION_BACKUPS_TO_KEEP.
 * The drizzle applier calls this before letting the migrator run.
 *
 * POD-615: a full disk once let copyFileSync die on ENOSPC mid-copy, crash-loop
 * the server, and leave a truncated backup behind. The copy is now preceded by
 * a free-space preflight (fail loudly, with numbers) and followed — on any
 * failure — by removal of whatever partial backup files were written.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** How many pre-migration backups to retain per database file. */
export const MIGRATION_BACKUPS_TO_KEEP = 2

/** Safety margin applied to the measured backup size before the free-space check. */
const PREFLIGHT_MARGIN = 1.1

/** True when the backup file name (not a -wal/-shm sidecar) belongs to `dbFile`. */
function isBackupMain(name: string, dbFile: string): boolean {
  return name.startsWith(`${dbFile}.backup-v`) && !name.endsWith('-wal') && !name.endsWith('-shm')
}

/**
 * Free bytes available to this process on the filesystem holding `dir`.
 * Uses `fs.statfsSync` (works under Bun), falling back to `df -Pk` parsing.
 */
export function freeDiskBytes(dir: string): number {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    const df = spawnSync('df', ['-Pk', dir], { encoding: 'utf8' })
    const lines = (df.stdout ?? '').trim().split('\n')
    const availKb = Number(lines[lines.length - 1]?.trim().split(/\s+/)[3])
    if (df.status !== 0 || !Number.isFinite(availKb)) {
      throw new Error(`Cannot determine free disk space for ${dir} (statfs and df both failed)`)
    }
    return availKb * 1024
  }
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
 *
 * `freeBytes` is injectable for tests; production uses `freeDiskBytes`.
 */
export function backupDatabase(
  db: SqlDatabase,
  dbPath: string,
  label: string,
  freeBytes: (dir: string) => number = freeDiskBytes,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  // Fold WAL content into the main DB file so the copy is self-consistent.
  // Harmless no-op under non-WAL journal modes. Must run outside a transaction.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

  // Free-space preflight (POD-615): refuse to start a copy the disk cannot
  // hold — a mid-copy ENOSPC would crash-loop the boot and leave a truncated
  // backup file behind.
  const dir = dirname(dbPath)
  let needed = statSync(dbPath).size
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) needed += statSync(`${dbPath}${suffix}`).size
  }
  const required = Math.ceil(needed * PREFLIGHT_MARGIN)
  const available = freeBytes(dir)
  if (available < required) {
    throw new Error(
      `Not enough disk space for the pre-migration backup in ${dir}: ` +
        `need ~${required} bytes (database + sidecars + 10% margin), only ${available} bytes free. ` +
        `The server refuses to start the migration until disk space is freed.`,
    )
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${label}-${stamp}`
  try {
    copyFileSync(dbPath, backupPath)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`))
        copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`)
    }
  } catch (err) {
    // Never leave a truncated backup behind — remove whatever was written.
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${backupPath}${suffix}`, { force: true })
    }
    throw err
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
