/**
 * The pre-migration backup's seed (POD-7576): the boot backup refreshed from a seed is
 * byte for byte the database whatever the seed held, the seed writer publishes only a
 * complete copy, and a migrating boot's backup restores the data written after the seed
 * was taken. Every filesystem fixture is removed after its test.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { measureBackupSpace } from './backup'
import { backupSeedPath, discardBackupSeed, refreshFromSeed, writeBackupSeed } from './backup-seed'
import { runDrizzleMigrations } from './index'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-backup-seed-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MIB = 1 << 20

/** Refresh a copy of `seed` from `source` and return what it did plus the result. */
function refreshed(source: Buffer, seed: Buffer | undefined) {
  const dir = tempDir()
  const sourcePath = join(dir, 'live.db')
  const targetPath = join(dir, 'backup.partial')
  writeFileSync(sourcePath, source)
  writeFileSync(targetPath, seed ?? Buffer.alloc(0))
  const report = refreshFromSeed(sourcePath, targetPath)
  return { report, result: readFileSync(targetPath) }
}

describe('refreshFromSeed', () => {
  const live = randomBytes(3 * MIB + 12_345)

  it('rewrites nothing when the seed is already the database', () => {
    const { report, result } = refreshed(live, Buffer.from(live))
    expect(result.equals(live)).toBe(true)
    expect(report).toEqual({ bytes: live.length, rewrittenBytes: 0 })
  })

  it('rewrites only the 4 KiB blocks that differ, wherever they fall', () => {
    const seed = Buffer.from(live)
    // First byte, both sides of a compare-chunk boundary, mid-chunk and the last byte.
    for (const at of [0, MIB - 1, MIB, 2 * MIB + 77, live.length - 1]) seed[at] = seed[at]! ^ 0xff
    const { report, result } = refreshed(live, seed)
    expect(result.equals(live)).toBe(true)
    // Five differing blocks, the last one short (the file is not a whole number of blocks).
    expect(report.rewrittenBytes).toBe(4 * 4096 + (live.length % 4096))
  })

  it('becomes the database from an empty, shorter, longer or unrelated seed', () => {
    for (const seed of [
      undefined,
      live.subarray(0, MIB + 5),
      Buffer.concat([live, randomBytes(2 * MIB)]),
      randomBytes(live.length),
      randomBytes(7),
    ]) {
      const { report, result } = refreshed(live, seed && Buffer.from(seed))
      expect(result.length).toBe(live.length)
      expect(result.equals(live)).toBe(true)
      expect(report.bytes).toBe(live.length)
    }
  })

  it('stamps the backup with the time it was taken, not the seed’s', () => {
    const dir = tempDir()
    const sourcePath = join(dir, 'live.db')
    const targetPath = join(dir, 'backup.partial')
    writeFileSync(sourcePath, live)
    writeFileSync(targetPath, live)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(targetPath, old, old)
    refreshFromSeed(sourcePath, targetPath)
    expect(statSync(targetPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })
})

describe('writeBackupSeed', () => {
  it('publishes a complete copy under the seed name, replacing an older seed', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const bytes = randomBytes(9 * MIB + 3)
    writeFileSync(dbPath, bytes)
    writeFileSync(backupSeedPath(dbPath), 'an older seed')
    writeFileSync(`${backupSeedPath(dbPath)}.partial-left-by-a-crash`, 'residue')

    const outcome = await writeBackupSeed(dbPath)

    expect(outcome).toMatchObject({ seeded: true, bytes: bytes.length })
    expect(readFileSync(backupSeedPath(dbPath)).equals(bytes)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['podium.db', 'podium.db.backup-seed'])
  })

  it('leaves nothing behind when the copy outstays its budget or cannot start', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    writeFileSync(dbPath, randomBytes(17 * MIB))
    let clock = 0
    const late = await writeBackupSeed(dbPath, { budgetMs: 10, now: () => (clock += 20) })
    expect(late).toMatchObject({ seeded: false })
    expect(readdirSync(dir)).toEqual(['podium.db'])

    const missing = await writeBackupSeed(join(dir, 'absent.db'))
    expect(missing).toMatchObject({ seeded: false })
    expect(readdirSync(dir)).toEqual(['podium.db'])
  })

  it('counts a published seed as space the backup reuses', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    writeFileSync(dbPath, randomBytes(MIB))
    expect(measureBackupSpace(dbPath, () => 0).reusable).toBe(0)
    await writeBackupSeed(dbPath)
    expect(measureBackupSpace(dbPath, () => 0).reusable).toBe(MIB)
    discardBackupSeed(dbPath)
    expect(existsSync(backupSeedPath(dbPath))).toBe(false)
  })
})

describe('the boot backup with a seed', () => {
  const FIRST = { name: '20990101000000_bench-first', sql: 'CREATE TABLE kept (v TEXT)' }
  const SECOND = { name: '20990101000001_bench-second', sql: 'CREATE TABLE added (v TEXT)' }

  /**
   * The guarantee the seed must not weaken: a failed migration rolls back from the
   * backup, so the backup holds every write up to the migrating boot, including the
   * ones the old server made after it copied the seed.
   */
  it('restores the writes made after the seed and is taken in its place', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    try {
      runDrizzleMigrations(db, [FIRST], { dbPath })
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000)
        INSERT INTO kept SELECT 'before-' || i || '-' || hex(randomblob(256)) FROM n`)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(await writeBackupSeed(dbPath)).toMatchObject({ seeded: true })

      // The old server keeps serving after the seed: updates, deletes and growth.
      db.exec(`UPDATE kept SET v = 'changed-' || rowid WHERE rowid % 7 = 0`)
      db.exec('DELETE FROM kept WHERE rowid % 11 = 0')
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<500)
        INSERT INTO kept SELECT 'after-' || i FROM n`)
      const expected = db.prepare('SELECT v FROM kept ORDER BY rowid').all()

      // The migrating boot: the backup comes from the seed, and the seed is gone.
      expect(runDrizzleMigrations(db, [FIRST, SECOND], { dbPath })).toEqual([SECOND.name])
      expect(existsSync(backupSeedPath(dbPath))).toBe(false)
      const backups = readdirSync(dir).filter(
        (name) => name.includes('.backup-v') && !name.endsWith('-wal') && !name.endsWith('-shm'),
      )
      expect(backups).toHaveLength(1)

      const restored = openDatabase(join(dir, backups[0]!))
      try {
        expect(restored.prepare('SELECT v FROM kept ORDER BY rowid').all()).toEqual(expected)
        expect(
          restored.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").get(),
        ).toBeFalsy()
        expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({
          integrity_check: 'ok',
        })
      } finally {
        restored.close()
      }
    } finally {
      db.close()
    }
  })

  it('a boot with nothing to migrate removes the seed', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    try {
      runDrizzleMigrations(db, [FIRST], { dbPath })
      await writeBackupSeed(dbPath)
      expect(existsSync(backupSeedPath(dbPath))).toBe(true)
      expect(runDrizzleMigrations(db, [FIRST], { dbPath })).toEqual([])
      expect(existsSync(backupSeedPath(dbPath))).toBe(false)
    } finally {
      db.close()
    }
  })
})
