/**
 * Durable database snapshots shared by boot migrations and update operations.
 *
 * A snapshot is copied to a temporary sibling, fsynced, and renamed only when
 * complete.
 *
 * NOTHING HERE OPENS A RETAINED SNAPSHOT (POD-3068). Retention used to decide
 * what to evict by running `PRAGMA quick_check` over every retained file, and
 * the read path used to do the same before answering "what can I restore to?" —
 * ~80 seconds of blocked event loop on three ~747 MiB files. Proving a snapshot
 * is now the child process's job (`snapshot-verifier.ts`) and its answer is read
 * from the published catalogue; this module stats, copies, renames and unlinks.
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
  prune: (dbPath: string, activeFallback?: string) => void = pruneBackups,
  activeFallback: () => string | undefined = () => undefined,
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
