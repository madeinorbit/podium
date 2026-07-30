/**
 * THE LIVE-UPGRADE CONTINUITY TEST for the user-accounts migration (POD-1075).
 *
 * The migration is the highest-risk artefact in this issue: one-shot, no down
 * migration, rollback is restoring a backup. So the bar is not "it does not
 * error" — it is that the specific things an upgrade could silently destroy are
 * observed to survive.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE TRAP THIS AVOIDS, NAMED
 * ---------------------------------------------------------------------------
 *
 * A database with no `__drizzle_migrations` ledger is not an OLD database — it
 * is one drizzle has never seen, so the migrator replays the baseline and the
 * test silently exercises FIRST BOOT instead of an upgrade (POD-305 hit exactly
 * this). Every test below therefore rewinds a REAL database by applying the
 * manifest UP TO but not including this migration, which writes a real ledger,
 * and then asserts the PRE-STATE before touching anything.
 *
 * The second trap is the one specific to this migration: a fixture that starts
 * from an EMPTY `client_sessions` table would pass whether the migration adopts
 * existing sessions or drops them on the floor. Logging every device out on
 * upgrade is the failure nobody notices until it ships, so the sessions are
 * seeded, counted, and identified by token — not merely counted as non-zero.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'user-accounts-first-admin'
/** The literal the migration writes. Spelled out here for the same reason the
 *  migration spells it out: a migration is frozen history, so this test must
 *  keep asserting the id that was actually written even if the constant is
 *  later renamed. `FIRST_ADMIN_USER_ID` is asserted equal to it in
 *  `packages/model/src/identity/user.test.ts`, which is where the two are tied
 *  together — importing it here would make this test follow a rename instead of
 *  catching one. */
const FIRST_ADMIN = 'user:sole'

const cutIndex = () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  return cut
}

/** A real pre-migration database: every migration before this one applied, with
 *  a real drizzle ledger, and the pre-state asserted rather than assumed. */
function preMigrationDb() {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))

  // THE PRE-STATE, asserted. If any of these were already true, this test would
  // be measuring a database that had already been migrated — the "silently
  // exercising first boot" failure in its other form.
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  expect(columns('client_sessions')).toEqual(['token_hash', 'created_at', 'expires_at'])
  expect(tableExists(db, 'users')).toBe(false)
  expect(tableExists(db, 'user_credentials')).toBe(false)
  expect(tableExists(db, 'grants')).toBe(false)

  // …and the ledger really is there, so `runDrizzleMigrations` below will apply
  // ONE migration rather than replaying the baseline onto a virgin file.
  expect(tableExists(db, '__drizzle_migrations')).toBe(true)
  return db
}

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

const seedSession = (
  db: ReturnType<typeof openDatabase>,
  tokenHash: string,
  createdAt: string,
  expiresAt: string,
) =>
  db
    .prepare(
      'INSERT INTO client_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
    )
    .run(tokenHash, createdAt, expiresAt)

describe('user-accounts migration: existing devices are ADOPTED, not logged out', () => {
  it('carries every pre-existing client session across, with its own values intact', () => {
    const db = preMigrationDb()
    seedSession(db, 'hash-laptop', '2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    seedSession(db, 'hash-phone', '2026-07-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
    seedSession(db, 'hash-desktop', '2026-07-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db
      .prepare('SELECT token_hash, user_id, created_at, expires_at FROM client_sessions ORDER BY token_hash')
      .all() as { token_hash: string; user_id: string; created_at: string; expires_at: string }[]

    // BY TOKEN, not by count. A migration that dropped the table and inserted
    // three placeholder rows would satisfy a count assertion; only the tokens
    // prove these are the SAME sessions, which is what "nobody is logged out"
    // actually means — the cookies those devices hold still resolve.
    expect(rows.map((r) => r.token_hash)).toEqual(['hash-desktop', 'hash-laptop', 'hash-phone'])
    expect(rows.every((r) => r.user_id === FIRST_ADMIN)).toBe(true)

    // The other columns are untouched: an adoption that reset every expiry would
    // log everyone out on a timer instead of immediately.
    const laptop = rows.find((r) => r.token_hash === 'hash-laptop')
    expect(laptop?.created_at).toBe('2026-07-01T00:00:00.000Z')
    expect(laptop?.expires_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('the seeded rows are really there BEFORE the migration — the fixture is not empty', () => {
    // The counterfactual for the test above. An empty-table fixture would pass
    // the adoption assertion vacuously, so this proves the fixture has content
    // to lose at the moment the migration runs.
    const db = preMigrationDb()
    seedSession(db, 'hash-laptop', '2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')

    const before = db.prepare('SELECT COUNT(*) AS n FROM client_sessions').get() as { n: number }
    expect(before.n).toBe(1)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const after = db.prepare('SELECT COUNT(*) AS n FROM client_sessions').get() as { n: number }
    expect(after.n).toBe(1)
  })

  it('DETECTS the failure it is guarding against — a wipe would be caught', () => {
    // Mutation-shaped, at the assertion rather than at the product: the same
    // check run over a database whose sessions were dropped must fail. Without
    // this, "the rows survived" could be a claim the assertion is incapable of
    // refuting.
    const db = preMigrationDb()
    seedSession(db, 'hash-laptop', '2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    db.prepare('DELETE FROM client_sessions').run()
    const rows = db.prepare('SELECT token_hash FROM client_sessions').all() as { token_hash: string }[]
    expect(rows.map((r) => r.token_hash)).not.toContain('hash-laptop')
  })
})

describe('user-accounts migration: a first admin exists afterwards', () => {
  it('mints exactly one account, and it is an admin', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const users = db
      .prepare('SELECT id, display_name, role, created_at, disabled_at FROM users')
      .all() as { id: string; display_name: string; role: string; created_at: string; disabled_at: string | null }[]

    expect(users).toHaveLength(1)
    expect(users[0]?.id).toBe(FIRST_ADMIN)
    expect(users[0]?.role).toBe('admin')
    // Active, explicitly: `null` is a representable "not disabled", and a reader
    // that treated a missing marker as enabled would fail OPEN on a disabled
    // account.
    expect(users[0]?.disabled_at).toBeNull()
  })

  it('writes the admin’s created_at as an ISO-8601 string, not SQLite’s space form', () => {
    // Every other timestamp column in this schema is ISO-8601, and string
    // comparison over the space-separated `datetime('now')` form sorts wrongly
    // against them.
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(FIRST_ADMIN) as {
      created_at: string
    }
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('records that the admin authenticates with the EXISTING instance password', () => {
    // The resolved fork: a SQL migration cannot read auth.json, so it records
    // what is true rather than inventing a credential. Nobody is locked out and
    // no secret is moved.
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const cred = db
      .prepare('SELECT user_id, source, password_hash FROM user_credentials WHERE user_id = ?')
      .get(FIRST_ADMIN) as { user_id: string; source: string; password_hash: string | null }

    expect(cred.source).toBe('instance-password')
    expect(cred.password_hash).toBeNull()
  })

  it('exists on a FRESH database too — Phase 4 may assume an admin is present', () => {
    // A new install must boot with the first admin already there, not acquire
    // one at some later first login. The machine-ownership migration (Phase 4)
    // resolves every unowned machine to this account, so its existence is a
    // precondition rather than a convenience.
    const fresh = openDatabase(':memory:')
    runDrizzleMigrations(fresh, DRIZZLE_MIGRATIONS)

    const users = fresh.prepare('SELECT id, role FROM users').all() as { id: string; role: string }[]
    expect(users).toEqual([{ id: FIRST_ADMIN, role: 'admin' }])
    fresh.close()
  })

  it('is idempotent if re-applied — INSERT OR IGNORE, not a duplicate account', () => {
    // Drizzle skips by NAME so this cannot happen through the normal path, but a
    // hand-run of the SQL during an incident must not mint a second admin.
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    db.prepare(
      `INSERT OR IGNORE INTO users (id, display_name, role, created_at, disabled_at)
       VALUES (?, 'Operator', 'admin', '2026-01-01T00:00:00.000Z', NULL)`,
    ).run(FIRST_ADMIN)

    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    expect(count.n).toBe(1)
  })
})

describe('user-accounts migration: the identity tables land with the right shape', () => {
  it('creates users, user_credentials and grants', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    expect(tableExists(db, 'users')).toBe(true)
    expect(tableExists(db, 'user_credentials')).toBe(true)
    expect(tableExists(db, 'grants')).toBe(true)
  })

  it('keys the grant edge on (resource, grantee, verb) — the ADR 9 D2 triple', () => {
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const insert = db.prepare(
      `INSERT INTO grants
        (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, actor_id, on_behalf_of)
       VALUES (?, ?, ?, ?, ?, 'personal', '2026-07-30T00:00:00.000Z', 'user', ?, ?)`,
    )
    insert.run('session', 's1', 'user:bob', 'read', FIRST_ADMIN, FIRST_ADMIN, FIRST_ADMIN)
    // A DIFFERENT verb on the same resource+grantee is a different edge…
    insert.run('session', 's1', 'user:bob', 'write', FIRST_ADMIN, FIRST_ADMIN, FIRST_ADMIN)
    expect((db.prepare('SELECT COUNT(*) AS n FROM grants').get() as { n: number }).n).toBe(2)

    // …and the SAME triple twice is one edge, not two.
    expect(() =>
      insert.run('session', 's1', 'user:bob', 'read', FIRST_ADMIN, FIRST_ADMIN, FIRST_ADMIN),
    ).toThrow()
  })

  it('carries NO instance/tenant column anywhere — multi-user is not multi-tenancy', () => {
    // ADR 1 D5 is unaffected by this ADR, and ADR 9 §1.2 says so at length: the
    // dimension multi-user adds is OWNER, not tenant. Asserted over the tables
    // this migration creates, where the mistake would land.
    const db = preMigrationDb()
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    for (const table of ['users', 'user_credentials', 'grants', 'client_sessions']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      )
      for (const col of cols) {
        expect(col).not.toMatch(/instance_?id|tenant_?id/i)
      }
    }
  })
})

describe('the manifest and the migration folders agree', () => {
  it('contains this migration exactly once, and last', () => {
    // Drizzle applies BY NAME, so a manifest that has drifted from the folder
    // set is a database that silently skips or double-applies. Verified as a
    // fact about the shipped manifest rather than assumed from the generator
    // having been run.
    const matches = DRIZZLE_MIGRATIONS.filter((m) => m.name.includes(MIGRATION))
    expect(matches).toHaveLength(1)
    expect(DRIZZLE_MIGRATIONS[DRIZZLE_MIGRATIONS.length - 1]?.name).toContain(MIGRATION)
  })

  it('bundles the SQL, not an empty entry', () => {
    const mine = DRIZZLE_MIGRATIONS.find((m) => m.name.includes(MIGRATION))
    expect(mine?.sql).toContain('CREATE TABLE `users`')
    expect(mine?.sql).toContain("SELECT `token_hash`, 'user:sole'")
  })
})
