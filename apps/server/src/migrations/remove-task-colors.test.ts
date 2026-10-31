import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

it('removes saved task colors while preserving issue records, hierarchy and label colors', () => {
  const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_remove-task-colors'))
  expect(cut).toBeGreaterThan(0)
  const db = openDatabase(':memory:')
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    db.prepare(`INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at)
      VALUES (1, 'feed', 'before', 1)`).run()
    for (const [seq, color] of [
      [1, 'violet'],
      [2, 'teal'],
      [3, null],
    ] as const) {
      db.prepare(`INSERT INTO issues
        (id, owner_user_id, created_by_actor, repo_path, seq, title, description, stage,
         default_agent, parent_id, color, created_at, updated_at, revision)
        VALUES (?, 'user:a', 'user:a', '/r', ?, ?, 'Keep this text', 'backlog',
          'codex', ?, ?, '2026-01-01', '2026-01-01', 7)`).run(
        `issue-${seq}`,
        seq,
        `Task ${seq}`,
        seq === 2 ? 'issue-1' : null,
        color,
      )
    }
    db.prepare(`INSERT INTO labels (id, name, color, description, created_at)
      VALUES (1, 'bug', 'rose', 'Keep this label', '2026-01-01')`).run()
    db.prepare('INSERT INTO issue_labels (issue_id, label_id) VALUES (?, ?)').run('issue-1', 1)
    const before = db.prepare('SELECT * FROM issues ORDER BY seq').all() as Record<
      string,
      unknown
    >[]
    const withoutColors = before.map(({ color: _color, ...row }) => row)
    const labels = db.prepare('SELECT * FROM labels').all()
    const links = db.prepare('SELECT * FROM issue_labels').all()

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))

    expect(db.prepare('SELECT * FROM issues ORDER BY seq').all()).toEqual(withoutColors)
    expect(db.prepare('SELECT * FROM labels').all()).toEqual(labels)
    expect(db.prepare('SELECT * FROM issue_labels').all()).toEqual(links)
    expect(db.prepare('PRAGMA table_info(issues)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'color' })]),
    )
    const identity = db.prepare('SELECT feed_id, epoch FROM feed_identity').get()
    expect(identity).toEqual({
      feed_id: 'feed',
      epoch: expect.stringMatching(/^remove-task-colors-/),
    })
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(db.prepare('SELECT * FROM issues ORDER BY seq').all()).toEqual(withoutColors)
    expect(db.prepare('SELECT feed_id, epoch FROM feed_identity').get()).toEqual(identity)
  } finally {
    db.close()
  }
})
