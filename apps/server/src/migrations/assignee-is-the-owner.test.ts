/**
 * THE UPGRADE TEST for `assignee-is-the-owner` (POD-6287).
 *
 * Before this release `issues.assignee` was free text beside the owner: agent
 * starts wrote `agent:<kind>`, `claim --assignee me` wrote `me`, and a member id
 * could be typed in. The migration makes an active member's id the owner and
 * keeps everything else as a legacy display label, with nothing lost. Each case
 * is a row seeded on a database rewound to the migration before this one (an
 * upgrade, not a first boot) and asserted after it.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'assignee-is-the-owner'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

const addMember = (db: SqlDatabase, id: string, disabledAt: string | null = null) =>
  db
    .prepare(
      'INSERT INTO users (id, display_name, role, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, id, 'member', '2026-10-01T00:00:00.000Z', disabledAt)

let seq = 0
const seedTask = (db: SqlDatabase, id: string, owner: string, assignee: string | null) =>
  db
    .prepare(
      `INSERT INTO issues
        (id, owner_user_id, created_by_actor, created_by_on_behalf_of, repo_path, seq, title,
         stage, default_agent, assignee, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '/r', ?, ?, 'backlog', 'claude-code', ?, '2026-10-01', '2026-10-01', 3)`,
    )
    .run(id, owner, owner, owner, ++seq, id, assignee)

const row = (db: SqlDatabase, id: string) =>
  db
    .prepare(
      `SELECT owner_user_id AS owner, assignee, created_by_actor AS actor,
         created_by_on_behalf_of AS onBehalfOf, revision, closed_by_user_id AS closedBy
       FROM issues WHERE id = ?`,
    )
    .get(id) as {
    owner: string
    assignee: string | null
    actor: string
    onBehalfOf: string
    revision: number
    closedBy: string | null
  }

/** The instance's existing first admin: the one member every database has. */
const firstAdmin = (db: SqlDatabase) =>
  (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: string
    }
  ).id

describe(`migration ${MIGRATION}`, () => {
  it('makes an active member named as assignee the owner, and keeps every other value as a label', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      addMember(db, 'mem_bob')
      addMember(db, 'mem_carol', '2026-10-15T00:00:00.000Z')
      seedTask(db, 'assigned-to-bob', alice, 'mem_bob')
      seedTask(db, 'assigned-to-owner', alice, alice)
      seedTask(db, 'agent-label', alice, 'agent:codex')
      seedTask(db, 'me', alice, 'me')
      seedTask(db, 'a-name', alice, 'Michael Wirth')
      seedTask(db, 'disabled-member', alice, 'mem_carol')
      seedTask(db, 'removed-member', alice, 'mem_gone')
      seedTask(db, 'unassigned', alice, null)

      upgrade()

      // Bob answers for the task now; who created it does not change.
      expect(row(db, 'assigned-to-bob')).toMatchObject({
        owner: 'mem_bob',
        assignee: null,
        actor: alice,
        onBehalfOf: alice,
      })
      // Already the owner: the label said nothing more, and is cleared.
      expect(row(db, 'assigned-to-owner')).toMatchObject({ owner: alice, assignee: null })
      // No accountable member named: the owner stays, the value stays as a label.
      for (const [id, label] of [
        ['agent-label', 'agent:codex'],
        ['me', 'me'],
        ['a-name', 'Michael Wirth'],
        ['disabled-member', 'mem_carol'],
        ['removed-member', 'mem_gone'],
      ] as const) {
        expect(row(db, id), id).toMatchObject({ owner: alice, assignee: label })
      }
      expect(row(db, 'unassigned')).toMatchObject({ owner: alice, assignee: null })
      // The new column starts empty everywhere.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM issues WHERE closed_by_user_id IS NOT NULL').get(),
      ).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('moves no owner on a one-member instance and keeps its labels', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1)
      seedTask(db, 'label', alice, 'agent:claude-code')
      seedTask(db, 'me', alice, 'me')
      seedTask(db, 'self', alice, alice)
      seedTask(db, 'none', alice, null)

      upgrade()

      expect(db.prepare('SELECT DISTINCT owner_user_id AS owner FROM issues').all()).toEqual([
        { owner: alice },
      ])
      expect(row(db, 'label').assignee).toBe('agent:claude-code')
      expect(row(db, 'me').assignee).toBe('me')
      expect(row(db, 'self').assignee).toBeNull()
      expect(row(db, 'none').assignee).toBeNull()
    } finally {
      db.close()
    }
  })
})
