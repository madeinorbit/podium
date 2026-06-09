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
    tmuxLabel: 'podium-id-1',
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
      tmuxLabel: 'podium-id-2',
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
