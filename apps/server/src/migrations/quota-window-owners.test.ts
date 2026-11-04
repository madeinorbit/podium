/**
 * THE UPGRADE TEST for `quota-window-owners` (POD-6300).
 *
 * A quota window row recorded before this release names no machine, so the
 * migration gives it to the earliest active admin, the same rule as provider
 * connections. On a one-member instance that is the member, who therefore sees
 * every row they saw before. Seeded on a database rewound to the migration
 * before this one (an upgrade, not a first boot).
 */

import { asUserId } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { QuotaHistoryRepository } from '../store/quota-history'
import { stageASeam } from '../test-support/stage-a-seam'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'quota-window-owners'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

/** A window as the previous release wrote it: no owner. */
const seedWindow = (db: SqlDatabase, accountKey: string, resetsAtMs: number) =>
  db
    .prepare(
      `INSERT INTO quota_windows (account_key, agent, window_key, resets_at_bucket, label,
         resets_at_ms, window_minutes, first_seen_ms, last_seen_ms, first_percent,
         peak_percent, last_percent, sample_count, partial, source, trail_json)
       VALUES (?, 'claude-code', 'five_hour', ?, '5h', ?, 300, ?, ?, 10, 40, 40, 3, 0, 'live', '[]')`,
    )
    .run(
      accountKey,
      Math.floor(resetsAtMs / 60_000),
      resetsAtMs,
      resetsAtMs - 3_600_000,
      resetsAtMs - 60_000,
    )

const firstAdmin = (db: SqlDatabase) =>
  (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: string
    }
  ).id

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

const owners = (db: SqlDatabase) =>
  db
    .prepare(
      'SELECT account_key AS key, owner_user_id AS owner FROM quota_windows ORDER BY account_key',
    )
    .all()

describe(`migration ${MIGRATION}`, () => {
  it('on a one-member database the member keeps every window, logins long gone included', async () => {
    const { db, upgrade } = rewound()
    try {
      const member = firstAdmin(db)
      const resetsAt = Date.now() + 3_600_000
      seedWindow(db, 'claude-code::switched-away@example.com', resetsAt)
      seedWindow(db, 'codex::machine:removed-machine', resetsAt)

      upgrade()

      expect(owners(db)).toEqual([
        { key: 'claude-code::switched-away@example.com', owner: member },
        { key: 'codex::machine:removed-machine', owner: member },
      ])
      const history = new QuotaHistoryRepository(stageASeam(db))
      expect(
        (await history.listFor(asUserId(member), 0, Date.now())).map((row) => row.accountKey),
      ).toEqual(['claude-code::switched-away@example.com', 'codex::machine:removed-machine'])
    } finally {
      db.close()
    }
  })

  it('on a multi-member database pre-upgrade windows go to the earliest active admin only', async () => {
    const { db, upgrade } = rewound()
    try {
      const original = firstAdmin(db)
      addMember(
        db,
        'mem_old_admin',
        'admin',
        '2000-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      )
      addMember(db, 'mem_bob', 'member', '2000-01-02T00:00:00.000Z')
      seedWindow(db, 'claude-code::someone@example.com', Date.now() + 3_600_000)

      upgrade()

      expect(owners(db)).toEqual([{ key: 'claude-code::someone@example.com', owner: original }])
      const history = new QuotaHistoryRepository(stageASeam(db))
      expect(await history.listFor(asUserId('mem_bob'), 0, Date.now())).toEqual([])
    } finally {
      db.close()
    }
  })
})
