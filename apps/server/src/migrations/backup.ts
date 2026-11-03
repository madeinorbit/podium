/**
 * Durable database snapshots shared by boot migrations and update operations.
 *
 * A snapshot is written by SQLite (`VACUUM INTO`) to a temporary sibling,
 * fsynced, and renamed only when complete.
 *
 * NOTHING HERE OPENS THE LIVE DATABASE FILES OUTSIDE SQLITE (POD-6263). POSIX
 * advisory locks belong to the process, and closing ANY descriptor on a file
 * releases every lock the process holds on it. The boot backup used to
 * `copyFileSync` podium.db, -wal and -shm from inside the server while its
 * connection was open, which silently dropped the database SHARED lock and the
 * wal-index deadman-switch lock for the rest of the server's life. The next
 * process to open the database then believed it was alone, truncated and
 * rebuilt the -shm under the server's mapping, and the server died of SIGBUS in
 * `walFindFrame` (four crashes on ludovico, October to November 2026);
 * https://sqlite.org/howtocorrupt.html §2.2 is the corruption form of the same
 * hazard. `VACUUM INTO` reads through SQLite, which keeps its descriptors and
 * locks, and writes a different file.
 *
 * NOTHING HERE OPENS A RETAINED SNAPSHOT (POD-3068). Retention used to decide
 * what to evict by running `PRAGMA quick_check` over every retained file, and
 * the read path used to do the same before answering "what can I restore to?" —
 * ~80 seconds of blocked event loop on three ~747 MiB files. Proving a snapshot
 * is now the child process's job (`snapshot-verifier.ts`) and its answer is read
 * from the published catalogue; this module stats, snapshots through SQLite,
 * renames and unlinks.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { fsyncPath } from '@podium/runtime/fsync'
import type { SqlDatabase } from '@podium/runtime/sqlite'

const log = createLogger('server:migrations')

/**
 * Keep the upgrade under rehearsal plus two predecessors. Three bounds disk use
 * while leaving two known-good restore points if the newest candidate is bad.
 */
export const MIGRATION_BACKUPS_TO_KEEP = 3

/** Safety margin applied to the measured backup size before the free-space check. */
const PREFLIGHT_MARGIN = 1.1

/** True when the backup file name (not a -wal/-shm sidecar) belongs to `dbFile`. */
function isBackupMain(name: string, dbFile: string): boolean {
  return (
    name.startsWith(`${dbFile}.backup-v`) &&
    !name.includes('.partial-') &&
    !name.endsWith('-wal') &&
    !name.endsWith('-shm')
  )
}

function isPartialBackup(name: string, dbFile: string): boolean {
  return name.startsWith(`${dbFile}.backup-v`) && name.includes('.partial-')
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

/** What a pre-migration backup of a database needs on disk, and what is free. */
export interface BackupSpace {
  dir: string
  /** Database plus -wal/-shm sidecars, as they are on disk now. */
  needed: number
  /** `needed` with the safety margin applied. */
  required: number
  available: number
}

/**
 * Measure the pre-migration backup's disk need against the free space.
 *
 * ONE FORMULA FOR BOTH HALVES OF THE UPDATE (POD-6255). The new server takes
 * the backup at boot ({@link backupDatabase}); the old server asks this same
 * question before it restarts, so a disk that cannot hold the copy refuses the
 * update while the old server is still serving instead of after it has stopped.
 * Counting the sidecars at their current size can only overstate what the
 * backup needs: `VACUUM INTO` writes at most every live page, the main file
 * plus what the WAL adds, and never the -shm.
 */
export function measureBackupSpace(
  dbPath: string,
  freeBytes: (dir: string) => number = freeDiskBytes,
): BackupSpace {
  const dir = dirname(dbPath)
  let needed = statSync(dbPath).size
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) needed += statSync(`${dbPath}${suffix}`).size
  }
  return { dir, needed, required: Math.ceil(needed * PREFLIGHT_MARGIN), available: freeBytes(dir) }
}

/** The old server's answer before a restart: room for the boot backup, or why not. */
export type BackupPreflight = { ok: true } | { ok: false; detail: string }

/** The refusal sentence when `space` cannot hold the backup, otherwise undefined. */
export function backupSpaceShortfall(space: BackupSpace): string | undefined {
  if (space.available >= space.required) return undefined
  return (
    `Not enough disk space for the pre-migration backup in ${space.dir}: ` +
    `need ~${space.required} bytes (database + sidecars + 10% margin), only ${space.available} bytes free. ` +
    'The server refuses to start the migration until disk space is freed.'
  )
}

/**
 * Write a consistent snapshot of `db`'s database to `path` through SQLite, and
 * publish it atomically.
 *
 * `VACUUM INTO` runs inside one read transaction, so the snapshot holds every
 * committed row, including rows still in the WAL, with no checkpoint first and
 * no -wal/-shm sidecars after: the result is one self-contained, compacted
 * file. SQLite does not fsync what it writes there, so this does, then renames
 * the partial file to `path` (the trust marker) and fsyncs the directory. A
 * failure removes whatever this call created and rethrows.
 *
 * `db` may be the live connection itself or another connection to the same
 * file: either way every access to the live files goes through SQLite.
 */
export function vacuumIntoPublished(db: SqlDatabase, path: string): void {
  const dir = dirname(path)
  const partial = `${path}.partial-${randomUUID()}`
  let published = false
  try {
    db.prepare('VACUUM INTO ?').run(partial)
    fsyncPath(partial)
    renameSync(partial, path)
    published = true
    // Persist the directory entry before a caller records this path or
    // migrates the database it protects.
    fsyncPath(dir)
  } catch (err) {
    log.warn('database snapshot did not complete; removing its unpublished files', {
      path: partial,
      err,
    })
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(`${partial}${suffix}`, { force: true })
    }
    if (published) rmSync(path, { force: true })
    throw err
  }
}

/**
 * Snapshots the database to a timestamped sibling, then prunes old usable
 * snapshots.
 *
 * Called by the boot migration through the store's own connection, before any
 * migration runs; since POD-6255 this is the one recovery point an update
 * leaves. The snapshot goes through SQLite ({@link vacuumIntoPublished}), never
 * through a file copy: this process has the database open, and closing a copy's
 * descriptor would drop its SQLite locks (see the module header).
 *
 * `freeBytes` and `prune` are injectable for focused failure tests.
 */
export function backupDatabase(
  db: SqlDatabase,
  dbPath: string,
  label: string,
  freeBytes: (dir: string) => number = freeDiskBytes,
  prune: (dbPath: string, activeFallback?: string) => void = pruneBackups,
  activeFallback: () => string | undefined = () => undefined,
): string | undefined {
  if (!existsSync(dbPath)) return undefined

  const space = measureBackupSpace(dbPath, freeBytes)
  const shortfall = backupSpaceShortfall(space)
  if (shortfall !== undefined) {
    // LOGGED WHERE THE NUMBERS ARE KNOWN (POD-5289). The update operation
    // reports this reason as its step error, but only this line ties the
    // refusal to the measured database size and the free bytes on this
    // filesystem at the moment it was refused.
    log.warn('refusing the pre-migration backup: not enough free disk space', {
      dbPath,
      ...space,
    })
    throw new Error(shortfall)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${label}-${stamp}`
  vacuumIntoPublished(db, backupPath)

  try {
    // Normal-operation cleanup: every successful snapshot reaches retention
    // immediately.
    prune(dbPath, activeFallback())
  } catch (err) {
    // Cleanup must not turn an already durable recovery point into an update
    // failure. The next successful snapshot retries retention.
    log.warn('database snapshot retention could not be applied', { path: dbPath, err })
  }
  return backupPath
}

/**
 * Every published snapshot main file for `dbPath`, newest first. Stat-only.
 *
 * This is the naming convention's one reader outside retention, and the reason
 * it exists is 0.1.0 compatibility: an installation that upgrades into the
 * verifier has `<db>.backup-v*` files and no catalogue, and the migration path
 * (`migrations/index.ts`) still stages snapshots without publishing a record.
 * Discovery has to start from the DIRECTORY, not from the catalogue, or those
 * files stay invisible forever.
 */
export function retainedSnapshotPaths(dbPath: string): string[] {
  const dir = dirname(dbPath)
  const dbFile = basename(dbPath)
  try {
    return readdirSync(dir)
      .filter((name) => isBackupMain(name, dbFile))
      .flatMap((name) => {
        const path = join(dir, name)
        try {
          return [{ path, mtimeMs: statSync(path).mtimeMs }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
      .map(({ path }) => path)
  } catch (err) {
    log.warn('database snapshot history could not be listed', { path: dbPath, err })
    return []
  }
}

/**
 * Keeps the newest snapshot sets by mtime, stat-only.
 *
 * `activeFallback` is the path the verifier currently advertises as the usable
 * restore point. It is never evicted merely because newer targets were prepared:
 * a newer file is only a CANDIDATE until a verifier proves it, and dropping the
 * proven one in the meantime would leave the instance with no restore point at
 * the exact moment an update is being planned.
 *
 * Incomplete `.partial-` residue is left alone for forensics and never advertised.
 */
export function pruneBackups(dbPath: string, activeFallback?: string): void {
  const dir = dirname(dbPath)
  const dbFile = basename(dbPath)
  const names = readdirSync(dir)
  for (const name of names.filter((entry) => isPartialBackup(entry, dbFile))) {
    log.warn('leaving an incomplete database snapshot untouched', { path: join(dir, name) })
  }

  const mains = names
    .filter((name) => isBackupMain(name, dbFile))
    .flatMap((name) => {
      const path = join(dir, name)
      try {
        return [{ name, path, mtimeMs: statSync(path).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))

  for (const stale of mains.slice(MIGRATION_BACKUPS_TO_KEEP)) {
    if (activeFallback && stale.path === activeFallback) {
      log.info('keeping the verified recovery point beyond ordinary retention', {
        path: stale.path,
      })
      continue
    }
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(dir, `${stale.name}${suffix}`), { force: true })
    }
  }
}
