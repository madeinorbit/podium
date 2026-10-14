/**
 * ISSUE TYPES NARROW, LABELS GET A TABLE (POD-6106, flight deck v6 D2/D3).
 *
 * The migration rebuilds `issues` (its type CHECK becomes task | phase |
 * decision) and `issue_labels` (re-keyed onto the new `labels` table). These
 * tests run it on a database created at the previous schema, holding an issue
 * of every type that schema admitted and a set of free-text labels:
 *
 *  - every retired type maps as decided, and nothing else on the row changes;
 *  - every old label string survives as a link, case variants collapse onto
 *    one label, and the retired types bug/feature/chore/story/spike become a
 *    label of the same name (merging with an existing label of that name);
 *  - child rows hanging off `issues` (deps here) survive the rebuild;
 *  - the new CHECK refuses a retired type, and label names are unique ignoring
 *    case;
 *  - the feed epoch moves, so cached issue payloads rebootstrap.
 */

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { withMigrationForeignKeysDisabled } from './store-lifecycle'

const CUT = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_issue-types-and-labels'))

/** Every type the previous CHECK admitted, written out rather than read from
 *  the model, which no longer knows them. */
const PREVIOUS_TYPES = [
  'task',
  'bug',
  'feature',
  'chore',
  'epic',
  'decision',
  'spike',
  'story',
  'milestone',
  'automation',
] as const

const EXPECTED_TYPE: Record<(typeof PREVIOUS_TYPES)[number], string> = {
  task: 'task',
  bug: 'task',
  feature: 'task',
  chore: 'task',
  epic: 'task',
  decision: 'decision',
  spike: 'task',
  story: 'task',
  milestone: 'phase',
  automation: 'task',
}

function insertIssue(db: SqlDatabase, id: string, seq: number, type: string): void {
  db.prepare(
    `INSERT INTO issues
      (id, owner_user_id, created_by_actor, repo_path, seq, title, stage, default_agent,
       type, created_at, updated_at, revision)
     VALUES (?, 'user:a', 'user:a', '/r', ?, ?, 'backlog', 'claude-code', ?,
       '2026-01-01', '2026-01-01', 7)`,
  ).run(id, seq, `Issue ${type}`, type)
}

function labelsOf(db: SqlDatabase, id: string): string[] {
  return (
    db
      .prepare(
        `SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id
         WHERE il.issue_id = ? ORDER BY l.name`,
      )
      .all(id) as { name: string }[]
  ).map((r) => r.name)
}

describe('issue types and labels migration', () => {
  let db: SqlDatabase

  beforeEach(() => {
    expect(CUT).toBeGreaterThan(0)
    db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, CUT))
    db.prepare(
      'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?)',
    ).run('f', 'before', 1)
    PREVIOUS_TYPES.forEach((type, index) => insertIssue(db, `iss_${type}`, index + 1, type))
    const label = db.prepare('INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)')
    label.run('iss_task', 'backend')
    label.run('iss_task', 'Backend')
    label.run('iss_epic', 'backend')
    label.run('iss_bug', 'ui')
    // A spike that already carries the label its type turns into.
    label.run('iss_spike', 'spike')
    label.run('iss_chore', 'CHORE')
    db.prepare("INSERT INTO issue_deps (from_id, to_id, type) VALUES (?, ?, 'blocks')").run(
      'iss_task',
      'iss_epic',
    )
    db.exec('PRAGMA foreign_keys = ON')
    withMigrationForeignKeysDisabled(db, () =>
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, CUT + 1)),
    )
  })

  afterEach(() => db.close())

  it('maps every retired type and leaves the rest of the row alone', () => {
    for (const type of PREVIOUS_TYPES) {
      const row = db
        .prepare('SELECT type, title, revision FROM issues WHERE id = ?')
        .get(`iss_${type}`) as { type: string; title: string; revision: number }
      expect(row).toEqual({ type: EXPECTED_TYPE[type], title: `Issue ${type}`, revision: 7 })
    }
  })

  it('keeps every label as a link and turns label-like types into labels', () => {
    expect(
      (db.prepare('SELECT name FROM labels ORDER BY lower(name)').all() as { name: string }[]).map(
        (r) => r.name,
      ),
    ).toEqual(['Backend', 'bug', 'CHORE', 'feature', 'spike', 'story', 'ui'])
    expect(labelsOf(db, 'iss_task')).toEqual(['Backend'])
    expect(labelsOf(db, 'iss_epic')).toEqual(['Backend'])
    expect(labelsOf(db, 'iss_bug')).toEqual(['bug', 'ui'])
    expect(labelsOf(db, 'iss_spike')).toEqual(['spike'])
    expect(labelsOf(db, 'iss_chore')).toEqual(['CHORE'])
    expect(labelsOf(db, 'iss_feature')).toEqual(['feature'])
    expect(labelsOf(db, 'iss_story')).toEqual(['story'])
    expect(labelsOf(db, 'iss_milestone')).toEqual([])
    expect(labelsOf(db, 'iss_automation')).toEqual([])
  })

  it('keeps child rows of the rebuilt issues table', () => {
    expect(db.prepare('SELECT from_id, to_id FROM issue_deps').all()).toEqual([
      { from_id: 'iss_task', to_id: 'iss_epic' },
    ])
  })

  it('refuses a retired type and a case-variant label name', () => {
    expect(() => insertIssue(db, 'iss_new_bug', 100, 'bug')).toThrow(/CHECK/)
    insertIssue(db, 'iss_new_phase', 101, 'phase')
    expect(() =>
      db.prepare("INSERT INTO labels (name, created_at) VALUES ('UI', 't')").run(),
    ).toThrow(/UNIQUE/)
  })

  it('moves the feed epoch so cached issue payloads rebootstrap', () => {
    const identity = db.prepare('SELECT feed_id, epoch FROM feed_identity').get() as {
      feed_id: string
      epoch: string
    }
    expect(identity.feed_id).toBe('f')
    expect(identity.epoch).toMatch(/^issue-types-and-labels-/)
  })
})
