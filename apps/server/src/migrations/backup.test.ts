/**
 * Backup unit tests (POD-615): free-space preflight, partial-backup cleanup on
 * copy failure, and retention pruning. Every assertion reads the backup
 * directory back from disk — a bare return-value check is never trusted on its
 * own. `freeBytes` is stubbed; `copyFileSync` is a pass-through vi.fn so one
 * test can simulate a mid-copy ENOSPC that leaves a truncated file behind.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backupDatabase, freeDiskBytes, MIGRATION_BACKUPS_TO_KEEP } from './backup'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) }
})

const PLENTY = () => Number.MAX_SAFE_INTEGER

function tmpDb(name = 'test.sqlite'): { db: SqlDatabase; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'podium-backup-'))
  const dbPath = join(dir, name)
  const db = openDatabase(dbPath)
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('x');`)
  return { db, dbPath, dir }
}

function backupMains(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.includes('.backup-v') && !n.endsWith('-wal') && !n.endsWith('-shm'))
    .sort()
}

beforeEach(() => {
  vi.mocked(copyFileSync).mockClear()
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
      expect(msg).toContain(dir) // names the path
      expect(msg).toContain(`need ~${Math.ceil(dbSize * 1.1)} bytes`) // required (db + 10% margin)
      expect(msg).toContain('only 10 bytes free') // available
    }
    expect(backupMains(dir)).toEqual([])
    db.close()
  })

  it('backs up successfully when space suffices', () => {
    const { db, dbPath, dir } = tmpDb()

    const backupPath = backupDatabase(db, dbPath, 'ok', PLENTY)

    expect(backupPath).toBeDefined()
    expect(dirname(backupPath as string)).toBe(dir)
    expect(existsSync(backupPath as string)).toBe(true)
    expect(statSync(backupPath as string).size).toBe(statSync(dbPath).size)
    expect(backupMains(dir)).toEqual([basename(backupPath as string)])
    db.close()
  })

  it('returns undefined when the database file does not exist', () => {
    const { db, dir } = tmpDb()
    expect(backupDatabase(db, join(dir, 'missing.sqlite'), 'x', PLENTY)).toBeUndefined()
    db.close()
  })
})

describe('backupDatabase partial-copy cleanup', () => {
  it('removes partially written backup files when a copy fails mid-way', () => {
    const { db, dbPath, dir } = tmpDb()
    // Simulate ENOSPC mid-copy: the destination gets a truncated file, then
    // the copy throws — exactly the Jul 15 full-disk failure mode.
    vi.mocked(copyFileSync).mockImplementationOnce((_src, dest) => {
      writeFileSync(dest as string, 'truncated')
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })

    expect(() => backupDatabase(db, dbPath, 'boom', PLENTY)).toThrow(/ENOSPC/)

    expect(backupMains(dir)).toEqual([]) // no truncated backup-v file lingers
    expect(readdirSync(dir).filter((n) => n.includes('.backup-v'))).toEqual([]) // nor sidecars
    db.close()
  })
})

describe('backupDatabase retention', () => {
  it('keeps only the newest MIGRATION_BACKUPS_TO_KEEP (=2) backups', () => {
    expect(MIGRATION_BACKUPS_TO_KEEP).toBe(2)
    const { db, dbPath, dir } = tmpDb()

    for (const label of ['a', 'b', 'c']) backupDatabase(db, dbPath, label, PLENTY)

    const kept = backupMains(dir)
    expect(kept).toHaveLength(2)
    expect(kept.some((n) => n.includes('.backup-vb-'))).toBe(true)
    expect(kept.some((n) => n.includes('.backup-vc-'))).toBe(true)
    expect(kept.some((n) => n.includes('.backup-va-'))).toBe(false)
    db.close()
  })
})

describe('freeDiskBytes', () => {
  it('reports a positive free-byte count for a real directory', () => {
    expect(freeDiskBytes(tmpdir())).toBeGreaterThan(0)
  })
})
