/**
 * Durable snapshot tests: free-space refusal, atomic publication, partial-copy
 * cleanup, bounded retention, suspicious-file preservation, and non-fatal
 * pruning. Every filesystem fixture is removed after its test.
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
  backupDatabase,
  createLatestDatabaseBackupCache,
  freeDiskBytes,
  latestDatabaseBackup,
  MIGRATION_BACKUPS_TO_KEEP,
} from './backup'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
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
    .filter((name) => name.includes('.backup-v') && !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort()
}

beforeEach(() => {
  vi.mocked(copyFileSync).mockClear()
  vi.mocked(fsyncSync).mockClear()
  vi.mocked(renameSync).mockClear()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('latest database backup cache', () => {
  it('quick-checks snapshot history once and records a new process-owned snapshot', () => {
    const inspect = vi.fn(() => '/state/podium.db.backup-vold')
    const cache = createLatestDatabaseBackupCache('/state/podium.db', inspect)

    expect(cache.latest()).toBe('/state/podium.db.backup-vold')
    expect(cache.latest()).toBe('/state/podium.db.backup-vold')
    expect(inspect).toHaveBeenCalledTimes(1)

    cache.record('/state/podium.db.backup-vnew')
    expect(cache.latest()).toBe('/state/podium.db.backup-vnew')
    expect(inspect).toHaveBeenCalledTimes(1)
  })
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

  it('publishes a sufficient snapshot only after temp-copy fsync and rename', () => {
    const { db, dbPath, dir } = tmpDb()

    const backupPath = backupDatabase(db, dbPath, 'ok', PLENTY)

    expect(backupPath).toBeDefined()
    expect(dirname(backupPath as string)).toBe(dir)
    expect(existsSync(backupPath as string)).toBe(true)
    expect(statSync(backupPath as string).size).toBe(statSync(dbPath).size)
    expect(backupMains(dir)).toEqual([basename(backupPath as string)])
    expect(String(vi.mocked(copyFileSync).mock.calls[0]?.[1])).toContain('.partial-')
    expect(vi.mocked(renameSync).mock.calls.at(-1)?.[1]).toBe(backupPath)
    const fileFsyncOrder = vi.mocked(fsyncSync).mock.invocationCallOrder[0]
    const publishOrder = vi.mocked(renameSync).mock.invocationCallOrder.at(-1)
    if (fileFsyncOrder === undefined || publishOrder === undefined) {
      throw new Error('snapshot did not reach fsync and rename')
    }
    expect(fileFsyncOrder).toBeLessThan(publishOrder)
    db.close()
  })

  it('returns undefined when the database file does not exist', () => {
    const { db, dir } = tmpDb()
    expect(backupDatabase(db, join(dir, 'missing.sqlite'), 'x', PLENTY)).toBeUndefined()
    db.close()
  })
})

describe('backupDatabase partial-copy cleanup', () => {
  it('never publishes the truncated file when a copy fails mid-way', () => {
    const { db, dbPath, dir } = tmpDb()
    vi.mocked(copyFileSync).mockImplementationOnce((_src, dest) => {
      writeFileSync(dest as string, 'truncated')
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

  it('does not count or delete corrupt and partial snapshots as keepers', () => {
    const { db, dbPath, dir } = tmpDb()
    const corrupt = `${dbPath}.backup-vcorrupt-2026-08-17T00-00-00-000Z`
    const partial = `${dbPath}.backup-vpartial-2026-08-17T00-00-00-000Z.partial-deadbeef`
    writeFileSync(corrupt, 'not sqlite')
    writeFileSync(partial, 'half a database')

    for (const label of ['a', 'b', 'c', 'd']) backupDatabase(db, dbPath, label, PLENTY)

    const present = readdirSync(dir)
    expect(present).toContain(basename(corrupt))
    expect(present).toContain(basename(partial))
    expect(present.filter((name) => /\.backup-v[bcd]-/.test(name))).toHaveLength(3)
    expect(present.some((name) => name.includes('.backup-va-'))).toBe(false)
    expect(latestDatabaseBackup(dbPath)).toContain('.backup-vd-')
    db.close()
  })

  it('does not fail a completed snapshot when pruning fails', () => {
    const { db, dbPath } = tmpDb()
    const prune = vi.fn(() => {
      throw new Error('retention unavailable')
    })

    const backupPath = backupDatabase(db, dbPath, 'kept', PLENTY, prune)

    expect(prune).toHaveBeenCalledWith(dbPath)
    expect(backupPath).toBeDefined()
    expect(existsSync(backupPath as string)).toBe(true)
    db.close()
  })
})

describe('freeDiskBytes', () => {
  it('reports a positive free-byte count for a real directory', () => {
    expect(freeDiskBytes(tmpdir())).toBeGreaterThan(0)
  })
})
