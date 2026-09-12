/**
 * THE LIVE-UPGRADE TEST for PDM-280's credential adoption.
 *
 * Two migrations land together and the split is the design: `managed-credential-
 * owner` creates `managed_credentials` keyed (owner_user_id, id), and
 * `managed-credential-adoption` decides who the rows already in `accounts`
 * belong to. Nothing is dropped by either — the old table is the rollback path
 * for one release, and PDM-296 removes it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST IS FOR, GIVEN THAT THE MIGRATION IS ONE-SHOT AND IRREVERSIBLE
 * ---------------------------------------------------------------------------
 *
 * The bar is not "it does not error". It is that each shape a real instance can
 * be holding resolves the way the spec says — an instance with one admin, one
 * with several, one whose admins are all disabled, and one that has already run
 * it — and that the two properties the design leans on are OBSERVED rather than
 * assumed: the adopted rows are marked as adopted, and `accounts` still holds
 * what it held.
 *
 * THE FIXTURE TRAP, avoided as `a2-ownership-backfill.test.ts` avoids it: a
 * database with no `__drizzle_migrations` ledger is not an old database, it is
 * one drizzle has never seen, so the migrator would replay the baseline and the
 * test would silently exercise FIRST BOOT. Every case here rewinds a real
 * database by applying the manifest up to but NOT including the adoption, and
 * asserts the pre-state before touching anything.
 *
 * THE EARLIEST-ADMIN RULE IS TIED, NOT RESTATED. The migration's SQL is a THIRD
 * spelling of a rule `UsersRepository.earliestAdmin()` and
 * `EARLIEST_ADMIN_MEMBER_SQL` already spell twice, and the existing tie between
 * those two is a test that runs both against one database. This file joins that
 * tie the same way — by asserting the owner the migration PICKED is the id
 * `earliestAdmin()` returns for the same database — rather than by comparing the
 * SQL text, which would pass while the two diverged in what they select.
 */

import { asUserId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { UsersRepository } from '../store/users'
import { stageASeam } from '../test-support/stage-a-seam'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const ADOPTION = 'managed-credential-adoption'

const indexOf = (name: string): number => {
  const i = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(name))
  expect(i, `${name} missing from the manifest`).toBeGreaterThan(0)
  return i
}

const tablesOf = (db: SqlDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name)

/** Every migration before the adoption: `managed_credentials` EXISTS and is
 *  empty, and `accounts` is still the only place a credential lives. */
function preAdoptionDb(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(ADOPTION)))

  // THE PRE-STATE. If these were already true the fixture would be a migrated
  // database and every assertion below would be measuring nothing.
  expect(tablesOf(db)).toContain('accounts')
  expect(tablesOf(db)).toContain('managed_credentials')
  expect(countOf(db)).toBe(0)
  return db
}

const applyAdoption = (db: SqlDatabase): void => {
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(ADOPTION) + 1))
}

const countOf = (db: SqlDatabase): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM managed_credentials').get() as { n: number }).n

/**
 * A MIGRATED DATABASE ALREADY HAS AN ADMIN, and a fixture that forgets it
 * measures the wrong instance.
 *
 * The chain mints one (`user-accounts-first-admin`, re-keyed by
 * `retire-the-solo-user`), so "seed an admin and expect it to win" is only true
 * if the seeded row sorts earlier — which is why every case here passes an
 * explicit `createdAt` rather than relying on a default, and why the
 * no-admin case has to disable the minted one as well as its own.
 *
 * This is the fixture trap of `a2-ownership-backfill.test.ts` from the other
 * side: there the risk was a database drizzle had never seen; here it is a
 * database that is MORE populated than the test assumes.
 */
function seedAdmin(
  db: SqlDatabase,
  id: string,
  opts: { createdAt?: string; role?: string; disabledAt?: string } = {},
): void {
  db.prepare(
    'INSERT OR IGNORE INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, id, opts.role ?? 'admin', opts.createdAt ?? '2026-01-01', opts.disabledAt ?? null)
}

/** Every admin this database has, minted or seeded, retired. */
function disableEveryAdmin(db: SqlDatabase): void {
  db.prepare("UPDATE users SET disabled_at = '2026-05-01' WHERE role = 'admin'").run()
  expect(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL")
        .get() as { n: number }
    ).n,
  ).toBe(0)
}

function seedAccount(db: SqlDatabase, id: string, credential: string): void {
  db.prepare(
    "INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at) VALUES (?, ?, 'api-key', ?, 'mask', 'role', 1)",
  ).run(id, id.replace('managed:', ''), credential)
}

const credentialsOf = (db: SqlDatabase) =>
  db
    .prepare(
      'SELECT owner_user_id AS owner, id, credential, provenance FROM managed_credentials ORDER BY id',
    )
    .all() as { owner: string; id: string; credential: string; provenance: string }[]

it('adopts every existing credential to the earliest admin, marked as adopted', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_founder', { createdAt: '2026-01-01' })
  seedAdmin(db, 'mem_later_admin', { createdAt: '2026-06-01' })
  seedAccount(db, 'managed:anthropic', 'sk-ant-live')
  seedAccount(db, 'managed:openai', 'sk-oai-live')

  applyAdoption(db)

  expect(credentialsOf(db)).toEqual([
    {
      owner: 'mem_founder',
      id: 'managed:anthropic',
      credential: 'sk-ant-live',
      provenance: 'adopted-instance-credential',
    },
    {
      owner: 'mem_founder',
      id: 'managed:openai',
      credential: 'sk-oai-live',
      provenance: 'adopted-instance-credential',
    },
  ])

  // THE TIE. Not a second spelling of the rule — the repository's answer for
  // this very database, so a divergence between the two reddens here.
  const users = new UsersRepository(stageASeam(db))
  const adopted = credentialsOf(db)[0]
  expect(adopted).toBeDefined()
  expect(asUserId(adopted?.owner ?? '')).toBe((await users.earliestAdmin())?.id)
})

it('leaves the source rows exactly where they were — the rollback path', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_founder', { createdAt: '2026-01-01' })
  seedAccount(db, 'managed:anthropic', 'sk-ant-live')

  applyAdoption(db)

  // An older binary swapped back in reads `accounts`, and must still find it.
  // This is the assertion that makes "expand-only" a property rather than a
  // claim in a commit message.
  const rows = db.prepare('SELECT id, credential FROM accounts').all() as {
    id: string
    credential: string
  }[]
  expect(rows).toEqual([{ id: 'managed:anthropic', credential: 'sk-ant-live' }])
})

it('ignores a disabled admin and adopts to the earliest ACTIVE one', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_retired', { createdAt: '2026-01-01', disabledAt: '2026-05-01' })
  seedAdmin(db, 'mem_current', { createdAt: '2026-02-01' })
  seedAccount(db, 'managed:anthropic', 'sk-ant-live')

  applyAdoption(db)

  expect(credentialsOf(db).map((r) => r.owner)).toEqual(['mem_current'])
})

it('adopts nothing, rather than failing, when no admin resolves', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_member', { role: 'member' })
  seedAccount(db, 'managed:anthropic', 'sk-ant-live')
  disableEveryAdmin(db)

  // Without the EXISTS guard the scalar subquery yields NULL and this throws on
  // `owner_user_id NOT NULL` — "nobody to adopt to" becoming a failed upgrade.
  expect(() => applyAdoption(db)).not.toThrow()

  expect(countOf(db)).toBe(0)
  // And the credential is not lost: it is where it always was.
  expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(1)
})

it('is re-entrant: a second run copies nothing and overwrites nothing', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_founder', { createdAt: '2026-01-01' })
  seedAccount(db, 'managed:anthropic', 'sk-ant-live')
  applyAdoption(db)

  // The owner has since rotated their key through the hub — a 'connected' row at
  // the same slot. Re-running the adoption must not resurrect the old secret.
  db.prepare(
    "UPDATE managed_credentials SET credential = 'sk-ant-rotated', provenance = 'connected'",
  ).run()
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, indexOf(ADOPTION) + 1))

  expect(credentialsOf(db)).toEqual([
    {
      owner: 'mem_founder',
      id: 'managed:anthropic',
      credential: 'sk-ant-rotated',
      provenance: 'connected',
    },
  ])
})

it('refuses a provenance value outside the vocabulary', async () => {
  const db = preAdoptionDb()
  seedAdmin(db, 'mem_founder', { createdAt: '2026-01-01' })
  applyAdoption(db)

  // The CHECK is what makes "adopted keys are countable by class" true rather
  // than conventional: a third value cannot be written at all.
  expect(() =>
    db
      .prepare(
        "INSERT INTO managed_credentials (owner_user_id, id, provider, kind, credential, identity, scope, created_at, provenance) VALUES ('mem_founder', 'managed:openai', 'openai', 'api-key', 'sk', '', 'role', 1, 'imported')",
      )
      .run(),
  ).toThrow()
})
