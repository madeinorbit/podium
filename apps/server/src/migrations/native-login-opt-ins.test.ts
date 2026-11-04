/**
 * THE UPGRADE TEST for `native-login-opt-ins` (POD-6301; design §2.5, §4.6, D11).
 *
 * Before this release Podium copied a member's native CLI logins between their
 * own machines with no choice. The D11 checkbox starts unticked, so an upgrade
 * ticks it for every native login already observed on a machine in someone's
 * custody, for that custodian: an existing install keeps copying exactly as
 * before. Seeded on a database rewound to the migration before this one (an
 * upgrade, not a first boot).
 */

import { asUserId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { AccountsRepository } from '../store/accounts'
import { stageASeam } from '../test-support/stage-a-seam'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'native-login-opt-ins'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

type Agent = { kind: string; state: 'in' | 'out' | 'unknown'; fingerprint?: string }

/** A machine as the previous release stored it, with its reported inventory. */
const seedMachine = (
  db: SqlDatabase,
  id: string,
  agents: Agent[] | 'not-json',
  revokedAt: string | null = null,
) =>
  db
    .prepare(
      `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, inventory_json, revoked_at)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', ?, ?)`,
    )
    .run(
      id,
      id,
      id,
      `${id}-token`,
      agents === 'not-json'
        ? '{not json'
        : JSON.stringify({
            os: 'linux',
            arch: 'x64',
            tools: [],
            agents: agents.map((agent) => ({
              kind: agent.kind,
              installed: true,
              login: {
                state: agent.state,
                ...(agent.fingerprint ? { identity: { fingerprint: agent.fingerprint } } : {}),
              },
            })),
          }),
      revokedAt,
    )

const grant = (db: SqlDatabase, machine: string, grantee: string, verb: 'manage' | 'use') =>
  db
    .prepare(
      `INSERT INTO grants (resource_kind, resource_id, grantee, verb, custody, owner, visibility, created_at, actor_kind)
       VALUES ('machine', ?, ?, ?, ?, ?, 'private', '2026-01-01', 'system')`,
    )
    .run(machine, grantee, verb, verb === 'manage' ? 1 : 0, grantee)

const optIns = (db: SqlDatabase) =>
  db
    .prepare(
      `SELECT owner_user_id AS owner, harness, fingerprint, enabled
       FROM native_login_opt_ins ORDER BY owner_user_id, harness, fingerprint`,
    )
    .all()

const firstAdmin = (db: SqlDatabase) =>
  (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: string
    }
  ).id

describe(`migration ${MIGRATION}`, () => {
  it('on a one-member database every login already on their machines stays ticked', async () => {
    const { db, upgrade } = rewound()
    try {
      const member = firstAdmin(db)
      seedMachine(db, 'laptop', [
        { kind: 'codex', state: 'in', fingerprint: 'codex-me' },
        { kind: 'claude-code', state: 'in', fingerprint: 'claude-me' },
      ])
      seedMachine(db, 'vps', [{ kind: 'codex', state: 'in', fingerprint: 'codex-me' }])
      grant(db, 'laptop', member, 'manage')
      grant(db, 'vps', member, 'manage')

      upgrade()

      expect(optIns(db)).toEqual([
        { owner: member, harness: 'claude-code', fingerprint: 'claude-me', enabled: 1 },
        { owner: member, harness: 'codex', fingerprint: 'codex-me', enabled: 1 },
      ])
      // The repository reads them back as ticked, as propagation will.
      const accounts = new AccountsRepository(stageASeam(db))
      expect((await accounts.optInsFor(asUserId(member))).every((row) => row.enabled)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('ticks a login only for the custodian of the machine it is on', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      db.prepare(
        "INSERT INTO users (id, display_name, role, created_at) VALUES ('mem_bob', 'Bob', 'member', '2026-02-01')",
      ).run()
      seedMachine(db, 'alice-box', [{ kind: 'codex', state: 'in', fingerprint: 'codex-alice' }])
      seedMachine(db, 'bob-box', [
        { kind: 'claude-code', state: 'in', fingerprint: 'claude-bob' },
        // Logged out, or with no identity: nothing to tick.
        { kind: 'codex', state: 'out' },
        { kind: 'grok', state: 'in' },
      ])
      // Unowned, revoked, or unreadable: nobody's login.
      seedMachine(db, 'unowned', [{ kind: 'codex', state: 'in', fingerprint: 'codex-nobody' }])
      seedMachine(
        db,
        'gone',
        [{ kind: 'codex', state: 'in', fingerprint: 'codex-gone' }],
        '2026-03-01',
      )
      seedMachine(db, 'garbled', 'not-json')
      grant(db, 'alice-box', alice, 'manage')
      grant(db, 'bob-box', 'mem_bob', 'manage')
      grant(db, 'gone', alice, 'manage')
      grant(db, 'garbled', alice, 'manage')
      // Alice may use Bob's machine: its login is still Bob's, not hers.
      grant(db, 'bob-box', alice, 'use')

      upgrade()

      expect(optIns(db)).toEqual([
        { owner: alice, harness: 'codex', fingerprint: 'codex-alice', enabled: 1 },
        { owner: 'mem_bob', harness: 'claude-code', fingerprint: 'claude-bob', enabled: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it('a fresh install ticks nothing', () => {
    const db = openDatabase(':memory:')
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      expect(optIns(db)).toEqual([])
    } finally {
      db.close()
    }
  })
})
