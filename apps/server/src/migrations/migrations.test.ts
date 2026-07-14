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

  it('009 backfills audience FROM origin so the board filter matches the old origin filter (#198)', () => {
    const db = openMemory()
    // Bring the schema to just before 009, seed rows with each origin.
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 8),
    )
    db.exec(
      `INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at, origin)
       VALUES ('iss_h', '/r', 1, 'human one', 'backlog', 'claude-code', 't', 't', 'human'),
              ('iss_a', '/r', 2, 'agent one', 'backlog', 'claude-code', 't', 't', 'agent')`,
    )
    // Apply 009.
    runMigrations(db)
    const rows = db.prepare('SELECT id, origin, audience FROM issues ORDER BY id').all() as {
      id: string
      origin: string
      audience: string
    }[]
    expect(rows).toEqual([
      { id: 'iss_a', origin: 'agent', audience: 'agent' },
      { id: 'iss_h', origin: 'human', audience: 'human' },
    ])
  })

  it('014 adds machines.inventory_json, nullable, existing rows read back NULL (#222)', () => {
    const db = openMemory()
    // Bring the schema to just before 014, seed a machine row.
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 13),
    )
    db.exec(
      `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
       VALUES ('m1', 'box', 'box.local', 'h', 't', 't')`,
    )
    // Apply 014.
    runMigrations(db)
    const cols = (db.prepare('PRAGMA table_info(machines)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('inventory_json')
    const row = db.prepare('SELECT inventory_json FROM machines WHERE id = ?').get('m1') as {
      inventory_json: string | null
    }
    expect(row.inventory_json).toBeNull()
    // Idempotent when the column already exists (a DB that ran a newer inline DDL).
    expect(() => MIGRATIONS.find((m) => m.version === 14)!.up(db)).not.toThrow()
  })

  it('021 resolves legacy issue:#seq senders to real issue ids, scoped to the recipient repo (#463)', () => {
    const db = openMemory()
    // Bring the schema to just before 016, seed the LEGACY shape: two repos
    // each holding an issue with the SAME seq (7), plus a recipient per repo.
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 15),
    )
    db.exec(
      `INSERT INTO issues (id, repo_path, repo_id, seq, title, stage, default_agent, created_at, updated_at)
       VALUES ('iss_a7', '/repo/a', 'repo-a', 7, 'a sender', 'backlog', 'claude-code', 't', 't'),
              ('iss_a9', '/repo/a', 'repo-a', 9, 'a recipient', 'backlog', 'claude-code', 't', 't'),
              ('iss_b7', '/repo/b', 'repo-b', 7, 'b sender', 'backlog', 'claude-code', 't', 't'),
              ('iss_b9', '/repo/b', 'repo-b', 9, 'b recipient', 'backlog', 'claude-code', 't', 't')`,
    )
    db.exec(
      `INSERT INTO issue_messages (id, issue_id, from_author, body, created_at, status)
       VALUES ('msg_a', 'iss_a9', 'issue:#7', 'from a', 't', 'unread'),
              ('msg_b', 'iss_b9', 'issue:#7', 'from b', 't', 'unread'),
              ('msg_x', 'iss_a9', 'issue:#404', 'ghost sender', 't', 'unread')`,
    )
    // 016 copies the raw refs in; 021 must repair them.
    runMigrations(db)
    const rows = db.prepare('SELECT id, from_issue FROM messages ORDER BY id').all() as {
      id: string
      from_issue: string | null
    }[]
    expect(rows).toEqual([
      { id: 'msg_a', from_issue: 'iss_a7' }, // repo a's #7, NOT repo b's
      { id: 'msg_b', from_issue: 'iss_b7' }, // repo b's #7, NOT repo a's
      { id: 'msg_x', from_issue: null }, // unresolvable → unattributed, never wrong
    ])
    // Idempotent: a second pass leaves the repaired/NULLed values untouched.
    const m021 = MIGRATIONS.find((m) => m.version === 21)!
    m021.up(db)
    expect(db.prepare('SELECT id, from_issue FROM messages ORDER BY id').all()).toEqual(rows)
  })

  it('022 applies workflows after an existing database has completed repair 021', () => {
    const db = openMemory()
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 21),
    )
    expect(dbSchemaVersion(db)).toBe(21)

    // Assert 022 RAN — not that it was the only thing that ran. Pinning the exact
    // array (`toEqual([22])`) hardcodes whatever happened to be the latest version,
    // so every later migration breaks this test for a reason unrelated to its intent.
    expect(runMigrations(db, MIGRATIONS)).toContain(22)
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion())
    const columns = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (column) => column.name,
    )
    expect(columns).toContain('from_name')
    const workflowTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'")
      .get()
    expect(workflowTable).toBeDefined()
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
