/**
 * The pre-migration backup's seed (POD-7576): the boot backup refreshed from a seed is
 * byte for byte the database whatever the seed held, the seed writer publishes only a
 * complete copy, and a migrating boot's backup restores the data written after the seed
 * was taken. Every filesystem fixture is removed after its test.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupDatabase, measureBackupSpace } from './backup'
import {
  backupSeedPath,
  discardBackupSeed,
  refreshFromSeed,
  SeedIdentityError,
  writeBackupSeed,
} from './backup-seed'
import { runDrizzleMigrations } from './index'
import { restoreDatabase } from './restore'
import { seedBackupFor } from './store-lifecycle'

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
/** A disk with room for anything. */
const ROOM = { requiredBytes: 0, freeBytes: () => Number.MAX_SAFE_INTEGER }
const PLENTY = () => Number.MAX_SAFE_INTEGER

const backupMains = (dir: string) =>
  readdirSync(dir).filter(
    (name) => name.includes('.backup-v') && !name.endsWith('-wal') && !name.endsWith('-shm'),
  )

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

  it('writes nothing through a seed that is the database under another name', () => {
    const dir = tempDir()
    const sourcePath = join(dir, 'live.db')
    writeFileSync(sourcePath, live)
    const linked = join(dir, 'backup.partial')
    linkSync(sourcePath, linked)
    const before = statSync(sourcePath).mtimeMs
    expect(() => refreshFromSeed(sourcePath, linked)).toThrow(SeedIdentityError)
    expect(statSync(sourcePath).mtimeMs).toBe(before)
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

    const outcome = await writeBackupSeed(dbPath, ROOM)

    expect(outcome).toMatchObject({ seeded: true, bytes: bytes.length })
    expect(outcome).not.toHaveProperty('partial')
    expect(readFileSync(backupSeedPath(dbPath)).equals(bytes)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['podium.db', 'podium.db.backup-seed'])
  })

  it('publishes the copied prefix at its budget, and nothing when it copied nothing', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const bytes = randomBytes(17 * MIB)
    writeFileSync(dbPath, bytes)
    // Each clock read advances 20 ms: the budget runs out after the first 8 MiB chunk.
    let clock = 0
    const late = await writeBackupSeed(dbPath, { ...ROOM, budgetMs: 30, now: () => (clock += 20) })
    expect(late).toMatchObject({ seeded: true, partial: true, bytes: 8 * MIB })
    expect(readFileSync(backupSeedPath(dbPath)).equals(bytes.subarray(0, 8 * MIB))).toBe(true)

    clock = 0
    const never = await writeBackupSeed(dbPath, { ...ROOM, budgetMs: 10, now: () => (clock += 20) })
    expect(never).toMatchObject({ seeded: false })
    expect(readdirSync(dir)).toEqual(['podium.db'])

    const missing = await writeBackupSeed(join(dir, 'absent.db'), ROOM)
    expect(missing).toMatchObject({ seeded: false })
    expect(readdirSync(dir)).toEqual(['podium.db'])
  })

  /**
   * Review F1: the seed is written beside a server that is still serving. It starts
   * only on a disk the migrating boot would accept, and stops if other writes take the
   * room while it copies.
   */
  it('writes no seed on a disk the boot would refuse, and stops when the room goes', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    writeFileSync(dbPath, randomBytes(17 * MIB))
    const needed = measureBackupSpace(dbPath, PLENTY).needed
    const target = { schema: { migrations: ['20990101000000_new'] } }
    const applied = async () => []

    // Room for the backup (1.1x) but not for the upgrade (2.5x): no seed.
    const tight = await seedBackupFor(dbPath, target, applied, () => 2 * needed)
    expect(tight).toMatchObject({ seeded: false })
    expect(readdirSync(dir)).toEqual(['podium.db'])

    const roomy = await seedBackupFor(dbPath, target, applied, () => 3 * needed)
    expect(roomy).toMatchObject({ seeded: true, bytes: needed })
    discardBackupSeed(dbPath)

    // The disk fills while the seed copies: it is abandoned and removed.
    let reads = 0
    const filling = await seedBackupFor(dbPath, target, applied, () =>
      ++reads === 1 ? 3 * needed : 0,
    )
    expect(filling).toMatchObject({ seeded: false })
    expect(filling.seeded === false && filling.reason).toContain('fell below')
    expect(readdirSync(dir)).toEqual(['podium.db'])
  })

  it('counts a published seed of its own as space the backup reuses', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    writeFileSync(dbPath, randomBytes(MIB))
    expect(measureBackupSpace(dbPath, () => 0).reusable).toBe(0)
    await writeBackupSeed(dbPath, ROOM)
    expect(measureBackupSpace(dbPath, () => 0).reusable).toBe(MIB)
    discardBackupSeed(dbPath)
    expect(existsSync(backupSeedPath(dbPath))).toBe(false)
    symlinkSync(dbPath, backupSeedPath(dbPath))
    expect(measureBackupSpace(dbPath, () => 0).reusable).toBe(0)
  })
})

describe('the boot backup with a seed', () => {
  const FIRST = { name: '20990101000000_bench-first', sql: 'CREATE TABLE kept (v TEXT)' }
  const SECOND = { name: '20990101000001_bench-second', sql: 'CREATE TABLE added (v TEXT)' }

  /**
   * The guarantee the seed must not weaken: a failed migration rolls back from the
   * backup, so the backup holds every write up to the migrating boot, including the
   * ones the old server made after it copied the seed. Checked end to end: the seed's
   * own file becomes the backup, and the real restore puts it back over the migrated
   * database.
   */
  it('restores the writes made after the seed through the restore command', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    let expected: unknown[]
    try {
      runDrizzleMigrations(db, [FIRST], { dbPath })
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000)
        INSERT INTO kept SELECT 'before-' || i || '-' || hex(randomblob(256)) FROM n`)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(await writeBackupSeed(dbPath, ROOM)).toMatchObject({ seeded: true })
      const seedInode = statSync(backupSeedPath(dbPath)).ino

      // The old server keeps serving after the seed: updates, deletes and growth.
      db.exec(`UPDATE kept SET v = 'changed-' || rowid WHERE rowid % 7 = 0`)
      db.exec('DELETE FROM kept WHERE rowid % 11 = 0')
      db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<500)
        INSERT INTO kept SELECT 'after-' || i FROM n`)
      expected = db.prepare('SELECT v FROM kept ORDER BY rowid').all()

      // The migrating boot: the backup IS the seed's file, and the seed name is gone.
      expect(runDrizzleMigrations(db, [FIRST, SECOND], { dbPath })).toEqual([SECOND.name])
      expect(existsSync(backupSeedPath(dbPath))).toBe(false)
      expect(backupMains(dir)).toHaveLength(1)
      expect(statSync(join(dir, backupMains(dir)[0]!)).ino).toBe(seedInode)
    } finally {
      db.close()
    }

    // The migration "failed": roll back with the restore command.
    await restoreDatabase({ backupPath: join(dir, backupMains(dir)[0]!), dbPath })
    const restored = openDatabase(dbPath)
    try {
      expect(restored.prepare('SELECT v FROM kept ORDER BY rowid').all()).toEqual(expected)
      expect(
        restored.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").get(),
      ).toBeFalsy()
      expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      restored.close()
    }
  })

  /** Review F2: a link to the database is never taken over as its backup. */
  it.each([
    'hard link',
    'symlink',
  ] as const)('copies in full past a seed that is a %s to the database', (kind) => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    try {
      db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')")
      if (kind === 'hard link') linkSync(dbPath, backupSeedPath(dbPath))
      else symlinkSync(dbPath, backupSeedPath(dbPath))

      const backup = backupDatabase(db, dbPath, 'linked', PLENTY)!

      expect(statSync(backup).ino).not.toBe(statSync(dbPath).ino)
      expect(statSync(dbPath).nlink).toBe(1)
      expect(existsSync(backupSeedPath(dbPath))).toBe(false)
      expect(readFileSync(backup).equals(readFileSync(dbPath))).toBe(true)
      expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'kept' }])
    } finally {
      db.close()
    }
  })

  it('a migrating boot leaves no seed residue, and a boot with nothing to migrate removes the seed', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'podium.db')
    const db = openDatabase(dbPath)
    try {
      runDrizzleMigrations(db, [FIRST], { dbPath })
      await writeBackupSeed(dbPath, ROOM)
      expect(existsSync(backupSeedPath(dbPath))).toBe(true)
      expect(runDrizzleMigrations(db, [FIRST], { dbPath })).toEqual([])
      expect(existsSync(backupSeedPath(dbPath))).toBe(false)

      // Review F5: what a killed old server left beside a seed goes with the backup.
      await writeBackupSeed(dbPath, ROOM)
      writeFileSync(`${backupSeedPath(dbPath)}.partial-killed`, 'residue')
      expect(runDrizzleMigrations(db, [FIRST, SECOND], { dbPath })).toEqual([SECOND.name])
      expect(readdirSync(dir).filter((name) => name.includes('backup-seed'))).toEqual([])
    } finally {
      db.close()
    }
  })
})
