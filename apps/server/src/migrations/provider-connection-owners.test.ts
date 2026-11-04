/**
 * THE UPGRADE TEST for `provider-connection-owners` (POD-6300; design §4.6, Q2).
 *
 * Before this release a managed provider connection was one instance-wide row
 * per account id. The migration gives every existing row an owner: the earliest
 * active admin, since no existing row records the machine it came from (the
 * upgrade note in CHANGELOG says so). Seeded on a database
 * rewound to the migration before this one (an upgrade, not a first boot).
 */

import { asAccountId, asMachineId, asUserId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { resolveAccountEnv } from '../modules/sessions/account-env'
import { AccountsRepository } from '../store/accounts'
import { stageASeam } from '../test-support/stage-a-seam'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'provider-connection-owners'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

const addMember = (
  db: SqlDatabase,
  id: string,
  role: 'admin' | 'member',
  createdAt: string,
  disabledAt: string | null = null,
) =>
  db
    .prepare(
      'INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, id, role, createdAt, disabledAt)

/** A row as the previous release wrote it: no owner, `id` is the account id. */
const seedConnection = (db: SqlDatabase, id: string, provider: string, credential: string) =>
  db
    .prepare(
      `INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at)
       VALUES (?, ?, 'api-key', ?, 'mask', 'role', 1)`,
    )
    .run(id, provider, credential)

const ownership = (db: SqlDatabase) =>
  db.prepare('SELECT id, ref, owner_user_id AS owner FROM accounts ORDER BY id').all()

/** The instance's existing first admin: the one member every database has. */
const firstAdmin = (db: SqlDatabase) =>
  (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: string
    }
  ).id

describe(`migration ${MIGRATION}`, () => {
  it('on a one-member database every connection belongs to that member and runs as before', async () => {
    const { db, upgrade } = rewound()
    try {
      const member = firstAdmin(db)
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1)
      seedConnection(db, 'managed:anthropic', 'anthropic', 'sk-ant-before')
      seedConnection(db, 'managed:openai', 'openai', 'sk-openai-before')

      upgrade()

      expect(ownership(db)).toEqual([
        { id: 'managed:anthropic', ref: 'managed:anthropic', owner: member },
        { id: 'managed:openai', ref: 'managed:openai', owner: member },
      ])
      // Exactly as before: the member's spawn on their machine carries the key.
      const accounts = new AccountsRepository(stageASeam(db))
      const env = await resolveAccountEnv(
        {
          accounts,
          machines: { custodian: async () => asUserId(member), getMachine: async () => undefined },
        },
        asAccountId('managed:anthropic'),
        { ownerUserId: asUserId(member), machineId: asMachineId('host') },
      )
      expect(env).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant-before' } })
      // A reconnect replaces the migrated row rather than adding a second one.
      await accounts.upsert({
        id: asAccountId('managed:anthropic'),
        ownerUserId: asUserId(member),
        provider: 'anthropic',
        kind: 'api-key',
        credential: 'sk-ant-after',
        identity: 'mask',
        scope: 'role',
        createdAt: 2,
      })
      expect(
        (await accounts.listFor(asUserId(member))).map((row) => [row.id, row.credential]).sort(),
      ).toEqual([
        ['managed:anthropic', 'sk-ant-after'],
        ['managed:openai', 'sk-openai-before'],
      ])
      expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(2)
    } finally {
      db.close()
    }
  })

  it('on a multi-member database every connection goes to the earliest active admin', () => {
    const { db, upgrade } = rewound()
    try {
      const original = firstAdmin(db)
      // An even earlier admin who is disabled does not get them.
      addMember(
        db,
        'mem_old_admin',
        'admin',
        '2000-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
      addMember(db, 'mem_bob', 'member', '2000-01-02T00:00:00.000Z')
      addMember(db, 'mem_later_admin', 'admin', '2999-01-01T00:00:00.000Z')
      seedConnection(db, 'managed:anthropic', 'anthropic', 'sk-ant')

      upgrade()

      expect(ownership(db)).toEqual([
        { id: 'managed:anthropic', ref: 'managed:anthropic', owner: original },
      ])
    } finally {
      db.close()
    }
  })
})
