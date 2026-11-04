/**
 * THE UPGRADE TEST for `task-text-revisions` (POD-6289).
 *
 * Expand-only: a new history table and three nullable edit columns on
 * `issue_comments`. An upgraded database keeps every task and comment exactly
 * as it was, starts with no history rows (the first edit of each field records
 * the old text as its baseline, see `two-member-edit-history.test.ts`), and
 * its comments read as never edited. Seeded on a database rewound to the
 * migration before this one, so it is an upgrade and not a first boot.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'task-text-revisions'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

const firstAdmin = (db: SqlDatabase) =>
  (
    db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as {
      id: string
    }
  ).id

describe(`migration ${MIGRATION}`, () => {
  it('keeps tasks and comments as they were; comments read as never edited; no history yet', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      db.prepare(
        `INSERT INTO issues
          (id, owner_user_id, created_by_actor, created_by_on_behalf_of, repo_path, seq, title,
           description, brief, stage, default_agent, created_at, updated_at, revision)
         VALUES ('t1', ?, ?, ?, '/r', 1, 'old task', 'old description', 'old brief',
           'backlog', 'claude-code', '2026-10-01', '2026-10-01', 4)`,
      ).run(alice, alice, alice)
      db.prepare(
        `INSERT INTO issue_comments (id, issue_id, author, body, created_at, actor, on_behalf_of)
         VALUES ('c1', 't1', 'Alice', 'an old comment', '2026-10-01', ?, ?),
                ('c2', 't1', 'someone', 'from before attribution', '2026-09-01', NULL, NULL)`,
      ).run(alice, alice)
      const before = db.prepare('SELECT * FROM issues WHERE id = ?').get('t1')

      upgrade()

      expect(db.prepare('SELECT * FROM issues WHERE id = ?').get('t1')).toEqual(before)
      expect(
        db
          .prepare(
            `SELECT id, author, body, actor, on_behalf_of AS onBehalfOf, edited_at AS editedAt,
               edited_by AS editedBy, edited_on_behalf_of AS editedOnBehalfOf
             FROM issue_comments ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 'c1',
          author: 'Alice',
          body: 'an old comment',
          actor: alice,
          onBehalfOf: alice,
          editedAt: null,
          editedBy: null,
          editedOnBehalfOf: null,
        },
        {
          id: 'c2',
          author: 'someone',
          body: 'from before attribution',
          actor: null,
          onBehalfOf: null,
          editedAt: null,
          editedBy: null,
          editedOnBehalfOf: null,
        },
      ])
      expect(db.prepare('SELECT COUNT(*) AS n FROM issue_text_revisions').get()).toEqual({ n: 0 })

      // The history refuses a field or source it does not know, and goes with its task.
      const append = db.prepare(
        `INSERT INTO issue_text_revisions (issue_id, field, body, source, created_at)
         VALUES ('t1', ?, 'x', ?, '2026-11-04')`,
      )
      expect(() => append.run('title', 'edit')).toThrow(/CHECK/)
      expect(() => append.run('brief', 'rewrite')).toThrow(/CHECK/)
      append.run('brief', 'baseline')
      db.exec('PRAGMA foreign_keys = ON')
      db.prepare('DELETE FROM issues WHERE id = ?').run('t1')
      expect(db.prepare('SELECT COUNT(*) AS n FROM issue_text_revisions').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})
