/**
 * THE LIVE-UPGRADE TEST for the solo-user retirement (A2, spec §8).
 *
 * The migration is one-shot, has no down migration, and re-keys the owner of
 * every row an instance holds. Rollback is restoring the backup the runner takes
 * at boot. So the bar is not "it does not error" — it is that the specific
 * things this upgrade could silently destroy are observed to survive, and that
 * the one thing it must leave behind is observed to be gone EVERYWHERE.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FIXTURE TRAPS, AND HOW EACH IS AVOIDED
 * ---------------------------------------------------------------------------
 *
 * 1. A database with no `__drizzle_migrations` ledger is not an OLD database —
 *    it is one drizzle has never seen, so the migrator replays the baseline and
 *    the test silently exercises FIRST BOOT instead of an upgrade (POD-305 hit
 *    exactly this, and `user-accounts.test.ts` records it). Every test here
 *    rewinds a REAL database by applying the manifest up to but NOT including
 *    this migration, and asserts the pre-state before touching anything.
 *
 * 2. An EMPTY database would pass every assertion below vacuously: a re-key that
 *    rewrote nothing and a re-key that rewrote everything are indistinguishable
 *    with no rows to re-key. So {@link seedEveryOwnerColumn} puts a real row in
 *    every table that can hold a user id, with the literal in it, and the count
 *    of seeded rows is asserted non-trivial before the migration runs.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE COLUMN LIST COMES FROM, AND WHY THAT IS NOT CIRCULAR
 * ---------------------------------------------------------------------------
 *
 * Not from the migration, which would only prove the migration does what it
 * says. From the PRE-MIGRATION SCHEMA: every text column of every table whose
 * name says it holds a person — `user_id`, `owner*`, `on_behalf_of`, `actor*`,
 * `created_by*`, `updated_by*`, `grantee`, `assignee`, `requested_by*` — read
 * off `PRAGMA table_info` at test time.
 *
 * That list is frozen by construction even though it is derived: the schema it
 * is read from is the schema as of the migration before this one, so a column
 * added later cannot appear in it and cannot make this test fail for a reason
 * that is not a bug. And the final sweep is wider still — after the migration,
 * EVERY text column of EVERY table is searched for the literal, so a column the
 * name rule missed is caught by the value rather than by the name.
 */

import { MemberId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { mintIdsIn, runDrizzleMigrations } from './index'

const MIGRATION = 'retire-the-solo-user'

/** The id the migration retires. Spelled out for the reason the migration
 *  spells it out: this test must keep asserting the value that was actually
 *  written, whatever the model later calls it. */
const RETIRED = 'user:sole'

/** Column names that name a person. The same rule the migration's list was
 *  derived from, stated here independently so the two can disagree. */
const HOLDS_A_PERSON =
  /(^user_id$|^owner|^on_behalf_of$|^actor$|^actor_id$|^created_by_actor$|^created_by_id$|^created_by_on_behalf_of$|^updated_by_id$|^grantee$|^assignee$|^requested_by_actor_id$|^requested_by_on_behalf_of$)/

const cutIndex = () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  return cut
}

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const tablesOf = (db: SqlDatabase): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)

const columnsOf = (db: SqlDatabase, table: string): ColumnInfo[] =>
  db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]

const isText = (type: string) => type === '' || /TEXT|CHAR|CLOB/i.test(type)

/** A real pre-migration database: every migration before this one applied, with
 *  a real drizzle ledger, and the pre-state asserted rather than assumed. */
function preMigrationDb(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))

  // THE PRE-STATE. If these were already true the fixture would be a migrated
  // database and every assertion below would be measuring nothing.
  const first = db.prepare('SELECT id FROM users').all() as { id: string }[]
  expect(first.map((r) => r.id)).toEqual([RETIRED])
  expect(defaultOf(db, 'sessions', 'owner_user_id')).toBe(`'${RETIRED}'`)
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('__drizzle_migrations'),
  ).toBeDefined()
  return db
}

const defaultOf = (db: SqlDatabase, table: string, column: string): string | null =>
  columnsOf(db, table).find((c) => c.name === column)?.dflt_value ?? null

/**
 * Every (table, column) the pre-migration schema says can hold a person. Read
 * off the database rather than listed, so this test's subject is the schema and
 * not somebody's memory of it.
 */
function personColumns(db: SqlDatabase): { table: string; column: string }[] {
  const out: { table: string; column: string }[] = []
  for (const table of tablesOf(db)) {
    if (table === '__drizzle_migrations') continue
    for (const c of columnsOf(db, table)) {
      if (!isText(c.type)) continue
      if (table === 'users' && c.name === 'id') out.push({ table, column: c.name })
      else if (HOLDS_A_PERSON.test(c.name)) out.push({ table, column: c.name })
    }
  }
  return out
}

function tableSql(db: SqlDatabase, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined
  return row?.sql ?? ''
}

/**
 * The first value a column's `CHECK (... IN (...))` admits, if it has one.
 *
 * Read off the table's own DDL rather than listed here, because a list of
 * "columns that refuse a placeholder" is a second copy of the schema — it would
 * be correct on the day it was written and quietly wrong afterwards, which for a
 * seeder means a test that stops seeding a table and passes anyway.
 */
function checkedValue(db: SqlDatabase, table: string, column: string): string | undefined {
  const match = new RegExp(`\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(tableSql(db, table))
  const first = match?.[1]?.split(',')[0]?.trim()
  return first?.startsWith("'") ? first.slice(1, -1) : undefined
}

/** Placeholders are unique per seeded row: two columns of one table each get
 *  their own row, and a table with a UNIQUE column refuses the second one
 *  otherwise — as `execution_profiles.name` does. */
let seedCounter = 0

function seedRow(db: SqlDatabase, table: string, column: string): boolean {
  seedCounter += 1
  const cols = columnsOf(db, table)
  const names: string[] = []
  const values: unknown[] = []
  for (const c of cols) {
    if (c.name === column) {
      names.push(c.name)
      values.push(RETIRED)
      continue
    }
    if (table === 'ship_orders' && ['repo_path', 'machine_id'].includes(c.name)) {
      names.push(c.name)
      values.push(`seed-${c.name}-${seedCounter}`)
      continue
    }
    if (c.notnull === 0 || c.dflt_value !== null) continue
    if (c.pk === 1 && /INTEGER/i.test(c.type)) continue
    names.push(c.name)
    values.push(checkedValue(db, table, c.name) ?? (isText(c.type) ? `seed-${c.name}-${seedCounter}` : seedCounter))
  }
  const sql = `INSERT INTO ${table} (${names.map((n) => `\`${n}\``).join(', ')}) VALUES (${names
    .map(() => '?')
    .join(', ')})`
  try {
    db.prepare(sql).run(...(values as never[]))
    return true
  } catch (err) {
    throw new Error(`could not seed ${table}.${column}: ${String(err)}\n${sql}`)
  }
}

/**
 * Put one row holding the literal into every table that can hold it.
 *
 * Generic on purpose — a hand-written INSERT per table is a list that goes stale
 * the first time a column gains a NOT NULL. Every column that must be supplied
 * (NOT NULL, no default, not the target) gets a placeholder of its declared
 * type, or, where a CHECK constraint refuses one, the first value that
 * constraint admits, read off the table's own DDL ({@link checkedValue}).
 *
 * Returns how many rows landed, so the caller can refuse to assert against an
 * empty database.
 */
function seedEveryOwnerColumn(db: SqlDatabase): number {
  let seeded = 0
  for (const { table, column } of personColumns(db)) {
    // `users.id` is already the literal — that row IS the subject, and a second
    // one would collide on the primary key.
    if (table === 'users' && column === 'id') continue
    if (seedRow(db, table, column)) seeded += 1
  }
  return seeded
}

/** Every place in the whole database still spelling the literal, named. Value-
 *  based, so it catches a column the name rule never considered. */
function survivingLiterals(db: SqlDatabase): string[] {
  const found: string[] = []
  for (const table of tablesOf(db)) {
    if (table === '__drizzle_migrations') continue
    for (const c of columnsOf(db, table)) {
      if (!isText(c.type)) continue
      const hit = db
        .prepare(`SELECT 1 AS hit FROM ${table} WHERE \`${c.name}\` = ? LIMIT 1`)
        .get(RETIRED) as { hit: number } | undefined
      if (hit) found.push(`${table}.${c.name}`)
    }
  }
  return found
}

const firstAdminId = (db: SqlDatabase): string =>
  (db.prepare('SELECT id FROM users').get() as { id: string }).id

describe('retire-the-solo-user: the first member gets a minted id', () => {
  it('replaces the literal with a well-formed mem_ id', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db.prepare('SELECT id, role, disabled_at FROM users').all() as {
      id: string
      role: string
      disabled_at: string | null
    }[]
    expect(rows).toHaveLength(1)
    // Through the real boundary schema, not a regex: `MemberId` checks the
    // prefix, the alphabet, the width AND that the body is twenty bytes a mint
    // could have produced, which is the clause a regex cannot express.
    expect(() => MemberId.parse(rows[0]?.id)).not.toThrow()
    expect(rows[0]?.role).toBe('admin')
    expect(rows[0]?.disabled_at).toBeNull()
  })

  it('mints a DIFFERENT id on a second installation', () => {
    // The property that separates this from "a constant with a nicer prefix".
    // If the id were frozen into the migration, every installation on earth
    // would share one member id and this would be the assertion that says so.
    const a = preMigrationDb()
    const b = preMigrationDb()
    runDrizzleMigrations(a, DRIZZLE_MIGRATIONS)
    runDrizzleMigrations(b, DRIZZLE_MIGRATIONS)
    expect(firstAdminId(a)).not.toBe(firstAdminId(b))
  })

  it('keeps the account otherwise intact — created_at, display name, credential', () => {
    const db = preMigrationDb()
    const before = db.prepare('SELECT display_name, created_at FROM users').get() as {
      display_name: string
      created_at: string
    }
    db.prepare(
      'INSERT OR REPLACE INTO user_credentials (user_id, source, password_hash, updated_at) VALUES (?, ?, ?, ?)',
    ).run(RETIRED, 'per-user-scrypt', 'scrypt:hash', '2026-08-01T00:00:00.000Z')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const after = db.prepare('SELECT id, display_name, created_at FROM users').get() as {
      id: string
      display_name: string
      created_at: string
    }
    expect(after.display_name).toBe(before.display_name)
    expect(after.created_at).toBe(before.created_at)

    // THE PASSWORD STILL WORKS, which is the whole point of re-keying the
    // credential row rather than leaving it behind: a migration that re-keyed
    // `users` alone would lock the operator out of their own instance with a
    // credential row pointing at an id that no longer exists.
    const credential = db
      .prepare('SELECT user_id, password_hash FROM user_credentials')
      .get() as { user_id: string; password_hash: string }
    expect(credential.user_id).toBe(after.id)
    expect(credential.password_hash).toBe('scrypt:hash')
  })

  it('leaves a member who is not the solo user alone', () => {
    const db = preMigrationDb()
    db.prepare(
      'INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, NULL)',
    ).run('anna', 'Anna', 'member', '2026-08-01T00:00:00.000Z')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const ids = (db.prepare('SELECT id FROM users ORDER BY created_at').all() as { id: string }[]).map(
      (r) => r.id,
    )
    expect(ids).toContain('anna')
    expect(ids).toHaveLength(2)
  })
})

describe('retire-the-solo-user: shipping approval custody', () => {
  function shippingDb(): SqlDatabase {
    const db = preMigrationDb()
    db.prepare(`INSERT INTO ship_orders (
      id, issue_id, repo_id, target_branch, destination, approved_base_sha, approved_head_sha,
      requested_by_actor_kind, requested_by_actor_id, requested_by_on_behalf_of,
      requested_at, policy_id, close_mode, state, state_changed_at, repo_path, machine_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'order-review', 'issue-review', 'repo-review', 'main', 'local', 'base', 'head',
      'user', RETIRED, RETIRED, '2026-09-01', 'policy', 'leave-open', 'queued',
      '2026-09-01', '/tmp/review-repo', 'machine-review')
    return db
  }

  const triggers = (db: SqlDatabase) => db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ship_orders' ORDER BY name",
  ).all()

  it('re-keys a queued order with production triggers and preserves frozen evidence', () => {
    const db = shippingDb()
    try {
      const before = db.prepare('SELECT * FROM ship_orders').get() as Record<string, unknown>
      const guards = triggers(db)
      expect(guards.length).toBeGreaterThan(0)
      expect(() => db.exec("UPDATE ship_orders SET approved_head_sha = 'tampered'"))
        .toThrow('ship order approval is immutable')

      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

      expect(db.prepare('SELECT * FROM ship_orders').get()).toEqual({
        ...before,
        requested_by_actor_id: firstAdminId(db),
        requested_by_on_behalf_of: firstAdminId(db),
      })
      expect(triggers(db)).toEqual(guards)
      for (const column of ['requested_by_actor_id', 'requested_by_on_behalf_of', 'approved_head_sha',
        'approved_base_sha', 'evidence_manifest_ref', 'current_integration_receipt',
        'validation_profile', 'validation_profile_digest']) {
        expect(() => db.exec(`UPDATE ship_orders SET ${column} = 'tampered'`))
          .toThrow('ship order approval is immutable')
      }
      expect(() => db.exec("UPDATE ship_orders SET machine_id = 'tampered'"))
        .toThrow('ship order lane custody is immutable')
    } finally { db.close() }
  })

  it.each(['evidence', 'identity', 'after-restore'])('restores identity and production guards on rollback (%s)', (failure) => {
    const db = shippingDb()
    try {
      const guards = triggers(db)
      const manifest = DRIZZLE_MIGRATIONS.map((migration) => migration.name.includes(MIGRATION)
        ? { ...migration, sql: failure === 'after-restore' ? migration.sql.replace(
          'DROP TRIGGER `ship_orders_member_rekey_guard`;',
          "UPDATE ship_orders SET approved_head_sha = 'tampered';",
        ) : migration.sql.replace(
          "UPDATE `ship_orders` SET `requested_by_actor_id` = '{{mint:mem_}}'",
          failure === 'evidence'
            ? "UPDATE `ship_orders` SET `approved_head_sha` = 'tampered', `requested_by_actor_id` = '{{mint:mem_}}'"
            : "UPDATE `ship_orders` SET `requested_by_actor_id` = 'mem_not_the_minted_member'",
        ) }
        : migration)
      expect(() => runDrizzleMigrations(db, manifest)).toThrow()
      expect(firstAdminId(db)).toBe(RETIRED)
      expect(db.prepare('SELECT requested_by_actor_id AS actor FROM ship_orders').get())
        .toEqual({ actor: RETIRED })
      expect(triggers(db)).toEqual(guards)
      expect(() => db.exec("UPDATE ship_orders SET requested_by_actor_id = 'tampered'"))
        .toThrow('ship order approval is immutable')
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(firstAdminId(db)).not.toBe(RETIRED)
    } finally { db.close() }
  })
})

describe('retire-the-solo-user: every reference moves, in one transaction', () => {
  it('rewrites the literal in EVERY column that can hold it, with rows in each', () => {
    const db = preMigrationDb()
    const seeded = seedEveryOwnerColumn(db)

    // The fixture has something to lose. A vacuous pass is the failure this
    // migration would otherwise ship with.
    expect(seeded).toBeGreaterThan(40)
    expect(survivingLiterals(db).length).toBeGreaterThan(40)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    // Named, not counted: a failure has to say WHICH column was missed, because
    // "63 of 66" is a five-minute search and `issues.assignee` is not.
    expect(survivingLiterals(db)).toEqual([])
  })

  it('points every rewritten reference at the SAME member — the one in `users`', () => {
    // Sixty-six statements, one member. A substitution that minted per statement
    // would satisfy "the literal is gone" and leave a database where nothing
    // owns anything.
    const db = preMigrationDb()
    seedEveryOwnerColumn(db)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const id = firstAdminId(db)
    const owners = db
      .prepare('SELECT DISTINCT owner_user_id AS o FROM sessions UNION SELECT DISTINCT owner_user_id FROM issues UNION SELECT DISTINCT user_id FROM client_sessions UNION SELECT DISTINCT user_id FROM pins')
      .all() as { o: string }[]
    expect(owners.map((r) => r.o)).toEqual([id])
  })

  it('adopts existing sessions rather than logging anyone out', () => {
    const db = preMigrationDb()
    db.prepare(
      'INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run('hash-laptop', RETIRED, '2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const row = db
      .prepare('SELECT token_hash, user_id, expires_at FROM client_sessions')
      .get() as { token_hash: string; user_id: string; expires_at: string }
    // BY TOKEN: the cookie that device holds still resolves, and to the new id.
    expect(row.token_hash).toBe('hash-laptop')
    expect(row.user_id).toBe(firstAdminId(db))
    expect(row.expires_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('rewrites the owner inside the replication feed, so a replica bootstraps correctly', () => {
    const db = preMigrationDb()
    db.prepare(
      'INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)',
    ).run('session', 'sess-1', 'upsert', `{"id":"sess-1","ownerUserId":"${RETIRED}"}`, 1)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const payload = (db.prepare('SELECT payload FROM changes').get() as { payload: string }).payload
    expect(payload).toBe(`{"id":"sess-1","ownerUserId":"${firstAdminId(db)}"}`)
  })

  it('DETECTS the failure it guards against — a missed column would be caught', () => {
    // Mutation-shaped, at the assertion rather than at the product: the sweep
    // must be capable of failing, or "no literals survive" is a claim it cannot
    // refute.
    const db = preMigrationDb()
    seedEveryOwnerColumn(db)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(survivingLiterals(db)).toEqual([])

    db.prepare('UPDATE pins SET user_id = ?').run(RETIRED)
    expect(survivingLiterals(db)).toContain('pins.user_id')
  })
})

describe('retire-the-solo-user: the defaults are gone', () => {
  it('drops the literal default from every column that carried one', () => {
    const db = preMigrationDb()
    // The pre-state, from the database rather than from the brief: which columns
    // actually defaulted to the literal before this migration ran.
    const defaulted = tablesOf(db).flatMap((table) =>
      columnsOf(db, table)
        .filter((c) => c.dflt_value === `'${RETIRED}'`)
        .map((c) => `${table}.${c.name}`),
    )
    expect(defaulted.length).toBeGreaterThan(10)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const still = tablesOf(db).flatMap((table) =>
      columnsOf(db, table)
        .filter((c) => c.dflt_value === `'${RETIRED}'`)
        .map((c) => `${table}.${c.name}`),
    )
    expect(still).toEqual([])
  })

  it('keeps every rebuilt table rebuildable — indexes and rows survive the rebuild', () => {
    // The rebuild is create/copy/drop/rename, which is the shape POD-1621 warns
    // about: a rebuild written without knowledge of another lineage's column
    // silently drops it, and the ledger still reads as complete. Rows and
    // indexes are what a reader would lose.
    const db = preMigrationDb()
    seedEveryOwnerColumn(db)
    const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const after = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(after.n).toBe(before.n)
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toContain('idx_sessions_deleted_at')
    expect(indexes).toContain('idx_sessions_resume_machine')
  })
})

describe('mintIdsIn: what the migration asks the runner for', () => {
  it('gives every occurrence of one prefix the SAME id', () => {
    const out = mintIdsIn('A {{mint:mem_}} B {{mint:mem_}}')
    const ids = [...out.matchAll(/mem_[0-9A-Za-z]{27}/g)].map((m) => m[0])
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('mints a real branded id, from the same mint every other member row uses', () => {
    const out = mintIdsIn('{{mint:mem_}}')
    expect(() => MemberId.parse(out)).not.toThrow()
  })

  it('gives two prefixes two ids', () => {
    const out = mintIdsIn('{{mint:mem_}} {{mint:inv_}}', (prefix) => `${prefix}X`)
    expect(out).toBe('mem_X inv_X')
  })

  it('leaves a migration with no token exactly as it was', () => {
    // Which is every migration but one, so this is the path that must not
    // surprise anyone.
    const sql = 'CREATE TABLE widgets (id text PRIMARY KEY);'
    expect(mintIdsIn(sql)).toBe(sql)
  })
})
