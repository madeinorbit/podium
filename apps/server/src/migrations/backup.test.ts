/**
 * Durable snapshot tests: free-space refusal, atomic publication through SQLite,
 * partial-file cleanup, the live connection's locks (POD-6263), bounded
 * retention, suspicious-file preservation, and non-fatal pruning. Every
 * filesystem fixture is removed after its test.
 */

import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exclusiveLockFromAnotherProcess,
  openFromAnotherProcess,
  posixLocksOn,
  readLockCovers,
  SHM_DEADMAN_SWITCH_BYTE,
} from '../test-support/sqlite-locks'
import {
  backupDatabase,
  backupSpaceShortfall,
  freeDiskBytes,
  MIGRATION_BACKUPS_TO_KEEP,
  measureBackupSpace,
} from './backup'
import { configureStoreConnection } from './store-lifecycle'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  }
})

vi.mock('@podium/runtime/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/runtime/sqlite')>()
  return {
    ...actual,
    openDatabase: vi.fn(actual.openDatabase),
  }
})

const PLENTY = () => Number.MAX_SAFE_INTEGER
const tempDirs: string[] = []

function tmpDb(name = 'test.sqlite'): { db: SqlDatabase; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'podium-backup-'))
  tempDirs.push(dir)
  const dbPath = join(dir, name)
  const db = openDatabase(dbPath)
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('x');`)
  return { db, dbPath, dir }
}

function backupMains(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (name) => name.includes('.backup-v') && !name.endsWith('-wal') && !name.endsWith('-shm'),
    )
    .sort()
}

beforeEach(() => {
  vi.mocked(copyFileSync).mockClear()
  vi.mocked(fsyncSync).mockClear()
  vi.mocked(renameSync).mockClear()
  vi.mocked(openDatabase).mockClear()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('backupDatabase preflight', () => {
  it('throws an actionable error and writes nothing when free space is insufficient', () => {
    const { db, dbPath, dir } = tmpDb()
    const dbSize = statSync(dbPath).size

    expect(() => backupDatabase(db, dbPath, 'preflight', () => 10)).toThrow(
      /refuses to start the migration until disk space is freed/,
    )
    try {
      backupDatabase(db, dbPath, 'preflight', () => 10)
      expect.unreachable('preflight should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain(dir)
      expect(msg).toContain(`need ~${Math.ceil(dbSize * 1.1)} bytes`)
      expect(msg).toContain('only 10 bytes free')
    }
    expect(backupMains(dir)).toEqual([])
    db.close()
  })

  /**
   * POD-6255. The old server asks this question before it restarts; the new
   * server's boot backup asks it again before it copies. The old server's
   * answer must never be more permissive than the boot backup's, or a full disk
   * would pass the early check and stop the update after the old server is gone.
   */
  it('the pre-restart preflight is never more permissive than the boot backup', () => {
    const { db, dbPath } = tmpDb()
    // Rows past the last checkpoint: both halves measure the files as they are.
    db.exec(`PRAGMA wal_autocheckpoint=0;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200)
      INSERT INTO t SELECT 'row-' || i FROM n;`)
    const preflight = measureBackupSpace(dbPath, PLENTY)
    expect(preflight.needed).toBeGreaterThanOrEqual(statSync(dbPath).size)

    const refused = { ...preflight, available: preflight.required - 1 }
    expect(backupSpaceShortfall(refused)).toContain(
      'Not enough disk space for the pre-migration backup',
    )
    expect(backupSpaceShortfall({ ...preflight, available: preflight.required })).toBeUndefined()

    // Whatever free space passes the preflight also passes the boot backup.
    expect(backupDatabase(db, dbPath, 'after-preflight', () => preflight.required)).toBeDefined()
    db.close()
  })

  it('publishes a SQLite snapshot only after the partial file is fsynced and renamed', () => {
    const { db, dbPath, dir } = tmpDb()

    const backupPath = backupDatabase(db, dbPath, 'ok', PLENTY)

    expect(backupPath).toBeDefined()
    expect(dirname(backupPath as string)).toBe(dir)
    expect(backupMains(dir)).toEqual([basename(backupPath as string)])
    // One self-contained file, written by SQLite: no sidecars, and no plain
    // copy of the live database's files.
    expect(existsSync(`${backupPath}-wal`)).toBe(false)
    expect(existsSync(`${backupPath}-shm`)).toBe(false)
    expect(vi.mocked(copyFileSync)).not.toHaveBeenCalled()
    const copy = openDatabase(backupPath as string, { readOnly: true })
    expect(copy.prepare('SELECT id FROM t').all()).toEqual([{ id: 'x' }])
    copy.close()

    const publish = vi.mocked(renameSync).mock.calls.at(-1)
    expect(String(publish?.[0])).toContain('.partial-')
    expect(publish?.[1]).toBe(backupPath)
    const fileFsyncOrder = vi.mocked(fsyncSync).mock.invocationCallOrder[0]
    const publishOrder = vi.mocked(renameSync).mock.invocationCallOrder.at(-1)
    if (fileFsyncOrder === undefined || publishOrder === undefined) {
      throw new Error('snapshot did not reach fsync and rename')
    }
    expect(fileFsyncOrder).toBeLessThan(publishOrder)
    db.close()
  })

  it('holds rows still in the WAL without checkpointing the live database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-backup-wal-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    configureStoreConnection(db)
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec(
      `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('in the WAL')`,
    )
    const walBytes = statSync(`${dbPath}-wal`).size
    expect(walBytes).toBeGreaterThan(0)

    const backupPath = backupDatabase(db, dbPath, 'wal', PLENTY) as string

    const copy = openDatabase(backupPath, { readOnly: true })
    expect(copy.prepare('SELECT v FROM t').all()).toEqual([{ v: 'in the WAL' }])
    copy.close()
    expect(statSync(`${dbPath}-wal`).size).toBe(walBytes)
    db.close()
  })

  it('returns undefined when the database file does not exist', () => {
    const { db, dir } = tmpDb()
    expect(backupDatabase(db, join(dir, 'missing.sqlite'), 'x', PLENTY)).toBeUndefined()
    db.close()
  })
})

describe('backupDatabase partial-file cleanup', () => {
  it('never publishes a snapshot whose bytes did not reach the disk', () => {
    const { db, dbPath, dir } = tmpDb()
    // The first fsync is the partial file's: the bytes are written but cannot
    // be made durable, so nothing may be published.
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })

    expect(() => backupDatabase(db, dbPath, 'boom', PLENTY)).toThrow(/ENOSPC/)

    expect(backupMains(dir)).toEqual([])
    expect(readdirSync(dir).filter((name) => name.includes('.backup-v'))).toEqual([])
    db.close()
  })
})

describe('backupDatabase retention', () => {
  it('runs on successful snapshots and keeps only the newest three of four', () => {
    expect(MIGRATION_BACKUPS_TO_KEEP).toBe(3)
    const { db, dbPath, dir } = tmpDb()

    for (const label of ['a', 'b', 'c', 'd']) backupDatabase(db, dbPath, label, PLENTY)

    const kept = backupMains(dir)
    expect(kept).toHaveLength(3)
    expect(kept.some((name) => name.includes('.backup-vb-'))).toBe(true)
    expect(kept.some((name) => name.includes('.backup-vc-'))).toBe(true)
    expect(kept.some((name) => name.includes('.backup-vd-'))).toBe(true)
    expect(kept.some((name) => name.includes('.backup-va-'))).toBe(false)
    db.close()
  })

  it('leaves partial residue alone and never evicts the verified fallback', () => {
    // Retention is stat-only now (POD-3068): it does not open a retained file to
    // decide what to keep. Two things still hold — incomplete `.partial-` residue
    // is forensic and untouched, and the snapshot the verifier currently
    // advertises survives even when four newer candidates have been staged.
    const { db, dbPath, dir } = tmpDb()
    const partial = `${dbPath}.backup-vpartial-2026-08-17T00-00-00-000Z.partial-deadbeef`
    writeFileSync(partial, 'half a database')

    const fallback = backupDatabase(db, dbPath, 'proven', PLENTY) as string
    for (const label of ['a', 'b', 'c', 'd']) {
      backupDatabase(db, dbPath, label, PLENTY, undefined, () => fallback)
    }

    const present = readdirSync(dir)
    expect(present).toContain(basename(partial))
    expect(present).toContain(basename(fallback))
    expect(present.filter((name) => /\.backup-v[bcd]-/.test(name))).toHaveLength(3)
    expect(present.some((name) => name.includes('.backup-va-'))).toBe(false)
    db.close()
  })

  it('evicts the oldest set once it is no longer the verified fallback', () => {
    const { db, dbPath, dir } = tmpDb()
    const oldest = backupDatabase(db, dbPath, 'oldest', PLENTY) as string

    // No fallback is advertised, so ordinary retention applies to every set.
    for (const label of ['a', 'b', 'c', 'd']) backupDatabase(db, dbPath, label, PLENTY)

    expect(readdirSync(dir)).not.toContain(basename(oldest))
    expect(backupMains(dir)).toHaveLength(3)
    db.close()
  })

  it('does not fail a completed snapshot when pruning fails', () => {
    const { db, dbPath } = tmpDb()
    const prune = vi.fn(() => {
      throw new Error('retention unavailable')
    })

    const backupPath = backupDatabase(db, dbPath, 'kept', PLENTY, prune)

    expect(prune).toHaveBeenCalledWith(dbPath, undefined)
    expect(backupPath).toBeDefined()
    expect(existsSync(backupPath as string)).toBe(true)
    db.close()
  })
})

describe("backupDatabase keeps the live connection's SQLite locks [POD-6263]", () => {
  it('leaves another process unable to mistake itself for the only connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-backup-locks-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    configureStoreConnection(db)
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('before')`)
    try {
      // Before: the store's connection holds the database SHARED lock and the
      // wal-index deadman switch, like the healthy server on ludovico.
      const before = posixLocksOn(`${dbPath}-shm`)
      if (before) expect(readLockCovers(before, SHM_DEADMAN_SWITCH_BYTE)).toBe(true)

      backupDatabase(db, dbPath, 'locks', PLENTY)

      const shmLocks = posixLocksOn(`${dbPath}-shm`)
      const dbLocks = posixLocksOn(dbPath)
      if (shmLocks && dbLocks) {
        expect.soft(readLockCovers(shmLocks, SHM_DEADMAN_SWITCH_BYTE)).toBe(true)
        expect.soft(dbLocks.length).toBeGreaterThan(0)
      }

      // What any other program does next. Had this process dropped its locks,
      // another process could take the database exclusively, and an ordinary
      // reader would find itself alone: closing would checkpoint and delete
      // both sidecars this connection still has open and mapped.
      expect.soft(exclusiveLockFromAnotherProcess(dbPath)).toBe('refused')
      openFromAnotherProcess(dbPath)
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
      expect(existsSync(`${dbPath}-shm`)).toBe(true)

      db.exec(`INSERT INTO t (v) VALUES ('after')`)
      expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 })
    } finally {
      db.close()
    }
  })
})

describe('freeDiskBytes', () => {
  it('reports a positive free-byte count for a real directory', () => {
    expect(freeDiskBytes(tmpdir())).toBeGreaterThan(0)
  })
})
