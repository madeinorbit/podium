import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionRow } from './store'
import { SessionStore } from './store'

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-store-'))
  return join(dir, 'podium.db')
}

describe('SessionStore repos', () => {
  it('starts empty, adds, dedupes, lists in insertion order, removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.listRepos()).toEqual([])
    store.addRepo('/home/u/b')
    store.addRepo('/home/u/a')
    store.addRepo('/home/u/b') // dedupe
    expect(store.listRepos()).toEqual(['/home/u/b', '/home/u/a'])
    store.removeRepo('/home/u/b')
    expect(store.listRepos()).toEqual(['/home/u/a'])
    store.close()
  })

  it('persists repos across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.addRepo('/abs/one')
    a.close()
    const b = new SessionStore(file)
    expect(b.listRepos()).toEqual(['/abs/one'])
    b.close()
  })

  it('exposes loadSessions() as [] on a fresh db (tables exist)', () => {
    const store = new SessionStore(':memory:')
    expect(store.loadSessions()).toEqual([])
    store.close()
  })
})

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'id-1',
    agentKind: 'claude-code',
    cwd: '/proj',
    title: 'proj',
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'starting',
    exitCode: null,
    durableLabel: 'podium-id-1',
    createdAt: '2026-06-09T00:00:00.000Z',
    lastActiveAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('SessionStore sessions', () => {
  it('upserts, loads, updates in place (preserving created_at), and deletes', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.upsertSession(row())
    a.upsertSession(
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    )
    a.close()

    const b = new SessionStore(file)
    expect(b.loadSessions()).toEqual([
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    ])
    b.deleteSession('id-1')
    expect(b.loadSessions()).toEqual([])
    b.close()
  })

  it('round-trips resume metadata', () => {
    const store = new SessionStore(':memory:')
    const r = row({
      id: 'id-2',
      originKind: 'resume',
      conversationId: 'c9',
      resumeKind: 'codex-thread',
      resumeValue: 't9',
      durableLabel: 'podium-id-2',
    })
    store.upsertSession(r)
    expect(store.loadSessions()).toEqual([r])
    store.close()
  })
})

describe('SessionStore repos.json import', () => {
  it('imports a sibling repos.json into an empty db, once', async () => {
    const file = await tmpDbPath()
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/a', '/b']))
    const a = new SessionStore(file)
    expect(a.listRepos()).toEqual(['/a', '/b'])
    a.close()
    // Re-open: repos already present, so a (possibly changed) json is NOT re-imported.
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/c']))
    const b = new SessionStore(file)
    expect(b.listRepos()).toEqual(['/a', '/b'])
    b.close()
  })

  it('tolerates a missing or corrupt repos.json', async () => {
    const missing = await tmpDbPath()
    expect(new SessionStore(missing).listRepos()).toEqual([])
    const corrupt = await tmpDbPath()
    await writeFile(join(dirname(corrupt), 'repos.json'), 'not json')
    expect(new SessionStore(corrupt).listRepos()).toEqual([])
  })
})

describe('SessionStore schema migration', () => {
  it('migrates a v1 db (durable_label column) to durable_label without losing rows', async () => {
    const file = await tmpDbPath()
    // Hand-build a v1 database the way the pre-rename store created it.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, cwd TEXT NOT NULL,
         title TEXT NOT NULL, origin_kind TEXT NOT NULL, conversation_id TEXT,
         resume_kind TEXT, resume_value TEXT, status TEXT NOT NULL, exit_code INTEGER,
         durable_label TEXT NOT NULL, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
       )`,
    )
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    db.prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, durable_label,
        created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'old-1',
      'claude-code',
      '/proj',
      'proj',
      'spawn',
      'running',
      'podium-old-1',
      '2026-06-09T00:00:00.000Z',
      '2026-06-09T00:00:00.000Z',
    )
    db.close()

    const store = new SessionStore(file)
    const rows = store.loadSessions()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.durableLabel).toBe('podium-old-1')
    // Round-trips through the renamed column.
    store.upsertSession(row({ id: 'new-1', durableLabel: 'podium-new-1' }))
    expect(
      store
        .loadSessions()
        .map((r) => r.durableLabel)
        .sort(),
    ).toEqual(['podium-new-1', 'podium-old-1'])
    store.close()
  })
})
