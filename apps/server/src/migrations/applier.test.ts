/**
 * Applier unit tests [spec:SP-4428]: `runDrizzleMigrations` / `appliedDrizzleNames`
 * against SYNTHETIC migrations, so the behavior under test is the applier logic
 * itself, never the real
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
import { appliedDrizzleNames, type DrizzleMigration, runDrizzleMigrations } from './index'

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
