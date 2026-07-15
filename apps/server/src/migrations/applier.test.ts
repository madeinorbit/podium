/**
 * Applier unit tests [spec:SP-4428]: `runDrizzleMigrations` / `stampMigration` /
 * `appliedDrizzleNames` / `migrateDatabase` against SYNTHETIC migrations, so the
 * behavior under test is the applier + bridge logic itself, never the real
 * (60+ table) production schema — that convergence is covered separately in
 * convergence.test.ts. Every assertion reads the SCHEMA or the
 * `__drizzle_migrations` ledger back from SQLite; a bare return-value check is
 * never trusted on its own.
 */

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { BASELINE_MIGRATION, DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import {
  appliedDrizzleNames,
  BASELINE_LEGACY_VERSION,
  type DrizzleMigration,
  migrateDatabase,
  runDrizzleMigrations,
  stampMigration,
} from './index'

const A: DrizzleMigration = {
  name: '20260101000000_a',
  sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);',
}
const B: DrizzleMigration = {
  name: '20260101000001_b',
  sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);',
}
const C: DrizzleMigration = {
  name: '20260101000002_c',
  sql: 'CREATE TABLE c (id TEXT PRIMARY KEY);',
}

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

function tmpDbFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-applier-')), name)
}

describe('runDrizzleMigrations', () => {
  it('fresh apply: builds the tables and writes matching __drizzle_migrations rows', () => {
    const db = openDatabase(':memory:')
    const applied = runDrizzleMigrations(db, [A, B, C])

    expect(applied).toEqual([A.name, B.name, C.name])
    expect(hasTable(db, 'a')).toBe(true)
    expect(hasTable(db, 'b')).toBe(true)
    expect(hasTable(db, 'c')).toBe(true)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, B.name, C.name]))
    db.close()
  })

  it('idempotent: a second run applies nothing and leaves the ledger unchanged', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, [A, B, C])
    const before = appliedDrizzleNames(db)

    const second = runDrizzleMigrations(db, [A, B, C])

    expect(second).toEqual([])
    expect(appliedDrizzleNames(db)).toEqual(before)
    db.close()
  })

  it('#472 back-fill: a DB that applied A and C (not B) applies exactly B, regardless of position', () => {
    const db = openDatabase(':memory:')
    // Build a DB that has a hole at B — the scenario #472 exists to guard
    // against (a migration applied by NAME set membership, not by counting).
    runDrizzleMigrations(db, [A, C])
    expect(hasTable(db, 'b')).toBe(false)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, C.name]))

    const applied = runDrizzleMigrations(db, [A, B, C])

    expect(applied).toEqual([B.name])
    expect(hasTable(db, 'b')).toBe(true)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, B.name, C.name]))
    db.close()
  })

  it('downgrade guard: a DB ahead of the given migration set throws and touches nothing', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, [A, B, C])
    const before = appliedDrizzleNames(db)

    expect(() => runDrizzleMigrations(db, [A, B])).toThrow(/newer than this build/i)
    // The guard fires before any backup/migrate work — ledger is byte-for-byte
    // what it was.
    expect(appliedDrizzleNames(db)).toEqual(before)
    db.close()
  })

  it('one-transaction batch: a bad migration rolls back the WHOLE pending batch', () => {
    const db = openDatabase(':memory:')
    const BAD: DrizzleMigration = {
      name: '20260101000001_bad',
      sql: 'THIS IS NOT VALID SQL AT ALL',
    }

    expect(() => runDrizzleMigrations(db, [A, BAD, C])).toThrow()

    // drizzle applies the whole pending set in ONE transaction: A's CREATE
    // TABLE ran (in name order) before BAD's failure, but the ROLLBACK undoes
    // the entire batch — nothing from it partially commits.
    expect(hasTable(db, 'a')).toBe(false)
    expect(hasTable(db, 'c')).toBe(false)
    expect(appliedDrizzleNames(db)).toEqual(new Set())
    db.close()
  })

  it('backup (#43): an empty file gets no backup; an advancing one does', () => {
    const file = tmpDbFile('applier.db')
    const dir = dirname(file)
    const db = openDatabase(file)
    const backupsIn = () => readdirSync(dir).filter((n) => n.includes('.backup-v'))

    // First apply: the file is brand new (no real tables yet) — not worth
    // backing up.
    runDrizzleMigrations(db, [A], { dbPath: file })
    expect(backupsIn()).toEqual([])

    // Second apply: the DB now holds a real table (`a`) and is advancing —
    // #43's pre-migration snapshot fires.
    runDrizzleMigrations(db, [A, B], { dbPath: file })
    expect(backupsIn().length).toBeGreaterThan(0)

    db.close()
  })
})

describe('stampMigration', () => {
  it('records a migration as applied WITHOUT running its SQL', () => {
    const db = openDatabase(':memory:')

    expect(stampMigration(db, A)).toBe(true)
    expect(hasTable(db, 'a')).toBe(false) // never executed
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name]))

    // A later run skips it by name — the ledger entry alone is enough.
    const applied = runDrizzleMigrations(db, [A, B])
    expect(applied).toEqual([B.name])
    expect(hasTable(db, 'a')).toBe(false)
    expect(hasTable(db, 'b')).toBe(true)
    db.close()
  })

  it('returns false when the migration is already recorded', () => {
    const db = openDatabase(':memory:')
    expect(stampMigration(db, A)).toBe(true)
    expect(stampMigration(db, A)).toBe(false)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name]))
    db.close()
  })
})

describe('migrateDatabase bridge', () => {
  function isoNow(): string {
    return new Date().toISOString()
  }

  function execBaselineDDL(db: SqlDatabase): void {
    for (const stmt of BASELINE_MIGRATION.sql.split('--> statement-breakpoint')) {
      db.exec(stmt)
    }
  }

  function stampLegacyVersion(db: SqlDatabase, version: number, name: string): void {
    db.exec(
      `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    )
    db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
      version,
      name,
      isoNow(),
    )
  }

  it('empty :memory: builds the baseline (and any pending migrations past it)', () => {
    const db = openDatabase(':memory:')
    const applied = migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)

    expect(applied).toContain(BASELINE_MIGRATION.name)
    expect(hasTable(db, 'sessions')).toBe(true)
    expect(appliedDrizzleNames(db)).toContain(BASELINE_MIGRATION.name)
    db.close()
  })

  it('EXISTING at exactly BASELINE_LEGACY_VERSION: stamps the baseline, preserves data, never re-executes it', () => {
    const db = openDatabase(':memory:')
    execBaselineDDL(db)
    stampLegacyVersion(db, BASELINE_LEGACY_VERSION, 'session-geometry')
    db.prepare(`INSERT INTO meta (key, value) VALUES ('seed', 'still-here')`).run()

    const applied = migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)

    // Nothing was "applied" in the executed sense — the baseline was stamped,
    // and (with only the baseline in the manifest) there is nothing pending
    // past it.
    expect(applied).toEqual([])
    expect(appliedDrizzleNames(db)).toEqual(new Set([BASELINE_MIGRATION.name]))
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'seed'`).get()).toEqual({
      value: 'still-here',
    })
    db.close()
  })

  it('SELF-HEALS an empty ledger from a crashed adoption instead of re-running the baseline', () => {
    const db = openDatabase(':memory:')
    execBaselineDDL(db)
    stampLegacyVersion(db, BASELINE_LEGACY_VERSION, 'session-geometry')
    db.prepare(`INSERT INTO meta (key, value) VALUES ('seed', 'still-here')`).run()
    // Simulate a crash during the first adoption boot: the ledger table exists
    // but is EMPTY (the stamp's INSERT never committed). A discriminator keyed on
    // table PRESENCE would skip the bridge and try to RE-RUN the baseline against
    // the already-built schema — 'table sessions already exists' — wedging every
    // future boot. The empty-ledger check re-enters the bridge and re-stamps.
    db.exec(
      `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
    )

    const applied = migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)

    expect(applied).toEqual([])
    expect(appliedDrizzleNames(db)).toEqual(new Set([BASELINE_MIGRATION.name]))
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'seed'`).get()).toEqual({
      value: 'still-here',
    })
    db.close()
  })

  it('BEHIND BASELINE_LEGACY_VERSION: refuses — the legacy chain that would heal it is gone', () => {
    const db = openDatabase(':memory:')
    execBaselineDDL(db)
    stampLegacyVersion(db, BASELINE_LEGACY_VERSION - 1, 'pre-baseline')

    expect(() => migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)).toThrow(
      /run the last pre-drizzle/i,
    )
    // The guard fires before the ledger table is even created.
    expect(hasTable(db, '__drizzle_migrations')).toBe(false)
    db.close()
  })

  it('AHEAD of BASELINE_LEGACY_VERSION: refuses — downgrade', () => {
    const db = openDatabase(':memory:')
    execBaselineDDL(db)
    stampLegacyVersion(db, BASELINE_LEGACY_VERSION + 1, 'future')

    expect(() => migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)).toThrow(
      /newer than this build.?s baseline|downgrade/i,
    )
    expect(hasTable(db, '__drizzle_migrations')).toBe(false)
    db.close()
  })

  it('data tables but neither ledger: refuses as unrecognized', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE mystery (id TEXT PRIMARY KEY)')

    expect(() => migrateDatabase(db, DRIZZLE_MIGRATIONS, BASELINE_MIGRATION)).toThrow(
      /unrecognized/i,
    )
    expect(hasTable(db, '__drizzle_migrations')).toBe(false)
    db.close()
  })
})
