/**
 * Durable database snapshots shared by boot migrations and update operations.
 *
 * A snapshot is copied to a temporary sibling, fsynced, and renamed only when
 * complete. Retention considers only SQLite files that pass quick_check, so a
 * crash residue or corrupt file is preserved for inspection and can never evict
 * a usable restore point.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'

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

function usableBackup(path: string): boolean {
  let db: SqlDatabase | undefined
  try {
    if (statSync(path).size === 0) return false
    db = openDatabase(path, { readOnly: true })
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    return row !== undefined && Object.values(row)[0] === 'ok'
  } catch {
    return false
  } finally {
    db?.close()
  }
}

type LatestBackupCacheEntry = {
  signature: string
  path: string | undefined
}

/**
 * `usableBackup` runs SQLite `quick_check`, which reads the snapshot rather than
 * merely inspecting its directory entry. Update's idle read model asks for the
 * latest recovery point every 30 seconds, so repeating that proof turned a
 * harmless status poll into a synchronous full-database scan. Cache only the
 * verified answer, keyed by every candidate snapshot set's main, WAL, and SHM
 * metadata; a published, removed, or replaced member changes the signature and
 * is verified before it can become the answer.
 */
const latestBackupCache = new Map<string, LatestBackupCacheEntry>()

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
 * timestamped sibling, then prunes old usable snapshots.
 *
 * Safety: called while this process owns the live connection, after
 * `PRAGMA wal_checkpoint(TRUNCATE)` folded the WAL into the main file. The main
 * backup filename is published last, after every temporary copy has been
 * fsynced, so a mid-copy ENOSPC can never leave a truncated restorable file.
 *
 * `freeBytes` and `prune` are injectable for focused failure tests.
 */
export function backupDatabase(
  db: SqlDatabase,
  dbPath: string,
  label: string,
  freeBytes: (dir: string) => number = freeDiskBytes,
  prune: (dbPath: string) => void = pruneBackups,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

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
        'The server refuses to start the migration until disk space is freed.',
    )
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.backup-v${label}-${stamp}`
  const partialPath = `${backupPath}.partial-${randomUUID()}`
  const suffixes = ['', '-wal', '-shm'].filter(
    (suffix) => suffix === '' || existsSync(`${dbPath}${suffix}`),
  )
  try {
    for (const suffix of suffixes) {
      const temp = `${partialPath}${suffix}`
      copyFileSync(`${dbPath}${suffix}`, temp)
      const fd = openSync(temp, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }

    // Sidecars become visible first; the main filename is the trust marker and
    // is published last, only after every byte of the snapshot set is durable.
    for (const suffix of suffixes.filter(Boolean)) {
      renameSync(`${partialPath}${suffix}`, `${backupPath}${suffix}`)
    }
    renameSync(partialPath, backupPath)

    // Persist the directory entry before the update operation records this path
    // and asks the coordinator to restart onto code that may run migrations.
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch (err) {
    log.warn('database snapshot did not complete; removing its unpublished files', {
      path: partialPath,
      err,
    })
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${partialPath}${suffix}`, { force: true })
      rmSync(`${backupPath}${suffix}`, { force: true })
    }
    throw err
  }

  try {
    // Normal-operation cleanup: every successful snapshot, including the
    // update server step, reaches retention immediately.
    prune(dbPath)
  } catch (err) {
    // Cleanup must not turn an already durable recovery point into an update
    // failure. The next successful snapshot retries retention.
    log.warn('database snapshot retention could not be applied', { path: dbPath, err })
  }
  return backupPath
}

/** Keeps the newest valid backup sets; suspicious files are preserved for inspection. */
export function pruneBackups(dbPath: string): void {
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
      if (!usableBackup(path)) {
        log.warn('leaving an unreadable database snapshot untouched', { path })
        return []
      }
      return [{ name, mtimeMs: statSync(path).mtimeMs }]
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))

  for (const stale of mains.slice(MIGRATION_BACKUPS_TO_KEEP)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(dir, `${stale.name}${suffix}`), { force: true })
    }
  }
}

/** Newest valid snapshot available for an operation's restore guidance. */
export function latestDatabaseBackup(dbPath: string): string | undefined {
  try {
    const dir = dirname(dbPath)
    const dbFile = basename(dbPath)
    const candidates = readdirSync(dir)
      .filter((name) => isBackupMain(name, dbFile))
      .map((name) => {
        const path = join(dir, name)
        const stats = statSync(path)
        const sidecars = ['-wal', '-shm'].map((suffix) => {
          const sidecarPath = `${path}${suffix}`
          if (!existsSync(sidecarPath)) return `${suffix}\0missing`
          const sidecarStats = statSync(sidecarPath)
          return `${suffix}\0${sidecarStats.size}\0${sidecarStats.mtimeMs}\0${sidecarStats.ctimeMs}`
        })
        return {
          name,
          path,
          mtimeMs: stats.mtimeMs,
          signature: `${name}\0${stats.size}\0${stats.mtimeMs}\0${stats.ctimeMs}\0${sidecars.join('\0')}`,
        }
      })
    const signature = candidates.map(({ signature }) => signature).sort().join('\n')
    const cached = latestBackupCache.get(dbPath)
    if (cached?.signature === signature) return cached.path

    const latest = candidates
      .filter(({ path }) => usableBackup(path))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))[0]?.path
    latestBackupCache.set(dbPath, { signature, path: latest })
    return latest
  } catch (err) {
    log.warn('database snapshot history could not be read', { path: dbPath, err })
    return undefined
  }
}

/**
 * Process-lifetime view of the newest verified snapshot.
 *
 * `latestDatabaseBackup` opens and quick-checks every retained snapshot. On a
 * production database those files are hundreds of megabytes, so that is a
 * recovery-boundary operation, not something a polled read model may repeat.
 * A snapshot created by this process replaces the cached answer immediately;
 * otherwise the on-disk catalogue is inspected once after boot.
 */
export function createLatestDatabaseBackupCache(
  dbPath: string,
  inspect: (path: string) => string | undefined = latestDatabaseBackup,
): {
  latest(): string | undefined
  record(path: string | undefined): void
} {
  let inspected = false
  let latest: string | undefined
  return {
    latest: () => {
      if (!inspected) {
        latest = inspect(dbPath)
        inspected = true
      }
      return latest
    },
    record: (path) => {
      latest = path
      inspected = true
    },
  }
}
