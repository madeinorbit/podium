/**
 * Installation-directory ownership, independent of the selected instance/state root.
 * A parent and its successor may both use the same payload. Startup fallback is the
 * lower-priority writer: it needs an exclusive lease while every runtime user holds
 * a shared one. SQLite's rollback-mode locks make acquisition atomic and disappear
 * on process death, without stale PID-file election or a second update journal.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fsyncPath } from './fsync'
import { openDatabase, type SqlDatabase } from './sqlite'

/**
 * Fence legacy native executables that predate the shared usage lease. Linux's
 * ETXTBSY check is atomic in both directions: a running executable refuses this
 * non-truncating writable open, and a new exec refuses while it remains open.
 * No bytes are written through these descriptors. Keep them through activation.
 */
export function acquireLegacyExecutableFence(installDir: string): () => void {
  if (process.platform !== 'linux')
    throw new Error('legacy execution fencing is not established on this platform')
  const handles: number[] = []
  try {
    for (const name of readdirSync(installDir)) {
      const path = join(installDir, name)
      const stat = lstatSync(path)
      if (!stat.isFile() || !(stat.mode & 0o111)) continue
      handles.push(openSync(path, 'r+'))
    }
  } catch (error) {
    for (const fd of handles) closeSync(fd)
    throw error
  }
  return () => {
    for (const fd of handles.splice(0)) closeSync(fd)
  }
}

/** Resolve aliases even when the final directory has not been seeded yet. */
export function canonicalInstallationPath(path: string): string {
  const absolute = resolve(path)
  // A dangling alias is uncertain ownership, not an absent installation/root.
  if (entryExists(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  if (parent === absolute) throw new Error('installation has no existing ancestor')
  return join(canonicalInstallationPath(parent), basename(absolute))
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export interface InstallationLease {
  installDir: string
  metadataDir: string
  exclusive: boolean
  release(): void
}

/** The native shell uses this same filename, table and rollback-journal protocol. */
export function acquireInstallationLease(
  path: string,
  exclusive: boolean,
  waitMs = 0,
): InstallationLease {
  const installDir = canonicalInstallationPath(path)
  const metadataDir = `${installDir}.lifecycle`
  mkdirSync(metadataDir, { recursive: true, mode: 0o700 })
  fsyncPath(dirname(metadataDir))
  const db: SqlDatabase = openDatabase(join(metadataDir, 'usage.sqlite'))
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`)
    // WAL deliberately permits readers during a writer; it cannot implement this lease.
    const modeQuery = db.prepare('PRAGMA journal_mode')
    const mode = modeQuery.get() as { journal_mode: string }
    modeQuery.finalize?.()
    if (mode.journal_mode !== 'delete')
      throw new Error('installation lease must use DELETE journal mode')
    db.exec('CREATE TABLE IF NOT EXISTS installation_lease (id INTEGER PRIMARY KEY)')
    db.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    // BEGIN alone is deferred. This read takes the actual SHARED filesystem lock.
    const read = db.prepare('SELECT id FROM installation_lease LIMIT 1')
    try {
      read.get()
    } finally {
      read.finalize?.()
    }
  } catch (error) {
    db.close()
    throw error
  }
  let released = false
  return {
    installDir,
    metadataDir,
    exclusive,
    release() {
      if (released) return
      released = true
      try {
        db.exec('ROLLBACK')
      } finally {
        db.close()
      }
    },
  }
}

/** Read-only image/system installs cannot be startup fallback destinations. */
export function acquireRuntimeInstallationLease(path: string): InstallationLease | undefined {
  try {
    return acquireInstallationLease(path, false, 30_000)
  } catch (error) {
    if (
      ['EACCES', 'EPERM', 'EROFS', 'SQLITE_READONLY', 'SQLITE_CANTOPEN'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined
    throw error
  }
}

/** Register under a held lease so an exclusive writer sees every previously used root. */
export function registerInstallationStateRoot(
  lease: Pick<InstallationLease, 'metadataDir'>,
  stateRoot: string,
): void {
  const stateDir = canonicalInstallationPath(stateRoot)
  const roots = join(lease.metadataDir, 'roots')
  mkdirSync(roots, { recursive: true, mode: 0o700 })
  fsyncPath(lease.metadataDir)
  const name = `${createHash('sha256').update(stateDir).digest('hex')}.json`
  const path = join(roots, name)
  const bytes = `${JSON.stringify({ format: 1, stateDir })}\n`
  if (entryExists(path)) {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record.format !== 1 || record.stateDir !== stateDir)
      throw new Error('installation state-root record is invalid')
    return
  }
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, bytes, { mode: 0o600 })
  fsyncPath(temporary)
  renameSync(temporary, path)
  fsyncPath(roots)
}

export function installationStateRoots(lease: Pick<InstallationLease, 'metadataDir'>): string[] {
  const roots = join(lease.metadataDir, 'roots')
  if (!entryExists(roots)) return []
  return readdirSync(roots)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const record = JSON.parse(readFileSync(join(roots, name), 'utf8'))
      if (
        record.format !== 1 ||
        typeof record.stateDir !== 'string' ||
        !isAbsolute(record.stateDir)
      )
        throw new Error('installation state-root record is unreadable')
      return canonicalInstallationPath(record.stateDir)
    })
}
