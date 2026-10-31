import { IssuePanel } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '.'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_creation-attachment-source'))
const migration = DRIZZLE_MIGRATIONS[cut]
if (!migration) throw new Error('creation attachment migration is missing')

const attachment = (id: string) => ({
  path: `attachments/att-${id}/image.png`,
  title: `Image ${id}`,
  addedAt: '2026-10-28T00:00:00Z',
  artifactId: `snapshot-${id}`,
  entry: 'image.png',
  files: [{ path: 'image.png', size: 123 }],
})

describe('creation attachment provenance backfill', () => {
  let db: SqlDatabase
  let seq: number

  beforeEach(() => {
    expect(cut).toBeGreaterThan(0)
    db = openDatabase(':memory:')
    seq = 0
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    db.prepare(
      'INSERT INTO feed_identity (singleton, feed_id, epoch, minted_at) VALUES (1, ?, ?, ?)',
    ).run('feed', 'before', 1)
  })

  afterEach(() => db?.close())

  function insert(id: string, panel: string | null) {
    db.prepare(
      `INSERT INTO issues
        (id, owner_user_id, created_by_actor, repo_path, seq, title, stage,
         default_agent, panel, created_at, updated_at, revision)
       VALUES (?, 'user:a', 'user:a', '/r', ?, ?, 'in_progress',
         'codex', ?, '2026-10-28', '2026-10-28', 7)`,
    ).run(id, ++seq, id, panel)
  }

  function row(id: string) {
    return db
      .prepare('SELECT panel, revision, updated_at, worktree_path FROM issues WHERE id = ?')
      .get(id) as {
      panel: string | null
      revision: number
      updated_at: string
      worktree_path: string | null
    }
  }

  it('marks all six creation attachments and preserves the rest of the panel', () => {
    const artifacts = Array.from({ length: 6 }, (_, n) => attachment(String(n)))
    const panel = {
      artifacts,
      todos: [{ text: 'Review the inputs', done: false }],
      deferred: [{ text: 'Later', addedAt: '2026-10-28' }],
      extra: { preserved: true },
    }
    insert('coordinator', JSON.stringify(panel))
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    const migrated = row('coordinator')
    const expected = {
      ...panel,
      artifacts: artifacts.map((artifact) => ({ ...artifact, sourceKind: 'creation-attachment' })),
    }
    const parsed = JSON.parse(migrated.panel ?? 'null')
    expect(parsed).toEqual(expected)
    expect(IssuePanel.parse(parsed).artifacts).toEqual(expected.artifacts)
    expect(migrated).toMatchObject({ revision: 8, updated_at: '2026-10-28', worktree_path: null })
    expect(db.prepare('SELECT feed_id, epoch FROM feed_identity').get()).toMatchObject({
      feed_id: 'feed',
      epoch: expect.stringMatching(/^creation-attachment-source-/),
    })
    // The data rewrite itself is idempotent, as well as the migration ledger.
    db.exec(migration.sql)
    expect(row('coordinator')).toEqual(migrated)
  })

  it('leaves agent evidence, chat uploads and existing provenance unchanged', () => {
    const artifacts = [
      { ...attachment('agent'), sourcePaths: ['attachments/att-agent/image.png'] },
      { ...attachment('terminal'), sourceKind: 'terminal-evidence' },
      { ...attachment('chat'), chatUploadId: 'upload-1' },
      { ...attachment('marked'), sourceKind: 'creation-attachment' },
      { path: 'attachments/att-live/image.png', addedAt: 't' },
      { ...attachment('ordinary'), path: 'evidence/image.png' },
    ]
    const raw = JSON.stringify({ artifacts })
    insert('unchanged', raw)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    expect(row('unchanged')).toMatchObject({ panel: raw, revision: 7 })
  })

  it('tolerates malformed panels and preserves unrelated malformed artifact entries', () => {
    const untouched = [null, 'invalid json', '{}', '{"artifacts":null}', '{"artifacts":{}}']
    untouched.forEach((panel, n) => {
      insert(`garbage-${n}`, panel)
    })
    const artifacts = [attachment('valid'), 'not an artifact', null, 42, true]
    insert('mixed', JSON.stringify({ artifacts }))
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    untouched.forEach((panel, n) => {
      expect(row(`garbage-${n}`)).toMatchObject({ panel, revision: 7 })
    })
    expect(JSON.parse(row('mixed').panel ?? 'null')).toEqual({
      artifacts: [
        { ...attachment('valid'), sourceKind: 'creation-attachment' },
        ...artifacts.slice(1),
      ],
    })
  })
})
