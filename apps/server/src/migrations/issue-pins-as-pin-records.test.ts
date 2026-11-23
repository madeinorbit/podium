/**
 * THE UPGRADE TEST for `issue-pins-as-pin-records` (POD-6692).
 *
 * Each person's issue pin moves from `issue_user_state.pinned_at` into `pins`
 * (kind 'issue', the issue id) with its original time, the column is dropped,
 * and a row that held only a pin goes, because a row of nulls is never stored.
 * Seeded on a database rewound to the migration before this one, so it is an
 * upgrade and not a first boot.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'issue-pins-as-pin-records'

function rewound(): { db: SqlDatabase; upgrade(): void } {
  const db = openDatabase(':memory:')
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  return { db, upgrade: () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1)) }
}

const marker = (
  db: SqlDatabase,
  user: string,
  issue: string,
  m: { readAt?: string; pinnedAt?: string; joinedAt?: string },
) =>
  db
    .prepare(
      `INSERT INTO issue_user_state (user_id, issue_id, read_at, pinned_at, joined_at, joined_via)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user,
      issue,
      m.readAt ?? null,
      m.pinnedAt ?? null,
      m.joinedAt ?? null,
      m.joinedAt ? 'start' : null,
    )

const columns = (db: SqlDatabase) =>
  (db.prepare("SELECT name FROM pragma_table_info('issue_user_state')").all() as { name: string }[])
    .map((c) => c.name)

describe(`migration ${MIGRATION}`, () => {
  it('moves every issue pin into pins with its time, drops the column and the emptied rows', () => {
    const { db, upgrade } = rewound()
    try {
      // Alice: read and pinned t1, pinned only t2, read only t3. Bob: pinned t1 too.
      marker(db, 'alice', 't1', { readAt: '2026-10-01', pinnedAt: '2026-10-02' })
      marker(db, 'alice', 't2', { pinnedAt: '2026-10-03' })
      marker(db, 'alice', 't3', { readAt: '2026-10-04' })
      marker(db, 'bob', 't1', { pinnedAt: '2026-10-05', joinedAt: '2026-10-01' })
      // A pin already a record keeps its own row and time.
      db.prepare(
        `INSERT INTO pins (user_id, kind, id, pinned_at) VALUES ('alice', 'issue', 't2', '2026-09-30')`,
      ).run()
      // Other kinds of pins are not touched.
      db.prepare(
        `INSERT INTO pins (user_id, kind, id, pinned_at) VALUES ('alice', 'repo', '/r', '2026-09-01')`,
      ).run()
      expect(columns(db)).toContain('pinned_at')

      upgrade()

      expect(columns(db)).not.toContain('pinned_at')
      expect(
        db.prepare('SELECT user_id, kind, id, pinned_at FROM pins ORDER BY user_id, kind, id').all(),
      ).toEqual([
        { user_id: 'alice', kind: 'issue', id: 't1', pinned_at: '2026-10-02' },
        { user_id: 'alice', kind: 'issue', id: 't2', pinned_at: '2026-09-30' },
        { user_id: 'alice', kind: 'repo', id: '/r', pinned_at: '2026-09-01' },
        { user_id: 'bob', kind: 'issue', id: 't1', pinned_at: '2026-10-05' },
      ])
      // t2 held only Alice's pin: its row is gone. The others keep their markers.
      expect(
        db
          .prepare(
            'SELECT user_id, issue_id, read_at, joined_at FROM issue_user_state ORDER BY user_id, issue_id',
          )
          .all(),
      ).toEqual([
        { user_id: 'alice', issue_id: 't1', read_at: '2026-10-01', joined_at: null },
        { user_id: 'alice', issue_id: 't3', read_at: '2026-10-04', joined_at: null },
        { user_id: 'bob', issue_id: 't1', read_at: null, joined_at: '2026-10-01' },
      ])
    } finally {
      db.close()
    }
  })
})
