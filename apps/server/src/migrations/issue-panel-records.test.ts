import { IssuePanelArtifactWire, IssuePanelTodoWire } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_issue-panel-records'))
const stamp = '2026-11-10T00:00:00Z'
let db: SqlDatabase
beforeEach(() => {
  expect(cut).toBeGreaterThan(0)
  db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  db.prepare(
    'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?)',
  ).run('feed', 'before', 1)
})
afterEach(() => db?.close())
function insert(id: string, panel: string | null, state: string | null = null) {
  db.prepare(`INSERT INTO issues (id, owner_user_id, created_by_actor, repo_path, seq, title, stage, default_agent, panel, activity_notes, notes_updated_at, created_at, updated_at, revision)
    VALUES (?, 'user:a', 'user:a', '/repo', 1, ?, 'in_progress', 'codex', ?, ?, ?, ?, ?, 7)`).run(
    id,
    id,
    panel,
    state,
    state ? stamp : null,
    stamp,
    stamp,
  )
}
const migrate = () => runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))

describe('panel records migration', () => {
  it('preserves duplicate text, original order, every artifact field and the state paragraph before dropping the old columns', () => {
    const artifact = {
      path: 'review/index.html',
      title: 'Review',
      addedAt: stamp,
      artifactId: 'snap',
      entry: 'index.html',
      files: [{ path: 'index.html', size: 42 }],
      sourcePaths: ['review/index.html'],
      sourceKind: 'creation-attachment',
      chatUploadId: 'upload',
      chatUploadOwner: 'user:a',
      tracking: 'tracked',
      untrackedPaths: [],
    }
    insert(
      'issue',
      JSON.stringify({
        todos: [
          { text: 'Same', done: false },
          { text: 'Same', done: true },
        ],
        artifacts: [artifact],
        deferred: [
          { text: 'Same', addedAt: stamp },
          { text: 'Same', addedAt: stamp },
        ],
      }),
      'Ready to review',
    )
    insert('empty', null)
    migrate()
    const todos = db
      .prepare(
        'SELECT id, issue_id AS issueId, position, text, done FROM issue_panel_todos ORDER BY position',
      )
      .all() as { id: string; issueId: string; position: number; text: string; done: number }[]
    expect(todos.map((r) => IssuePanelTodoWire.parse({ ...r, done: !!r.done }))).toMatchObject([
      { position: 0, text: 'Same', done: false },
      { position: 1, text: 'Same', done: true },
    ])
    expect(new Set(todos.map((r) => r.id)).size).toBe(2)
    const stored = db.prepare('SELECT * FROM issue_panel_artifacts').get() as {
      id: string
      issue_id: string
      position: number
      value: string
    }
    expect(JSON.parse(stored.value)).toEqual(artifact)
    expect(
      IssuePanelArtifactWire.parse({
        ...JSON.parse(stored.value),
        id: stored.id,
        issueId: stored.issue_id,
        position: stored.position,
      }),
    ).toMatchObject(artifact)
    expect(db.prepare('SELECT count(*) AS n FROM issue_panel_deferred').get()).toMatchObject({
      n: 2,
    })
    expect(db.prepare('SELECT * FROM issue_panel_states').all()).toEqual([
      { id: 'issue', text: 'Ready to review', updated_at: stamp },
    ])
    const columns = (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map(
      (r) => r.name,
    )
    for (const name of ['panel', 'activity_notes', 'notes_updated_at'])
      expect(columns).not.toContain(name)
    expect(db.prepare('SELECT epoch FROM feed_identity').get()).not.toMatchObject({
      epoch: 'before',
    })
    const firstIds = todos.map((r) => r.id)
    migrate()
    expect(
      (
        db.prepare('SELECT id FROM issue_panel_todos ORDER BY position').all() as { id: string }[]
      ).map((r) => r.id),
    ).toEqual(firstIds)
    db.exec('PRAGMA foreign_keys=ON')
    db.exec("DELETE FROM issues WHERE id = 'issue'")
    for (const table of [
      'issue_panel_todos',
      'issue_panel_artifacts',
      'issue_panel_deferred',
      'issue_panel_states',
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 })
  })
  it.each([
    'invalid json',
    '{"todos":[{"text":"kept but missing done"}]}',
    '{"artifacts":[null]}',
  ])('refuses corrupt input transactionally, leaving the old panel recoverable: %s', (panel) => {
    insert('issue', panel)
    expect(migrate).toThrow()
    expect(db.prepare('SELECT panel FROM issues').get()).toEqual({ panel })
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'issue_panel_todos'").get(),
    ).toMatchObject({ n: 0 })
  })
})
