import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveRepoId } from './repo-id'
import type { SessionRow } from './store'
import { SessionStore } from './store'

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-store-'))
  return join(dir, 'podium.db')
}

describe('SessionStore repos', () => {
  it('starts empty, adds, dedupes, lists in insertion order, removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.listRepoPaths()).toEqual([])
    store.addRepo('/home/u/b')
    store.addRepo('/home/u/a')
    store.addRepo('/home/u/b') // dedupe
    expect(store.listRepoPaths()).toEqual(['/home/u/b', '/home/u/a'])
    store.removeRepo('/home/u/b')
    expect(store.listRepoPaths()).toEqual(['/home/u/a'])
    store.close()
  })

  it('persists repos across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.addRepo('/abs/one')
    a.close()
    const b = new SessionStore(file)
    expect(b.listRepoPaths()).toEqual(['/abs/one'])
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
    name: null,
    archived: false,
    workState: null,
    status: 'starting',
    exitCode: null,
    durableLabel: 'podium-id-1',
    createdAt: '2026-06-09T00:00:00.000Z',
    lastActiveAt: '2026-06-09T00:00:00.000Z',
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    // loadSessions() always returns the attribution column ('__local__' pre-multi-machine),
    // so the round-trip fixture carries it too.
    machineId: '__local__',
    // Same for provenance (issue #60): loadSessions always returns it (null = legacy).
    spawnedBy: null,
    // And the headless flag (concierge unification): always present, default false.
    headless: false,
    // And the explicit issue attachment (issue-as-workspace): always present, null = unattached.
    issueId: null,
    // And email-style read state (issue #124): always present, null = never opened.
    readAt: null,
    ...overrides,
  }
}

describe('SessionStore sessions', () => {
  it('rejects persisting an invalid agentKind (write-side guard against poison rows)', () => {
    // Strict on write: an agentKind outside the enum (e.g. the 'auto' sentinel) must
    // never reach the table, since it later fails the sessionsChanged zod-parse and
    // blanks every client. Fail loudly at the source instead.
    const s = new SessionStore(':memory:')
    expect(() => s.upsertSession(row({ agentKind: 'auto' }))).toThrow(/agentKind/i)
    s.close()
  })

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

  it('round-trips the activity timestamps (output/input/resumed)', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(
      row({
        id: 's1',
        durableLabel: 'podium-s1',
        lastOutputAt: '2026-06-29T01:00:00.000Z',
        lastInputAt: '2026-06-29T02:00:00.000Z',
        lastResumedAt: '2026-06-29T03:00:00.000Z',
      }),
    )
    const [r] = store.loadSessions()
    expect(r?.lastOutputAt).toBe('2026-06-29T01:00:00.000Z')
    expect(r?.lastInputAt).toBe('2026-06-29T02:00:00.000Z')
    expect(r?.lastResumedAt).toBe('2026-06-29T03:00:00.000Z')
    store.close()
  })

  it('reads null activity timestamps for a row that never had them', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 's2', durableLabel: 'podium-s2' }))
    const [r] = store.loadSessions()
    expect(r?.lastOutputAt).toBeNull()
    expect(r?.lastInputAt).toBeNull()
    expect(r?.lastResumedAt).toBeNull()
    store.close()
  })

  it('round-trips spawnedBy provenance (issue #60)', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 's1', durableLabel: 'podium-s1', spawnedBy: 'issue:iss_9' }))
    expect(store.loadSessions()[0]?.spawnedBy).toBe('issue:iss_9')
    store.close()
  })

  it('reads spawnedBy as null on a legacy row that never had it', () => {
    const store = new SessionStore(':memory:')
    // A row written without the field (the pre-#60 write shape) reads back null.
    const { spawnedBy: _omit, ...legacy } = row({ id: 's2', durableLabel: 'podium-s2' })
    store.upsertSession(legacy)
    expect(store.loadSessions()[0]?.spawnedBy).toBeNull()
    store.close()
  })

  // Email-style read state (issue #124): read_at persists like the other additive columns.
  it('fresh DB has the read_at column', () => {
    const store = new SessionStore(':memory:')
    // @ts-expect-error reach the private db for a schema assertion
    const cols = (store.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(cols).toContain('read_at')
    store.close()
  })

  it('round-trips read_at; a row that never had it reads null', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(
      row({ id: 's_read', durableLabel: 'podium-s_read', readAt: '2026-07-07T00:00:00.000Z' }),
    )
    store.upsertSession(row({ id: 's_unread', durableLabel: 'podium-s_unread' }))
    const loaded = store.loadSessions()
    expect(loaded.find((s) => s.id === 's_read')?.readAt).toBe('2026-07-07T00:00:00.000Z')
    expect(loaded.find((s) => s.id === 's_unread')?.readAt).toBeNull()
    store.close()
  })
})

describe('SessionStore drafts', () => {
  it('round-trips, overwrites, and clears a draft on empty text', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.setDraft('sess', 'half typed')
    a.setDraft('sess', 'half typed and more') // overwrite, not append
    a.close()

    const b = new SessionStore(file) // survives a "restart"
    expect(b.loadDrafts()).toEqual({ sess: 'half typed and more' })
    b.setDraft('sess', '') // composer cleared on send
    expect(b.loadDrafts()).toEqual({})
    b.close()
  })

  it('exposes draft edit times: setDraft returns the timestamp (undefined on clear) and loadDraftTimes round-trips it', () => {
    const store = new SessionStore(':memory:')
    const at = store.setDraft('sess', 'typing')
    expect(typeof at).toBe('string')
    expect(store.loadDraftTimes()).toEqual({ sess: at })
    expect(store.setDraft('sess', '')).toBeUndefined()
    expect(store.loadDraftTimes()).toEqual({})
    store.close()
  })

  it('drops a session draft when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row())
    store.setDraft('id-1', 'work in progress')
    store.deleteSession('id-1')
    expect(store.loadDrafts()).toEqual({})
    store.close()
  })

  it('ignores a blank session id', () => {
    const store = new SessionStore(':memory:')
    store.setDraft('  ', 'orphan')
    expect(store.loadDrafts()).toEqual({})
    store.close()
  })
})

describe('SessionStore repos.json import', () => {
  it('imports a sibling repos.json into an empty db, once', async () => {
    const file = await tmpDbPath()
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/a', '/b']))
    const a = new SessionStore(file)
    expect(a.listRepoPaths()).toEqual(['/a', '/b'])
    a.close()
    // Re-open: repos already present, so a (possibly changed) json is NOT re-imported.
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/c']))
    const b = new SessionStore(file)
    expect(b.listRepoPaths()).toEqual(['/a', '/b'])
    b.close()
  })

  it('tolerates a missing or corrupt repos.json', async () => {
    const missing = await tmpDbPath()
    expect(new SessionStore(missing).listRepoPaths()).toEqual([])
    const corrupt = await tmpDbPath()
    await writeFile(join(dirname(corrupt), 'repos.json'), 'not json')
    expect(new SessionStore(corrupt).listRepoPaths()).toEqual([])
  })
})

describe('SessionStore schema migration', () => {
  it('migrates a v1 db (tmux_label column) to durable_label without losing rows', async () => {
    const file = await tmpDbPath()
    // Hand-build a v1 database the way the pre-rename store created it.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, cwd TEXT NOT NULL,
         title TEXT NOT NULL, origin_kind TEXT NOT NULL, conversation_id TEXT,
         resume_kind TEXT, resume_value TEXT, status TEXT NOT NULL, exit_code INTEGER,
         tmux_label TEXT NOT NULL, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
       )`,
    )
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    db.prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, status, tmux_label,
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

  it('migrates a main-only v5 db (conversation_id present, NO machines) to the merged v6', async () => {
    // The collision case: a DB that reached schema_version=5 via main's lineage
    // (conversation_id + issues) but never saw the multi-machine migration — so it has
    // NO machines table and NO machine_id columns. The marker says 5, so a
    // version-number gate would skip the machine migration; the STRUCTURAL guard must
    // still fire, add the machines table + machine_id columns, and bump the marker to 6.
    const file = await tmpDbPath()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    // Sessions as main's v5 created them: conversation_id present, machine_id ABSENT.
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, cwd TEXT NOT NULL,
         title TEXT NOT NULL, name TEXT, origin_kind TEXT NOT NULL, conversation_id TEXT,
         resume_kind TEXT, resume_value TEXT, status TEXT NOT NULL, exit_code INTEGER,
         durable_label TEXT NOT NULL, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0, work_state TEXT
       )`,
    )
    // Conversations as main's v5 created them: machine_id ABSENT.
    db.exec(
      `CREATE TABLE conversations (
         id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, provider_id TEXT NOT NULL,
         title TEXT, name TEXT, summary TEXT, project_path TEXT,
         resume_kind TEXT, resume_value TEXT, created_at TEXT, updated_at TEXT,
         message_count INTEGER
       )`,
    )
    // Repos as the pre-multi-machine schema: single-column (path) PK, NO machine_id.
    db.exec(
      `CREATE TABLE repos (
         path TEXT PRIMARY KEY, repo_name TEXT, added_at TEXT NOT NULL
       )`,
    )
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '5')
    db.prepare(
      `INSERT INTO sessions (id, agent_kind, cwd, title, origin_kind, conversation_id, status,
        durable_label, created_at, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mv5-1',
      'claude-code',
      '/proj',
      'proj',
      'spawn',
      'conv-1',
      'running',
      'podium-mv5-1',
      '2026-06-22T00:00:00.000Z',
      '2026-06-22T00:00:00.000Z',
    )
    db.prepare('INSERT INTO repos (path, repo_name, added_at) VALUES (?, ?, ?)').run(
      '/proj',
      'proj',
      '2026-06-22T00:00:00.000Z',
    )
    // Sanity: the fixture really lacks the machines table before migration.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='machines'").get(),
    ).toBeUndefined()
    db.close()

    // Opening through SessionStore runs migrate(): the structural guard must fire.
    const store = new SessionStore(file)
    // The session survived and its conversation_id was preserved (main lineage intact).
    const sessions = store.loadSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.conversationId).toBe('conv-1')
    // It gained a machine_id, defaulting to the '__local__' placeholder (multi-machine).
    expect(sessions[0]?.machineId).toBe('__local__')
    // The repos table was re-keyed to (machine_id, path) and the row carried over.
    expect(store.listRepos()).toEqual([
      {
        machineId: '__local__',
        path: '/proj',
        originUrl: null,
        // v8: path-fallback repo_id backfilled (no origin known for this row)
        repoId: deriveRepoId({ machineId: '__local__', path: '/proj' }),
      },
    ])
    // The machines table now exists (listMachines reads it — would throw otherwise).
    expect(store.listMachines()).toEqual([])
    store.close()

    // And the version marker is now at the current schema version (9: email-style
    // read state (#124) bumped the coherence marker 8 -> 9; the structural
    // migrations above still run regardless, the number is just at-a-glance).
    const reopened = new (await import('node:sqlite')).DatabaseSync(file)
    const ver = reopened.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    expect(ver?.value).toBe('9')
    reopened.close()
  })
})

describe('SessionStore pins', () => {
  it('starts empty, adds, dedupes, lists by kind in insertion order, and removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.listPins()).toEqual({ panels: [], worktrees: [], repos: [] })

    store.setPin('repo', '/repo/b', true)
    store.setPin('worktree', '/repo/b-feature', true)
    store.setPin('panel', 'session-2', true)
    store.setPin('repo', '/repo/a', true)
    store.setPin('repo', '/repo/b', true)

    expect(store.listPins()).toEqual({
      panels: ['session-2'],
      worktrees: ['/repo/b-feature'],
      repos: ['/repo/b', '/repo/a'],
    })

    store.setPin('repo', '/repo/b', false)
    expect(store.listPins()).toEqual({
      panels: ['session-2'],
      worktrees: ['/repo/b-feature'],
      repos: ['/repo/a'],
    })
    store.close()
  })

  it('removes a panel pin when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 'session-1' }))
    store.setPin('panel', 'session-1', true)

    store.deleteSession('session-1')

    expect(store.listPins()).toEqual({ panels: [], worktrees: [], repos: [] })
    store.close()
  })
})

describe('SessionStore snoozes', () => {
  it('starts empty, sets until-next-message (null) and timed, overwrites, and clears', () => {
    const store = new SessionStore(':memory:')
    expect(store.listSnoozes()).toEqual({})

    store.setSnooze('s1', null)
    store.setSnooze('s2', '2999-01-01T05:00:00.000Z')
    expect(store.listSnoozes(0)).toEqual({ s1: null, s2: '2999-01-01T05:00:00.000Z' })

    // overwrite s1 with a timed value
    store.setSnooze('s1', '2999-01-01T05:00:00.000Z')
    expect(store.listSnoozes(0).s1).toBe('2999-01-01T05:00:00.000Z')

    store.clearSnooze('s1')
    expect(store.listSnoozes(0)).toEqual({ s2: '2999-01-01T05:00:00.000Z' })
    store.close()
  })

  it('lazily drops a timed snooze whose deadline has passed; keeps null forever', () => {
    const store = new SessionStore(':memory:')
    store.setSnooze('past', '2000-01-01T00:00:00.000Z')
    store.setSnooze('forever', null)
    const now = Date.parse('2026-06-19T00:00:00.000Z')
    expect(store.listSnoozes(now)).toEqual({ forever: null })
    // the expired row was deleted, not just filtered
    expect(store.listSnoozes(0)).toEqual({ forever: null })
    store.close()
  })

  it('removes a snooze when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 's1' }))
    store.setSnooze('s1', null)
    store.deleteSession('s1')
    expect(store.listSnoozes(0)).toEqual({})
    store.close()
  })
})

describe('SessionStore tab order', () => {
  it('starts empty, upserts per worktree, and clears on an empty list', () => {
    const store = new SessionStore(':memory:')
    expect(store.listTabOrders()).toEqual({})

    store.setTabOrder('/repo/a', ['s1', 's2'])
    store.setTabOrder('/repo/b', ['s9'])
    store.setTabOrder('/repo/a', ['s2', 's1'])
    expect(store.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'], '/repo/b': ['s9'] })

    store.setTabOrder('/repo/b', [])
    expect(store.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'] })
    store.close()
  })

  it('rejects an empty worktree path', () => {
    const store = new SessionStore(':memory:')
    expect(() => store.setTabOrder('  ', ['s1'])).toThrow('worktree path is empty')
    store.close()
  })

  it('persists across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.setTabOrder('/repo/a', ['s2', 's1'])
    a.close()
    const b = new SessionStore(file)
    expect(b.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'] })
    b.close()
  })

  it('scrubs a session from every order when it is deleted', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 's1' }))
    store.setTabOrder('/repo/a', ['s2', 's1'])
    store.setTabOrder('/repo/b', ['s1'])

    store.deleteSession('s1')

    expect(store.listTabOrders()).toEqual({ '/repo/a': ['s2'] })
    store.close()
  })
})

describe('settings', () => {
  it('returns defaults when nothing was ever saved', () => {
    const store = new SessionStore(':memory:')
    const s = store.getSettings()
    expect(s.sessionDefaults.agent).toBe('auto')
    expect(s.superagent.provider).toBe('openrouter')
    expect(s.hibernation.memoryPct).toBe(80)
    store.close()
  })

  it('round-trips a saved blob and fills missing keys forward', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    const s = a.getSettings()
    a.setSettings({
      ...s,
      sessionDefaults: { ...s.sessionDefaults, agent: 'codex', model: 'gpt-5-codex' },
      hibernation: { ...s.hibernation, memoryPct: 90 },
    })
    a.close()
    const b = new SessionStore(file)
    const loaded = b.getSettings()
    expect(loaded.sessionDefaults.agent).toBe('codex')
    expect(loaded.sessionDefaults.model).toBe('gpt-5-codex')
    expect(loaded.hibernation.memoryPct).toBe(90)
    // untouched sections keep their defaults
    expect(loaded.notifications.web).toBe(true)
    b.close()
  })
})

describe('conversation index', () => {
  const conv = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    agentKind: 'claude-code',
    providerId: 'claude-jsonl',
    title: `conv ${id}`,
    projectPath: '/src/app',
    updatedAt: '2026-06-12T08:00:00.000Z',
    ...over,
  })

  it('indexes discovered conversations and finds them by keyword', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([
      conv('a', { title: 'fix the soft keyboard profiles' }),
      conv('b', { title: 'memory chip breakdown' }),
    ])
    const hits = store.searchConversations({ query: 'keyboard' })
    expect(hits.map((h) => h.id)).toEqual(['a'])
    store.close()
  })

  it('prefix-matches partial words', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([conv('a', { title: 'podium relay endpoint' })])
    expect(store.searchConversations({ query: 'rela' }).map((h) => h.id)).toEqual(['a'])
    store.close()
  })

  it('filters by projectPath subtree and browses by recency on empty query', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([
      conv('old', { updatedAt: '2026-06-01T00:00:00.000Z' }),
      conv('new', { updatedAt: '2026-06-12T00:00:00.000Z' }),
      conv('other', { projectPath: '/src/zzz' }),
    ])
    const hits = store.searchConversations({ projectPath: '/src/app' })
    expect(hits.map((h) => h.id)).toEqual(['new', 'old'])
    store.close()
  })

  it('excludes subagent (sidechain) conversations from the resume picker', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([
      conv('top', { title: 'fix the parser' }),
      conv('sub', { title: 'fix the parser subagent', parentConversationId: 'top' }),
    ])
    // Empty-query browse: only the top-level session.
    expect(store.searchConversations({}).map((h) => h.id)).toEqual(['top'])
    // Keyword search: the subagent matches the term but is still filtered out.
    expect(store.searchConversations({ query: 'parser' }).map((h) => h.id)).toEqual(['top'])
    store.close()
  })

  it('orders search results by recency, not relevance (matches claude --resume)', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([
      conv('older', { title: 'relay endpoint fix', updatedAt: '2026-06-01T00:00:00.000Z' }),
      conv('newer', { title: 'relay endpoint retry', updatedAt: '2026-06-12T00:00:00.000Z' }),
    ])
    // Both match "relay endpoint"; the more recently-active one comes first.
    expect(store.searchConversations({ query: 'relay endpoint' }).map((h) => h.id)).toEqual([
      'newer',
      'older',
    ])
    store.close()
  })

  it('curation (name/summary) survives re-discovery and is searchable', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([conv('a')])
    store.setConversationMeta('a', {
      name: 'Soft keyboard epic',
      summary: 'shipped; awaiting review',
    })
    store.upsertConversations([conv('a', { title: 'renamed by discovery' })])
    const [hit] = store.searchConversations({ query: 'epic' })
    expect(hit?.id).toBe('a')
    expect(hit?.name).toBe('Soft keyboard epic')
    expect(hit?.summary).toBe('shipped; awaiting review')
    store.close()
  })

  it('deleteConversations removes the rows and keeps the FTS index consistent', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([
      conv('a', { title: 'keep this keyboard one' }),
      conv('b', { title: 'remove this keyboard one' }),
    ])
    // Both match before the delete.
    expect(
      store
        .searchConversations({ query: 'keyboard' })
        .map((h) => h.id)
        .sort(),
    ).toEqual(['a', 'b'])

    store.deleteConversations(['b'])

    // Browse (empty query, table read) no longer lists the deleted row...
    expect(store.searchConversations({}).map((h) => h.id)).toEqual(['a'])
    // ...and the FTS index dropped it too (the DELETE trigger keeps it in sync),
    // so a keyword search returns only the survivor — no stale match for 'b'.
    expect(store.searchConversations({ query: 'keyboard' }).map((h) => h.id)).toEqual(['a'])
    store.close()
  })

  it('deleteConversations is a no-op on an empty id list', () => {
    const store = new SessionStore(':memory:')
    store.upsertConversations([conv('a')])
    store.deleteConversations([])
    expect(store.searchConversations({}).map((h) => h.id)).toEqual(['a'])
    store.close()
  })
})

describe('SessionStore superagent threads', () => {
  it('creates a default global thread and scopes messages by thread', () => {
    const s = new SessionStore(':memory:')
    expect(s.listSuperagentThreads().some((t) => t.id === 'global')).toBe(true)
    s.appendSuperagentMessage('global', { role: 'user', content: 'hi' })
    s.upsertSuperagentThread({ id: 'btw_x', kind: 'btw', originSessionId: 'x' })
    s.appendSuperagentMessage('btw_x', { role: 'user', content: 'ctx' })
    expect(s.loadSuperagentMessages('global').map((m) => m.content)).toEqual(['hi'])
    expect(s.loadSuperagentMessages('btw_x').map((m) => m.content)).toEqual(['ctx'])
    s.close()
  })
  it('defaults message ops to the global thread', () => {
    const s = new SessionStore(':memory:')
    s.appendSuperagentMessage('global', { role: 'user', content: 'legacy' })
    expect(s.loadSuperagentMessages().map((m) => m.content)).toEqual(['legacy'])
    s.close()
  })
  it('stores and reads a btw watermark', () => {
    const s = new SessionStore(':memory:')
    s.upsertSuperagentThread({ id: 'btw_y', kind: 'btw', originSessionId: 'y' })
    s.setThreadWatermark('btw_y', 'item-42', '2026-06-16T08:00:00Z')
    const t = s.getSuperagentThread('btw_y')
    expect(t?.watermarkItemId).toBe('item-42')
    expect(t?.watermarkTs).toBe('2026-06-16T08:00:00Z')
    s.close()
  })
  it('clears only the targeted thread', () => {
    const s = new SessionStore(':memory:')
    s.appendSuperagentMessage('global', { role: 'user', content: 'g' })
    s.upsertSuperagentThread({ id: 'btw_z', kind: 'btw', originSessionId: 'z' })
    s.appendSuperagentMessage('btw_z', { role: 'user', content: 'z' })
    s.clearSuperagentMessages('btw_z')
    expect(s.loadSuperagentMessages('global').length).toBe(1)
    expect(s.loadSuperagentMessages('btw_z').length).toBe(0)
    s.close()
  })

  it('tolerates a corrupt tool_calls column instead of dropping the whole thread', () => {
    // One message with unparseable tool_calls must NOT throw out of the row map and
    // blank the entire thread's history — quarantine that field to undefined, keep
    // the message and the rest of the thread.
    const s = new SessionStore(':memory:')
    s.appendSuperagentMessage('global', { role: 'assistant', content: 'a' })
    s.appendSuperagentMessage('global', { role: 'assistant', content: 'b' })
    ;(s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE superagent_messages SET tool_calls = '{bad' WHERE content = 'a'")
      .run()

    expect(() => s.loadSuperagentMessages('global')).not.toThrow()
    const msgs = s.loadSuperagentMessages('global')
    expect(msgs.map((m) => m.content)).toEqual(['a', 'b'])
    expect(msgs[0]?.toolCalls).toBeUndefined()
    s.close()
  })
})
