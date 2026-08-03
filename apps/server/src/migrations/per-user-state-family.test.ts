/**
 * THE LIVE-UPGRADE CONTINUITY TEST for the per-user-state re-key (POD-1076).
 *
 * A re-key is the highest-risk migration shape there is: one-shot, no down
 * migration, rollback is restoring a backup, and the failure mode is SILENT.
 * `drizzle-kit generate` emitted this migration's three CREATE TABLEs and five
 * DROP COLUMNs with nothing between them — applied as generated it destroys
 * every read marker, tuck-away and pin in the database without erroring, and
 * leaves three correctly-shaped empty tables behind. So the bar is not "it does
 * not error"; it is that the markers are observed to ARRIVE, by key.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE TRAP THIS AVOIDS, NAMED (POD-305, restated by POD-1075)
 * ---------------------------------------------------------------------------
 * A database with no `__drizzle_migrations` ledger is not an OLD database — it
 * is one drizzle has never seen, so the migrator replays the baseline and the
 * test silently exercises FIRST BOOT instead of an upgrade. Every test below
 * rewinds a REAL database by applying the manifest UP TO but not including this
 * migration, which writes a real ledger, and then asserts the PRE-STATE — the
 * five columns present, the three tables absent, the ledger there — before
 * touching anything.
 *
 * The trap specific to THIS migration is different from POD-1075's empty-table
 * one: an all-NULL fixture would pass whether the backfill ran or not, because
 * "no markers before, no rows after" is what a correct migration and a
 * data-destroying one both produce. So the fixture seeds markers with DISTINCT
 * values, and every assertion identifies rows BY KEY and checks the VALUE —
 * a migration that dropped everything and inserted one placeholder per entity
 * satisfies a count assertion perfectly.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const MIGRATION = 'per-user-state-family'
/** The literal the migration writes. Spelled out here for the same reason the
 *  migration spells it out: a migration is frozen history, so this test keeps
 *  asserting the id that was actually written even if the constant is renamed.
 *  `FIRST_ADMIN_USER_ID` is tied to this literal in
 *  `packages/model/src/identity/user.test.ts`. */
const FIRST_ADMIN = 'user:sole'

type Db = ReturnType<typeof openDatabase>

const cutIndex = () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.includes(MIGRATION))
  expect(cut).toBeGreaterThan(0)
  return cut
}

const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

const tableExists = (db: Db, name: string): boolean =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
  undefined

/** A real pre-migration database: every migration before this one applied, with
 *  a real drizzle ledger, and the pre-state asserted rather than assumed. */
function preMigrationDb(): Db {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cutIndex()))

  // THE PRE-STATE. If any of these were already true the test would be measuring
  // a database that had already been migrated — "silently exercising first boot"
  // in its other form.
  expect(columns(db, 'sessions')).toContain('read_at')
  expect(columns(db, 'issues')).toEqual(expect.arrayContaining(['read_at', 'tucked_at', 'pinned']))
  expect(columns(db, 'issue_messages')).toContain('read_at')
  expect(tableExists(db, 'session_user_state')).toBe(false)
  expect(tableExists(db, 'issue_user_state')).toBe(false)
  expect(tableExists(db, 'issue_message_user_state')).toBe(false)

  // …and the ledger really is there, so `runDrizzleMigrations` below applies the
  // remaining migrations rather than replaying the baseline onto a virgin file.
  expect(tableExists(db, '__drizzle_migrations')).toBe(true)
  return db
}

const seedSession = (db: Db, id: string, readAt: string | null) =>
  db
    .prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
         created_at, last_active_at, read_at)
       VALUES (?, 'shell', '/p', ?, 'user', 'exited', ?, '2026-01-01T00:00:00.000Z',
         '2026-01-02T00:00:00.000Z', ?)`,
    )
    .run(id, `t-${id}`, `l-${id}`, readAt)

const seedIssue = (
  db: Db,
  id: string,
  seq: number,
  markers: { readAt?: string | null; tuckedAt?: string | null; pinned?: number },
) =>
  db
    .prepare(
      `INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at,
         read_at, tucked_at, pinned)
       VALUES (?, '/repo', ?, ?, 'backlog', 'claude', '2026-01-01T00:00:00.000Z',
         '2026-01-03T00:00:00.000Z', ?, ?, ?)`,
    )
    .run(
      id,
      seq,
      `title-${id}`,
      markers.readAt ?? null,
      markers.tuckedAt ?? null,
      markers.pinned ?? 0,
    )

const seedIssueMessage = (db: Db, id: string, issueId: string, readAt: string | null) =>
  db
    .prepare(
      `INSERT INTO issue_messages (id, issue_id, from_author, body, created_at, read_at)
       VALUES (?, ?, 'someone', ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, issueId, `body-${id}`, readAt)

const READ_A = '2026-05-01T00:00:00.000Z'
const READ_B = '2026-05-02T00:00:00.000Z'
const TUCKED = '2026-05-03T00:00:00.000Z'
const MSG_READ = '2026-05-04T00:00:00.000Z'

describe('per-user-state re-key: every existing marker ARRIVES, owned by the first admin', () => {
  it('carries session read markers across, by session id and with the original instant', () => {
    const db = preMigrationDb()
    seedSession(db, 's-read-a', READ_A)
    seedSession(db, 's-read-b', READ_B)
    seedSession(db, 's-never-opened', null)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db
      .prepare('SELECT user_id, session_id, read_at FROM session_user_state ORDER BY session_id')
      .all() as { user_id: string; session_id: string; read_at: string | null }[]

    // BY KEY AND VALUE, not by count. A migration that dropped everything and
    // inserted one placeholder per session satisfies a count assertion; only the
    // id-to-instant pairing proves these are the SAME markers.
    expect(rows).toEqual([
      { user_id: FIRST_ADMIN, session_id: 's-read-a', read_at: READ_A },
      { user_id: FIRST_ADMIN, session_id: 's-read-b', read_at: READ_B },
    ])
    // The never-opened session gets NO row. Absence is how "never opened" is
    // spelled; a row of nulls would be a second spelling of one fact.
    expect(rows.some((r) => r.session_id === 's-never-opened')).toBe(false)
  })

  it('carries all three issue markers across on ONE row per (user, issue)', () => {
    const db = preMigrationDb()
    seedIssue(db, 'i-all', 1, { readAt: READ_A, tuckedAt: TUCKED, pinned: 1 })
    seedIssue(db, 'i-read-only', 2, { readAt: READ_B })
    seedIssue(db, 'i-pinned-only', 3, { pinned: 1 })
    seedIssue(db, 'i-untouched', 4, {})

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db
      .prepare(
        'SELECT user_id, issue_id, read_at, tucked_at, pinned_at FROM issue_user_state ORDER BY issue_id',
      )
      .all() as {
      user_id: string
      issue_id: string
      read_at: string | null
      tucked_at: string | null
      pinned_at: string | null
    }[]

    expect(rows.map((r) => r.issue_id)).toEqual(['i-all', 'i-pinned-only', 'i-read-only'])
    expect(rows.every((r) => r.user_id === FIRST_ADMIN)).toBe(true)

    const all = rows.find((r) => r.issue_id === 'i-all')
    expect(all?.read_at).toBe(READ_A)
    expect(all?.tucked_at).toBe(TUCKED)

    // The markers do not bleed into each other: a read-only issue must not come
    // out pinned, and a pinned-only issue must not come out read. A backfill that
    // wrote a constant into every column would pass the row-set assertion above.
    const readOnly = rows.find((r) => r.issue_id === 'i-read-only')
    expect(readOnly?.read_at).toBe(READ_B)
    expect(readOnly?.tucked_at).toBeNull()
    expect(readOnly?.pinned_at).toBeNull()

    const pinnedOnly = rows.find((r) => r.issue_id === 'i-pinned-only')
    expect(pinnedOnly?.read_at).toBeNull()
    expect(pinnedOnly?.tucked_at).toBeNull()
  })

  it('the 0/1 pin flag becomes a real timestamp, not a truthy string', () => {
    const db = preMigrationDb()
    seedIssue(db, 'i-pin', 1, { pinned: 1 })
    seedIssue(db, 'i-nopin', 2, { pinned: 0 })

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const pinnedAt = (
      db.prepare('SELECT pinned_at FROM issue_user_state WHERE issue_id = ?').get('i-pin') as
        | { pinned_at: string | null }
        | undefined
    )?.pinned_at
    // `CASE WHEN pinned = 1 THEN '1'` would satisfy "is not null" while writing a
    // value no `Date.parse` accepts, so the shape is asserted rather than truthiness.
    expect(pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // An unpinned issue with no other marker gets no row at all.
    expect(
      db.prepare('SELECT 1 FROM issue_user_state WHERE issue_id = ?').get('i-nopin'),
    ).toBeUndefined()
  })

  it('carries tracker-mail read markers across, by message id', () => {
    const db = preMigrationDb()
    seedIssue(db, 'i-host', 1, {})
    seedIssueMessage(db, 'm-read', 'i-host', MSG_READ)
    seedIssueMessage(db, 'm-unread', 'i-host', null)

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    const rows = db
      .prepare('SELECT user_id, issue_message_id, read_at FROM issue_message_user_state')
      .all() as { user_id: string; issue_message_id: string; read_at: string | null }[]
    expect(rows).toEqual([{ user_id: FIRST_ADMIN, issue_message_id: 'm-read', read_at: MSG_READ }])
  })

  it('the seeded markers are really there BEFORE the migration — the fixture is not empty', () => {
    // The counterfactual for every test above. An all-NULL fixture would satisfy
    // them vacuously: "no markers before, no rows after" is what a correct
    // migration and a data-destroying one both produce.
    const db = preMigrationDb()
    seedSession(db, 's-read-a', READ_A)
    seedIssue(db, 'i-all', 1, { readAt: READ_A, tuckedAt: TUCKED, pinned: 1 })
    seedIssueMessage(db, 'm-read', 'i-all', MSG_READ)

    expect(
      (
        db.prepare('SELECT read_at FROM sessions WHERE id = ?').get('s-read-a') as {
          read_at: string | null
        }
      ).read_at,
    ).toBe(READ_A)
    const issue = db
      .prepare('SELECT read_at, tucked_at, pinned FROM issues WHERE id = ?')
      .get('i-all') as { read_at: string; tucked_at: string; pinned: number }
    expect(issue).toEqual({ read_at: READ_A, tucked_at: TUCKED, pinned: 1 })
    expect(
      (
        db.prepare('SELECT read_at FROM issue_messages WHERE id = ?').get('m-read') as {
          read_at: string
        }
      ).read_at,
    ).toBe(MSG_READ)
  })

  it('the shared entity rows keep everything else and lose exactly the five columns', () => {
    const db = preMigrationDb()
    seedSession(db, 's-1', READ_A)
    seedIssue(db, 'i-1', 1, { readAt: READ_A, tuckedAt: TUCKED, pinned: 1 })
    const before = {
      session: columns(db, 'sessions').filter((c) => c !== 'read_at'),
      issue: columns(db, 'issues').filter(
        (c) => c !== 'read_at' && c !== 'tucked_at' && c !== 'pinned',
      ),
      message: columns(db, 'issue_messages').filter((c) => c !== 'read_at'),
    }

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)

    // Exactly the five columns are gone and NOTHING else is: a column-drop
    // migration that rebuilt a table and lost an unrelated column would still
    // satisfy every marker assertion above.
    //
    // Compared as SETS, not sequences. A later migration in the chain rebuilds
    // `sessions` again (POD-318 drops the `machine_id` default), and a rebuild
    // re-emits the schema's declaration order rather than appending — so column
    // ORDER is not a property this suite can pin, while column MEMBERSHIP, which is
    // what "lost an unrelated column" means, still is.
    const sorted = (xs: string[]) => [...xs].sort()
    expect(sorted(columns(db, 'sessions'))).toEqual(
      sorted([
        ...before.session,
        'owner_user_id',
        // POD-1516's attribution pair — added by a later migration in the same
        // chain, so it is an ADDITION to record here, not a column this
        // migration lost.
        'created_by_actor_kind',
        'created_by_actor_id',
        'created_by_on_behalf_of',
      ]),
    )
    expect(sorted(columns(db, 'issues'))).toEqual(
      sorted([
        ...before.issue,
        'owner_user_id',
        'visibility',
        'created_by_actor',
        'created_by_on_behalf_of',
        'actor',
        'on_behalf_of',
      ]),
    )
    expect(sorted(columns(db, 'issue_messages'))).toEqual(
      sorted([...before.message, 'actor', 'on_behalf_of']),
    )

    // And the shared rows themselves survive with their own values.
    const s = db.prepare('SELECT title, last_active_at FROM sessions WHERE id = ?').get('s-1')
    expect(s).toEqual({ title: 't-s-1', last_active_at: '2026-01-02T00:00:00.000Z' })
    const i = db.prepare('SELECT title, stage FROM issues WHERE id = ?').get('i-1')
    expect(i).toEqual({ title: 'title-i-1', stage: 'backlog' })
  })

  it('a FRESH database boots straight into the new shape with no rows and no old columns', () => {
    // First boot is a different code path (the whole manifest at once) and must
    // not, for instance, fail on a backfill SELECT against a column the baseline
    // never created.
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(columns(db, 'sessions')).not.toContain('read_at')
    expect(columns(db, 'issues')).not.toContain('pinned')
    expect(tableExists(db, 'session_user_state')).toBe(true)
    expect(db.prepare('SELECT count(*) AS n FROM issue_user_state').get()).toEqual({ n: 0 })
  })
})
