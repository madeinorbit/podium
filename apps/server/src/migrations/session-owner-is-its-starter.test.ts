/**
 * THE UPGRADE TEST for `session-owner-is-its-starter` (POD-6283).
 *
 * Before this release a session started on someone else's task was stored with
 * the task owner as its owner; only `created_by_on_behalf_of` named the starter.
 * The migration hands such rows to their starter on a multi-member instance, and
 * leaves a one-member instance, and every row it cannot vouch for, exactly as
 * it was. Each case below is a row the migration must or must not touch, seeded
 * on a database rewound to the migration before this one (an upgrade, not a
 * first boot) and asserted before and after.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'session-owner-is-its-starter'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

const addMember = (db: SqlDatabase, id: string, disabledAt: string | null = null) =>
  db
    .prepare('INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'member', '2026-10-01T00:00:00.000Z', disabledAt)

const seedSession = (db: SqlDatabase, id: string, owner: string, onBehalfOf: string | null) =>
  db
    .prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
         created_at, last_active_at, machine_id, owner_user_id,
         created_by_actor_kind, created_by_actor_id, created_by_on_behalf_of)
       VALUES (?, 'claude-code', '/p', ?, 'spawn', 'exited', ?, '2026-10-01T00:00:00.000Z',
         '2026-10-02T00:00:00.000Z', 'local', ?, ?, ?, ?)`,
    )
    .run(id, `t-${id}`, `l-${id}`, owner, onBehalfOf ? 'user' : null, onBehalfOf, onBehalfOf)

const ownerOf = (db: SqlDatabase, id: string) =>
  (db.prepare('SELECT owner_user_id AS owner FROM sessions WHERE id = ?').get(id) as { owner: string })
    .owner

/** The instance's existing first admin: the one member every database has. */
const firstAdmin = (db: SqlDatabase) =>
  (db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
    id: string
  }).id

describe(`migration ${MIGRATION}`, () => {
  it('hands a session started on another member’s task to its starter, and nothing else', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      addMember(db, 'mem_bob')
      addMember(db, 'mem_carol', '2026-10-15T00:00:00.000Z')
      seedSession(db, 'bob-on-alice-task', alice, 'mem_bob')
      seedSession(db, 'alice-own', alice, alice)
      seedSession(db, 'before-attribution', alice, null)
      seedSession(db, 'started-by-disabled', alice, 'mem_carol')
      seedSession(db, 'started-by-removed', alice, 'mem_gone')
      expect(ownerOf(db, 'bob-on-alice-task')).toBe(alice)

      upgrade()

      expect(ownerOf(db, 'bob-on-alice-task')).toBe('mem_bob')
      expect(ownerOf(db, 'alice-own')).toBe(alice)
      expect(ownerOf(db, 'before-attribution')).toBe(alice)
      expect(ownerOf(db, 'started-by-disabled')).toBe(alice)
      expect(ownerOf(db, 'started-by-removed')).toBe(alice)
    } finally {
      db.close()
    }
  })

  it('leaves a one-member instance exactly as it was', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1)
      seedSession(db, 'own', alice, alice)
      seedSession(db, 'foreign-attribution', alice, 'mem_elsewhere')
      const before = db.prepare('SELECT * FROM sessions ORDER BY id').all()

      upgrade()

      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(before)
    } finally {
      db.close()
    }
  })
})
