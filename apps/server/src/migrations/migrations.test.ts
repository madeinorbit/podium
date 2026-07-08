import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeSchemaVersion,
  dbSchemaVersion,
  MIGRATIONS,
  type Migration,
  runMigrations,
} from './index'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-migrations-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'test.db')
}

function openMemory(): SqlDatabase {
  const db = openDatabase(':memory:')
  cleanups.push(() => db.close())
  return db
}

describe('runMigrations', () => {
  it('stamps a fresh DB with the code schema version', () => {
    const db = openMemory()
    const applied = runMigrations(db, MIGRATIONS)
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version))
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion(MIGRATIONS))
    const rows = db.prepare('SELECT version, name FROM schema_version ORDER BY version').all()
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })))
  })

  it('is idempotent on re-run', () => {
    const db = openMemory()
    runMigrations(db, MIGRATIONS)
    const second = runMigrations(db, MIGRATIONS)
    expect(second).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }
    expect(Number(count.n)).toBe(MIGRATIONS.length)
  })

  it('refuses to run when the DB is newer than the code', () => {
    const db = openMemory()
    const baseline: Migration = { version: 1, name: 'baseline', up: () => {} }
    const future: Migration[] = [baseline, { version: 2, name: 'from-the-future', up: () => {} }]
    runMigrations(db, future)
    expect(() => runMigrations(db, [baseline])).toThrowError(
      /schema version 2 is newer than this build supports \(1\).*downgrade/i,
    )
    // Nothing was applied or removed by the refusal.
    expect(dbSchemaVersion(db)).toBe(2)
  })

  it('applies a sample migration once and only once across open/close cycles', () => {
    const path = tempDbPath()
    let upRuns = 0
    const migrations: Migration[] = [
      { version: 1, name: 'baseline', up: () => {} },
      {
        version: 2,
        name: 'add-widgets',
        up: (db) => {
          upRuns += 1
          db.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY)')
        },
      },
    ]

    const first = openDatabase(path)
    expect(runMigrations(first, migrations)).toEqual([1, 2])
    first.prepare('INSERT INTO widgets (id) VALUES (?)').run('w1')
    first.close()

    const second = openDatabase(path)
    expect(runMigrations(second, migrations)).toEqual([])
    expect(upRuns).toBe(1)
    // Table and data survived; migration did not re-create it.
    const row = second.prepare('SELECT id FROM widgets').get() as { id: string }
    expect(row.id).toBe('w1')
    expect(dbSchemaVersion(second)).toBe(2)
    second.close()
  })

  it('rolls back a failing migration atomically and reports which one failed', () => {
    const db = openMemory()
    const bad: Migration[] = [
      { version: 1, name: 'baseline', up: () => {} },
      {
        version: 2,
        name: 'explodes',
        up: (d) => {
          d.exec('CREATE TABLE half_done (id TEXT)')
          throw new Error('boom')
        },
      },
    ]
    expect(() => runMigrations(db, bad)).toThrowError(/migration 2 \(explodes\) failed: boom/)
    // Version 1 committed; version 2 fully rolled back.
    expect(dbSchemaVersion(db)).toBe(1)
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'`)
      .get()
    expect(table).toBeUndefined()
  })

  it('rejects non-increasing version lists', () => {
    const db = openMemory()
    expect(() =>
      runMigrations(db, [
        { version: 2, name: 'b', up: () => {} },
        { version: 1, name: 'a', up: () => {} },
      ]),
    ).toThrowError(/strictly increasing/)
  })
})
