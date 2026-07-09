/**
 * Upgrade-path hardening tests (#43 backup, #44 single transaction, #45 fixtures,
 * #46 authoritative version).
 *
 * Fixture strategy: old-version databases are constructed by running the REAL
 * migration chain up to version N (the same technique migrations.test.ts uses
 * for the 009 backfill), seeding rows, then migrating to HEAD.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeSchemaVersion,
  dbSchemaVersion,
  MIGRATION_BACKUPS_TO_KEEP,
  MIGRATIONS,
  type Migration,
  runMigrations,
} from './index'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-upgrade-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function open(path: string): SqlDatabase {
  const db = openDatabase(path)
  cleanups.push(() => db.close())
  return db
}

/** Main backup files (not -wal/-shm sidecars) for the given db path. */
function backupsFor(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.backup-v`
  return readdirSync(dirname(dbPath))
    .filter((n) => n.startsWith(prefix) && !n.endsWith('-wal') && !n.endsWith('-shm'))
    .sort()
}

const SEED_ISSUES = `INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at, origin)
   VALUES ('iss_1', '/r', 1, 'seeded before upgrade', 'backlog', 'claude-code', 't0', 't0', 'human')`

describe('upgrade path (old fixture → HEAD)', () => {
  it('migrates a v8 database to HEAD, preserves seeded rows, and writes a backup', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath)
    db.exec('PRAGMA journal_mode = WAL')

    // Fixture: real chain up to version 8, with a seeded issue row.
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 8),
      { dbPath },
    )
    db.exec(SEED_ISSUES)
    expect(dbSchemaVersion(db)).toBe(8)

    const before = backupsFor(dbPath)
    const applied = runMigrations(db, MIGRATIONS, { dbPath })
    expect(applied).toEqual(MIGRATIONS.filter((m) => m.version > 8).map((m) => m.version))
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion(MIGRATIONS))

    // Seeded row survived the upgrade (009 backfilled audience from origin).
    const row = db
      .prepare('SELECT id, title, origin, audience FROM issues WHERE id = ?')
      .get('iss_1') as { id: string; title: string; origin: string; audience: string }
    expect(row).toEqual({
      id: 'iss_1',
      title: 'seeded before upgrade',
      origin: 'human',
      audience: 'human',
    })

    // Exactly one new backup, taken at the OLD version, containing the row.
    const created = backupsFor(dbPath).filter((n) => !before.includes(n))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatch(/podium\.db\.backup-v8-\d+-/)
    const backup = open(join(dirname(dbPath), created[0]!))
    expect(dbSchemaVersion(backup)).toBe(8)
    const backupRow = backup.prepare('SELECT title FROM issues WHERE id = ?').get('iss_1') as {
      title: string
    }
    expect(backupRow.title).toBe('seeded before upgrade')
  })

  it('takes no backup when no migration is needed', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath)
    runMigrations(db, MIGRATIONS, { dbPath })
    const before = backupsFor(dbPath)
    expect(runMigrations(db, MIGRATIONS, { dbPath })).toEqual([])
    expect(backupsFor(dbPath)).toEqual(before)
  })

  it('takes no backup for a brand-new empty database file', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath) // creates an empty file with no schema objects
    runMigrations(db, MIGRATIONS, { dbPath })
    expect(backupsFor(dbPath)).toEqual([])
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion(MIGRATIONS))
  })

  it(`prunes to the last ${MIGRATION_BACKUPS_TO_KEEP} backups`, () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath)
    const step = (v: number): Migration => ({
      version: v,
      name: `step-${v}`,
      up: (d) => d.exec(`CREATE TABLE t${v} (id TEXT)`),
    })
    // Five successive version-advancing runs → five backups taken, 3 kept.
    let chain: Migration[] = [step(1)]
    runMigrations(db, chain, { dbPath }) // fresh DB: no backup
    for (let v = 2; v <= 6; v++) {
      chain = [...chain, step(v)]
      runMigrations(db, chain, { dbPath })
    }
    const remaining = backupsFor(dbPath)
    expect(remaining).toHaveLength(MIGRATION_BACKUPS_TO_KEEP)
    // The newest backups (highest from-version) are the ones kept.
    for (const kept of remaining) {
      expect(kept).toMatch(/backup-v[345]-/)
    }
  })
})

describe('failed upgrade stops at the failing step', () => {
  it('keeps earlier steps stamped, rolls back only the failing one, leaves the backup on disk', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath)

    const good: Migration[] = [
      { version: 1, name: 'baseline', up: () => {} },
      { version: 2, name: 'widgets', up: (d) => d.exec('CREATE TABLE widgets (id TEXT)') },
    ]
    runMigrations(db, good, { dbPath })
    db.exec(`INSERT INTO widgets (id) VALUES ('w1')`)

    const withBad: Migration[] = [
      ...good,
      { version: 3, name: 'gadgets', up: (d) => d.exec('CREATE TABLE gadgets (id TEXT)') },
      {
        version: 4,
        name: 'explodes',
        up: () => {
          throw new Error('boom')
        },
      },
    ]
    expect(() => runMigrations(db, withBad, { dbPath })).toThrowError(
      /migration 4 \(explodes\) failed: boom/,
    )

    // Per-migration transactions [spec:SP-3fe2]: the good step (3) stays
    // applied and stamped; only the failing step (4) rolled back.
    expect(dbSchemaVersion(db)).toBe(3)
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gadgets'`).get(),
    ).toBeDefined()
    // Seeded data intact.
    const row = db.prepare('SELECT id FROM widgets').get() as { id: string }
    expect(row.id).toBe('w1')
    // The pre-run backup exists and holds the old version + data.
    const backups = backupsFor(dbPath).filter((n) => n.includes('backup-v2-4-'))
    expect(backups).toHaveLength(1)
    const backup = open(join(dirname(dbPath), backups[0]!))
    expect(dbSchemaVersion(backup)).toBe(2)
    expect((backup.prepare('SELECT id FROM widgets').get() as { id: string }).id).toBe('w1')
  })

  it('survives a reopen after a failed run (crash simulation)', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const first = openDatabase(dbPath)
    const good: Migration[] = [
      { version: 1, name: 'widgets', up: (d) => d.exec('CREATE TABLE widgets (id TEXT)') },
    ]
    runMigrations(first, good, { dbPath })
    first.exec(`INSERT INTO widgets (id) VALUES ('w1')`)
    const withBad: Migration[] = [
      ...good,
      {
        version: 2,
        name: 'explodes',
        up: (d) => {
          d.exec('CREATE TABLE half_done (id TEXT)')
          throw new Error('boom')
        },
      },
    ]
    expect(() => runMigrations(first, withBad, { dbPath })).toThrowError(/boom/)
    first.close() // "crash" boundary: nothing of the failed run may persist

    const second = open(dbPath)
    expect(dbSchemaVersion(second)).toBe(1)
    expect(
      second
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'`)
        .get(),
    ).toBeUndefined()
    expect((second.prepare('SELECT id FROM widgets').get() as { id: string }).id).toBe('w1')
    // Retrying with the bad step fixed completes the upgrade.
    const fixed: Migration[] = [
      ...good,
      { version: 2, name: 'fixed', up: (d) => d.exec('CREATE TABLE done (id TEXT)') },
    ]
    expect(runMigrations(second, fixed, { dbPath })).toEqual([2])
    expect(dbSchemaVersion(second)).toBe(2)
  })
})

describe('stored schema version is authoritative (#46)', () => {
  it('refuses to open a database from a newer build with an upgrade hint', () => {
    const dbPath = join(tempDir(), 'podium.db')
    const db = open(dbPath)
    const future: Migration[] = [
      ...MIGRATIONS,
      { version: codeSchemaVersion(MIGRATIONS) + 1, name: 'from-the-future', up: () => {} },
    ]
    runMigrations(db, future, { dbPath })
    const before = backupsFor(dbPath)
    expect(() => runMigrations(db, MIGRATIONS, { dbPath })).toThrowError(
      /newer than this build supports.*Upgrade the Podium server/s,
    )
    // Refusal is a pure read: no version change, no backup churn.
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion(future))
    expect(backupsFor(dbPath)).toEqual(before)
  })
})
