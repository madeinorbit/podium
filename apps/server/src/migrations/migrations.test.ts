import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appliedMigrations,
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

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

/**
 * The silent-skip class (#472).
 *
 * The runner used to decide what to apply by comparing against MAX(applied) — so a
 * migration numbered at or below the highest applied one was SKIPPED, with no error
 * and no table. It shipped undetected for a long time for one structural reason:
 * every other test in this file starts from an EMPTY database, which applies every
 * migration in order and therefore CANNOT exhibit the bug. Only an already-upgraded
 * database — which is every real one — can.
 *
 * So these tests all start from a partially-migrated database, and assert on the
 * SCHEMA rather than on runMigrations()'s return value: the bookkeeping and the
 * schema are precisely the two things that disagree when a migration is skipped.
 */
describe('runMigrations — back-filled and colliding versions (#472)', () => {
  /** A DB that has applied everything EXCEPT `hole` — i.e. stamped past it. */
  function dbWithHole(hole: number): { db: SqlDatabase; withoutHole: Migration[] } {
    const withoutHole = MIGRATIONS.filter((m) => m.version !== hole)
    const db = openMemory()
    runMigrations(db, withoutHole)
    return { db, withoutHole }
  }

  it('APPLIES a migration numbered below the high-water mark instead of skipping it', () => {
    // The hole is 022, and 023 IS applied — so the DB's high-water mark is 23 while
    // 022 is missing. That is the shape of every real database when two branches land
    // out of order. The old runner asked `version <= MAX(23)` and skipped 022 forever:
    // no error, `workflows` never created.
    const { db } = dbWithHole(22)
    expect(dbSchemaVersion(db)).toBe(23) // stamped PAST the hole
    expect(hasTable(db, 'workflows')).toBe(false) // ...yet 022's table is missing

    const applied = runMigrations(db, MIGRATIONS)

    expect(applied).toEqual([22]) // back-filled, not skipped
    expect(hasTable(db, 'workflows')).toBe(true)
  })

  it('records the back-filled migration so a second run is a no-op', () => {
    const { db } = dbWithHole(22)
    runMigrations(db, MIGRATIONS)
    expect(runMigrations(db, MIGRATIONS)).toEqual([])
    expect(appliedMigrations(db).get(22)).toBe('agent-workflows')
  })

  it('REFUSES TO BOOT when two branches claimed the same version number', () => {
    // Exactly the #216 near-miss: the DB applied 016 'messages'; this build defines
    // 016 as 'accounts'. Skipping it (version already applied) would silently drop a
    // migration — the very failure this issue exists to kill. It must be loud.
    const db = openMemory()
    runMigrations(db, MIGRATIONS) // DB now has 16 = 'messages'

    // A build in which version 16 is a DIFFERENT migration — precisely #216's near-miss.
    // Keep every other version so the downgrade guard is not what fires.
    const collided: Migration[] = MIGRATIONS.map((m) =>
      m.version === 16 ? { version: 16, name: 'accounts', up: () => {} } : m,
    )

    expect(() => runMigrations(db, collided)).toThrow(/duplicate migration version 16/i)
    expect(() => runMigrations(db, collided)).toThrow(/renumber/i)
    // And it refuses BEFORE touching the schema.
    expect(appliedMigrations(db).get(16)).toBe('messages')
  })

  it('BACKS UP before back-filling — the fix must not trade a skip for data loss', () => {
    // The backup predicate used to ask `version > MAX` too. Had we fixed only the
    // apply loop, an out-of-order migration would run with NO snapshot.
    const dir = mkdtempSync(join(tmpdir(), 'podium-mig-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const dbPath = join(dir, 'podium.db')

    const db = openDatabase(dbPath)
    cleanups.push(() => db.close())
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version !== 22),
      { dbPath },
    )
    const before = readdirSync(dir).filter((f) => f.includes('.backup-v')).length

    runMigrations(db, MIGRATIONS, { dbPath })

    const after = readdirSync(dir).filter((f) => f.includes('.backup-v')).length
    expect(after).toBeGreaterThan(before)
  })
})

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

  /**
   * Every pending migration must actually BUILD ITS SCHEMA on an already-upgraded
   * database — not merely get stamped into schema_version.
   *
   * This is the shape of bug that matters here (#472): the runner decides what to
   * apply by comparing against MAX(applied) rather than the applied set, so a
   * migration can be silently skipped and leave its table missing, with no error.
   * Asserting on runMigrations()'s RETURN VALUE cannot catch that — the bookkeeping
   * and the schema are exactly the two things that can disagree. So assert the
   * schema.
   *
   * Every other migration test starts from an EMPTY database, which applies
   * everything in order and therefore cannot exhibit the failure at all. This one
   * starts from a partially-migrated database, like every real one.
   */
  it('builds the schema of each later migration on an already-upgraded database', () => {
    const db = openMemory()
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 21),
    )
    expect(dbSchemaVersion(db)).toBe(21)

    runMigrations(db, MIGRATIONS)
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion())

    const hasTable = (name: string) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined
    const columnsOf = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    // 021 (repair) ran before this DB was stamped — 022 and 023 are the pending ones.
    expect(columnsOf('messages')).toContain('from_name') // 022 agent-workflows
    expect(hasTable('workflows')).toBe(true) // 022 agent-workflows
    expect(hasTable('accounts')).toBe(true) // 023 accounts (#216)
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
