/**
 * DESIGN AND NOTES FOLD INTO THE BRIEF (POD-6101, flight deck v6 D8).
 *
 * Issues keep description, brief and acceptance. The migration appends `design`
 * and `notes` to `brief`, each under its own heading, then drops both columns.
 * These tests run it on a database created at the previous schema:
 *
 *  - text lands in the brief in a fixed order (old brief, Design, Notes) and
 *    no text is lost;
 *  - blank values add nothing, and an untouched row keeps its revision;
 *  - activity notes (the state panel) and acceptance are left alone;
 *  - both columns are gone, and the feed epoch moves so cached issue payloads
 *    rebootstrap.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const CUT = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_fold-design-notes-into-brief'))

function insertIssue(
  db: SqlDatabase,
  id: string,
  seq: number,
  text: { brief?: string; design?: string; notes?: string },
): void {
  db.prepare(
    `INSERT INTO issues
      (id, owner_user_id, created_by_actor, repo_path, seq, title, stage, default_agent,
       brief, design, notes, acceptance, activity_notes, created_at, updated_at, revision)
     VALUES (?, 'user:a', 'user:a', '/r', ?, ?, 'backlog', 'claude-code', ?, ?, ?,
       'It works.', 'Working on it.', '2026-01-01', '2026-01-01', 7)`,
  ).run(id, seq, `Issue ${id}`, text.brief ?? null, text.design ?? null, text.notes ?? null)
}

const row = (db: SqlDatabase, id: string) =>
  db
    .prepare('SELECT brief, acceptance, activity_notes, revision FROM issues WHERE id = ?')
    .get(id) as {
    brief: string | null
    acceptance: string
    activity_notes: string
    revision: number
  }

describe('fold design and notes into brief migration', () => {
  let db: SqlDatabase

  beforeEach(() => {
    expect(CUT).toBeGreaterThan(0)
    db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, CUT))
    db.prepare(
      'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?)',
    ).run('f', 'before', 1)
    insertIssue(db, 'all', 1, {
      brief: 'Do the thing.',
      design: 'Use a table.',
      notes: 'Seen twice.',
    })
    insertIssue(db, 'design-only', 2, { design: 'Use a table.' })
    insertIssue(db, 'notes-only', 3, { brief: '  ', notes: 'Seen twice.' })
    insertIssue(db, 'brief-only', 4, { brief: 'Do the thing.' })
    insertIssue(db, 'blank', 5, { design: ' ', notes: '' })
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, CUT + 1))
  })

  afterEach(() => db.close())

  it('appends design then notes to the brief under headings', () => {
    expect(row(db, 'all').brief).toBe(
      'Do the thing.\n\n## Design\n\nUse a table.\n\n## Notes\n\nSeen twice.',
    )
    expect(row(db, 'design-only').brief).toBe('## Design\n\nUse a table.')
    expect(row(db, 'notes-only').brief).toBe('## Notes\n\nSeen twice.')
  })

  it('changes nothing on a row with no design or notes text', () => {
    expect(row(db, 'brief-only')).toEqual({
      brief: 'Do the thing.',
      acceptance: 'It works.',
      activity_notes: 'Working on it.',
      revision: 7,
    })
    expect(row(db, 'blank')).toMatchObject({ brief: null, revision: 7 })
  })

  it('gives a changed row a new revision and leaves acceptance and activity notes alone', () => {
    expect(row(db, 'design-only').revision).toBe(8)
    expect(row(db, 'all')).toMatchObject({
      acceptance: 'It works.',
      activity_notes: 'Working on it.',
    })
    expect(row(db, 'all').revision).toBeGreaterThan(7)
  })

  it('drops both columns', () => {
    const columns = (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).not.toContain('design')
    expect(columns).not.toContain('notes')
    expect(columns).toEqual(expect.arrayContaining(['brief', 'acceptance', 'activity_notes']))
  })

  it('moves the feed epoch so cached issue payloads rebootstrap', () => {
    const identity = db.prepare('SELECT feed_id, epoch FROM feed_identity').get() as {
      feed_id: string
      epoch: string
    }
    expect(identity.feed_id).toBe('f')
    expect(identity.epoch).toMatch(/^fold-design-notes-into-brief-/)
  })
})
