import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appliedMigrations,
  codeSchemaVersion,
  dbSchemaVersion,
  isTimestampVersion,
  LAST_SEQUENTIAL_VERSION,
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
 * Timestamp versions (#485) — make a collision IMPOSSIBLE, not merely loud.
 *
 * #472 made a duplicate migration number fail loudly instead of vanishing silently.
 * But it did not stop the collision happening: with hand-assigned sequential numbers,
 * two agents on parallel branches both take MAX+1 and clash at merge, every time.
 * A UTC timestamp cannot collide — there is nothing to coordinate. Rails made this
 * exact switch in 2.1.
 */
describe('migration versioning policy (#485)', () => {
  // Synthetic lists, NOT the real MIGRATIONS tail — these tests must keep working
  // when someone appends a migration, or they break for reasons unrelated to intent.
  const base: Migration[] = [{ version: 1, name: 'baseline', up: () => {} }]

  it('REJECTS a new migration that hand-picks the next sequential number', () => {
    const sequential = [
      ...base,
      { version: LAST_SEQUENTIAL_VERSION + 1, name: 'add-widget-table', up: () => {} },
    ]
    expect(() => runMigrations(openMemory(), sequential)).toThrow(/must use a UTC timestamp/i)
    // ...and tells the author exactly how to get a correct one.
    expect(() => runMigrations(openMemory(), sequential)).toThrow(/migration:new add-widget-table/)
  })

  it('ACCEPTS a timestamp version', () => {
    const db = openMemory()
    const timestamped = [
      ...base,
      { version: 20_260_714_132_200, name: 'add-widget-table', up: () => {} },
    ]
    expect(() => runMigrations(db, timestamped)).not.toThrow()
    expect(appliedMigrations(db).get(20_260_714_132_200)).toBe('add-widget-table')
  })

  it('EVERY registered migration obeys the policy — legacy sequential, or a timestamp', () => {
    // The invariant, expressed so it still holds after the next migration is added:
    // a version is legal iff it is one of the grandfathered 1..23, or a real timestamp.
    const illegal = MIGRATIONS.filter(
      (m) => m.version > LAST_SEQUENTIAL_VERSION && !isTimestampVersion(m.version),
    )
    expect(illegal).toEqual([])
    expect(() => runMigrations(openMemory(), MIGRATIONS)).not.toThrow()
  })

  it('accepts an OLDER timestamp merging after a newer one — the second-to-merge case', () => {
    // Agent A generates at 10:00, agent B at 10:05. B merges first. A then rebases and
    // its registry entry lands LAST, even though its version is OLDER. That is an
    // ordinary merge, not a mistake: both branches append to the same list.
    // It must just work — no error, no hand-reordering — and both migrations must run.
    const db = openMemory()
    const ran: string[] = []
    const merged: Migration[] = [
      ...base,
      { version: 20_260_714_100_500, name: 'agent-b', up: () => ran.push('b') }, // merged first
      { version: 20_260_714_100_000, name: 'agent-a', up: () => ran.push('a') }, // older, appended after
    ]

    const applied = runMigrations(db, merged)

    // Applied in VERSION order, not array order (base contributes version 1).
    expect(applied).toEqual([1, 20_260_714_100_000, 20_260_714_100_500])
    expect(ran).toEqual(['a', 'b'])
    expect(appliedMigrations(db).get(20_260_714_100_000)).toBe('agent-a')
    expect(appliedMigrations(db).get(20_260_714_100_500)).toBe('agent-b')
  })

  it("back-fills agent A's older migration onto a DB that already ran agent B's", () => {
    // The real sequence: B merges and deploys, so the live DB is stamped at B's version.
    // A then merges. A's version is LOWER than the DB's high-water mark — the exact
    // silent-skip shape from #472, now arriving by an ordinary route.
    const db = openMemory()
    const b: Migration = { version: 20_260_714_100_500, name: 'agent-b', up: () => {} }
    const a: Migration = {
      version: 20_260_714_100_000,
      name: 'agent-a',
      up: (d) => d.exec('CREATE TABLE agent_a_table (id TEXT)'),
    }
    runMigrations(db, [...base, b]) // B deployed alone
    expect(hasTable(db, 'agent_a_table')).toBe(false)

    const applied = runMigrations(db, [...base, b, a]) // now A lands

    expect(applied).toEqual([20_260_714_100_000]) // back-filled, NOT skipped
    expect(hasTable(db, 'agent_a_table')).toBe(true)
  })

  it('still rejects two migrations claiming the SAME version', () => {
    const dup: Migration[] = [
      ...base,
      { version: 20_260_714_100_000, name: 'agent-a', up: () => {} },
      { version: 20_260_714_100_000, name: 'agent-b', up: () => {} },
    ]
    expect(() => runMigrations(openMemory(), dup)).toThrow(/duplicate migration version/i)
  })

  it('rejects a number that merely looks like a timestamp', () => {
    expect(isTimestampVersion(20_261_314_132_200)).toBe(false) // month 13
    expect(isTimestampVersion(20_260_714_992_200)).toBe(false) // hour 99
    expect(isTimestampVersion(24)).toBe(false) // the mistake this exists to catch
    expect(isTimestampVersion(20_260_714_132_200)).toBe(true)
  })
})

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
    // Stamped PAST the hole — derived, never hardcoded, or appending any migration
    // breaks this test for a reason that has nothing to do with what it is testing.
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion())
    expect(dbSchemaVersion(db)).toBeGreaterThan(22)
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
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    const columnsOf = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    // 021 (repair) ran before this DB was stamped — 022, 023 and the timestamped
    // automations migration are the pending ones.
    expect(columnsOf('messages')).toContain('from_name') // 022 agent-workflows
    expect(hasTable('workflows')).toBe(true) // 022 agent-workflows
    expect(hasTable('accounts')).toBe(true) // 023 accounts (#216)
    expect(hasTable('automations')).toBe(true) // automations (#470)
    expect(hasTable('automation_runs')).toBe(true) // automations (#470)
  })

  // #470 [spec:SP-17db]: automations is the first TIMESTAMP-versioned migration (#485).
  // It was hand-numbered 022, then 023, while in flight — and main took BOTH numbers out
  // from under it (agent-workflows, then accounts). That is exactly the collision
  // timestamps abolish. What must hold regardless of the number it carries: it BUILDS ITS
  // SCHEMA on a database that already ran the whole sequential tail — i.e. every real one.
  it('applies automations onto a database that already ran every sequential migration', () => {
    const db = openMemory()
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= LAST_SEQUENTIAL_VERSION),
    )
    expect(dbSchemaVersion(db)).toBe(LAST_SEQUENTIAL_VERSION)

    const automations = MIGRATIONS.find((migration) => migration.name === 'automations')
    expect(automations).toBeDefined()
    // Not 24: a hand-picked MAX+1 is precisely what validate() now rejects (#485).
    expect(isTimestampVersion(automations!.version)).toBe(true)

    // `toContain`, not `toEqual`: appending another timestamped migration later must not
    // break this test — the schema assertions below are the real check.
    expect(runMigrations(db, MIGRATIONS)).toContain(automations!.version)
    expect(dbSchemaVersion(db)).toBe(codeSchemaVersion())
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('automations','automation_runs')",
        )
        .all() as { name: string }[]
    ).map((row) => row.name)
    expect(tables.sort()).toEqual(['automation_runs', 'automations'])
    // The earlier migrations' tables survive untouched alongside them.
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'")
        .get(),
    ).toBeDefined()
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(),
    ).toBeDefined()
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

  it('ACCEPTS an unsorted registry, applying in version order (#485)', () => {
    // This used to throw (/strictly increasing/). It no longer does, deliberately:
    // two branches both append to the registry, so whoever merges second lands their
    // entry last even when its version is older. Demanding a sorted ARRAY would turn
    // an ordinary merge into a hand-fix, for nothing — the runner sorts by version.
    // What must still be rejected is a DUPLICATE version, which is tested above.
    const db = openMemory()
    const ran: string[] = []
    expect(
      runMigrations(db, [
        { version: 2, name: 'b', up: () => ran.push('b') },
        { version: 1, name: 'a', up: () => ran.push('a') },
      ]),
    ).toEqual([1, 2])
    expect(ran).toEqual(['a', 'b'])
  })
})
