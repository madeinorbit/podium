/**
 * THE UPGRADE TEST for `personal-task-records` (POD-6290).
 *
 * Expand-only: four nullable columns on `issue_user_state`, plus a backfill
 * that gives each existing task's assignee and human creator a 'start' record
 * dated the task's creation, and each member who owns a session on a task a
 * 'start' record dated that session. An upgraded one-member instance therefore starts
 * with every task in its member's personal set; markers already on a row stay
 * exactly as they were. Seeded on a database rewound to the migration before
 * this one, so it is an upgrade and not a first boot.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'personal-task-records'

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

const insertTask = (
  db: SqlDatabase,
  id: string,
  seq: number,
  owner: string | null,
  creator: string | null,
  createdAt: string,
) =>
  db
    .prepare(
      `INSERT INTO issues
        (id, owner_user_id, created_by_actor, created_by_on_behalf_of, repo_path, seq, title,
         stage, default_agent, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '/r', ?, 'old task', 'backlog', 'claude-code', ?, ?, 1)`,
    )
    .run(id, owner, creator, creator, seq, createdAt, createdAt)

const records = (db: SqlDatabase) =>
  db
    .prepare(
      `SELECT user_id AS userId, issue_id AS issueId, read_at AS readAt, tucked_at AS tuckedAt,
         pinned_at AS pinnedAt, joined_at AS joinedAt, joined_via AS joinedVia,
         assigned_at AS assignedAt, assigned_by AS assignedBy
       FROM issue_user_state ORDER BY issue_id, user_id`,
    )
    .all()

describe(`migration ${MIGRATION}`, () => {
  it('a one-member upgrade puts every existing task in its member’s set and keeps their markers', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      insertTask(db, 't1', 1, alice, alice, '2026-10-01')
      insertTask(db, 't2', 2, alice, alice, '2026-10-02')
      // Alice had already read and pinned t1: that row gains a record, keeps its markers.
      db.prepare(
        `INSERT INTO issue_user_state (user_id, issue_id, read_at, pinned_at)
         VALUES (?, 't1', '2026-10-05', '2026-10-06')`,
      ).run(alice)
      const before = db.prepare('SELECT * FROM issues ORDER BY id').all()

      upgrade()

      expect(db.prepare('SELECT * FROM issues ORDER BY id').all()).toEqual(before)
      expect(records(db)).toEqual([
        {
          userId: alice,
          issueId: 't1',
          readAt: '2026-10-05',
          tuckedAt: null,
          pinnedAt: '2026-10-06',
          joinedAt: '2026-10-01',
          joinedVia: 'start',
          assignedAt: null,
          assignedBy: null,
        },
        {
          userId: alice,
          issueId: 't2',
          readAt: null,
          tuckedAt: null,
          pinnedAt: null,
          joinedAt: '2026-10-02',
          joinedVia: 'start',
          assignedAt: null,
          assignedBy: null,
        },
      ])
    } finally {
      db.close()
    }
  })

  it('gives the assignee and the human creator a record each; names no non-member', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      db.prepare(
        `INSERT INTO users (id, display_name, role, created_at)
         VALUES ('mem_bob', 'Bob', 'member', '2026-09-01')`,
      ).run()
      // Bob created it; it was reassigned to Alice before the upgrade.
      insertTask(db, 't1', 1, alice, 'mem_bob', '2026-10-01')
      // A creator id that names no member (a removed one) gets nothing.
      insertTask(db, 't2', 2, alice, 'mem_gone', '2026-10-02')

      upgrade()

      expect(
        records(db).map((r) => {
          const row = r as { userId: string; issueId: string; joinedVia: string }
          return [row.issueId, row.userId, row.joinedVia]
        }),
      ).toEqual([
        ['t1', alice, 'start'],
        ['t1', 'mem_bob', 'start'],
        ['t2', alice, 'start'],
      ])
    } finally {
      db.close()
    }
  })

  it('gives each member who owns a session on a task a start record, once', () => {
    const { db, upgrade } = rewound()
    try {
      const alice = firstAdmin(db)
      db.prepare(
        `INSERT INTO users (id, display_name, role, created_at)
         VALUES ('mem_bob', 'Bob', 'member', '2026-09-01')`,
      ).run()
      insertTask(db, 't1', 1, alice, alice, '2026-10-01')
      const session = db.prepare(
        `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
           created_at, last_active_at, machine_id, owner_user_id, issue_id)
         VALUES (?, 'claude-code', '/p', ?, 'spawn', 'exited', ?, ?, ?, 'local', ?, ?)`,
      )
      // Bob's two sessions on Alice's task: one record, dated the first.
      session.run('s1', 't-s1', 'l-s1', '2026-10-04', '2026-10-04', 'mem_bob', 't1')
      session.run('s2', 't-s2', 'l-s2', '2026-10-03', '2026-10-03', 'mem_bob', 't1')
      // A session on a task that no longer exists names nothing.
      session.run('s3', 't-s3', 'l-s3', '2026-10-03', '2026-10-03', 'mem_bob', 'gone')

      upgrade()

      const rows = () =>
        records(db).map((r) => {
          const row = r as { userId: string; issueId: string; joinedAt: string; joinedVia: string }
          return [row.issueId, row.userId, row.joinedAt, row.joinedVia]
        })
      expect(rows()).toEqual([
        ['t1', alice, '2026-10-01', 'start'],
        ['t1', 'mem_bob', '2026-10-03', 'start'],
      ])
      // Idempotent: the backfill run again writes nothing new and moves nothing.
      const migration = DRIZZLE_MIGRATIONS.find((m) => m.name.endsWith(MIGRATION))!
      let reran = 0
      for (const statement of migration.sql.split('--> statement-breakpoint')) {
        if (/^\s*(--.*\n)*\s*INSERT/.test(statement)) {
          db.exec(statement)
          reran += 1
        }
      }
      expect(reran).toBe(3)
      expect(rows()).toEqual([
        ['t1', alice, '2026-10-01', 'start'],
        ['t1', 'mem_bob', '2026-10-03', 'start'],
      ])
    } finally {
      db.close()
    }
  })
})
