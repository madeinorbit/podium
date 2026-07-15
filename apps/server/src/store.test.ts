import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
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
    expect(store.repos.listRepoPaths()).toEqual([])
    store.repos.addRepo('/home/u/b')
    store.repos.addRepo('/home/u/a')
    store.repos.addRepo('/home/u/b') // dedupe
    expect(store.repos.listRepoPaths()).toEqual(['/home/u/b', '/home/u/a'])
    store.repos.removeRepo('/home/u/b')
    expect(store.repos.listRepoPaths()).toEqual(['/home/u/a'])
    store.close()
  })

  it('persists repos across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.repos.addRepo('/abs/one')
    a.close()
    const b = new SessionStore(file)
    expect(b.repos.listRepoPaths()).toEqual(['/abs/one'])
    b.close()
  })

  it('upgrades a manually-added remote repo when scanner reports a canonical path', () => {
    const store = new SessionStore(':memory:')
    const machineId = 'm-vmi'
    const path = '/home/till/src/podium'
    const originUrl = 'https://github.com/madeinorbit/podium.git'

    store.repos.addRepo(`${path}/`, machineId)
    store.repos.updateRepoOrigin(machineId, path, originUrl)

    expect(store.repos.listRepos(machineId)).toEqual([
      {
        machineId,
        path,
        originUrl,
        repoId: deriveRepoId({ originUrl, machineId, path }),
        prefix: expect.any(String),
      },
    ])
    store.close()
  })

  it('resolves subpaths under a registered filesystem root repo', () => {
    const store = new SessionStore(':memory:')
    store.repos.addRepo('/')
    const repoId = store.repos.listRepos()[0]?.repoId

    expect(store.repos.resolveRepoIdForPath('/home/till/src/podium')).toBe(repoId)
    store.close()
  })

  it('exposes loadSessions() as [] on a fresh db (tables exist)', () => {
    const store = new SessionStore(':memory:')
    expect(store.sessions.loadSessions()).toEqual([])
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
    // WHO named the session (#490): always projected; null = nobody named it.
    nameSource: null,
    archived: false,
    workState: null,
    status: 'starting',
    exitCode: null,
    durableLabel: 'podium-id-1',
    createdAt: '2026-06-09T00:00:00.000Z',
    lastActiveAt: '2026-06-09T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
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
    // Human-facing nice-name fields (#474): always projected, null = not yet named.
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    // And email-style read state (issue #124): always present, null = never opened.
    readAt: null,
    // #285 workflow pass-through metadata (#237 [spec:SP-34d7 cross-harness]):
    // always projected, null = none stamped at spawn.
    workflowRunId: null,
    workflowStepId: null,
    executionProfileId: null,
    // Issue-lifecycle tombstones are always projected by the repository.
    deletedAt: null,
    // Tombstones record whether an issue cascade or a standalone remove created them.
    deletionSource: null,
    // Provenance lets restore recover cwd-derived sessions that had no explicit issueId.
    deletedByIssueId: null,
    ...overrides,
  }
}

describe('SessionStore sessions', () => {
  it('rejects persisting an invalid agentKind (write-side guard against poison rows)', () => {
    // Strict on write: an agentKind outside the enum (e.g. the 'auto' sentinel) must
    // never reach the table, since it later fails the sessionsChanged zod-parse and
    // blanks every client. Fail loudly at the source instead.
    const s = new SessionStore(':memory:')
    expect(() => s.sessions.upsertSession(row({ agentKind: 'auto' }))).toThrow(/agentKind/i)
    s.close()
  })

  it('upserts, loads, updates in place (preserving created_at), and deletes', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.sessions.upsertSession(row())
    a.sessions.upsertSession(
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    )
    a.close()

    const b = new SessionStore(file)
    expect(b.sessions.loadSessions()).toEqual([
      row({ status: 'live', title: 'renamed', lastActiveAt: '2026-06-09T00:05:00.000Z' }),
    ])
    b.sessions.purgeSession('id-1')
    expect(b.sessions.loadSessions()).toEqual([])
    b.close()
  })

  it('round-trips the last authoritative terminal geometry', () => {
    const s = new SessionStore(':memory:')
    const resized = row({ geometry: { cols: 173, rows: 47 } })
    s.sessions.upsertSession(resized)
    expect(s.sessions.loadSessions()).toEqual([resized])
    s.close()
  })

  it('round-trips who named the session (#490) — and reads a rogue source as nobody', () => {
    const s = new SessionStore(':memory:')
    // The distinction the agent-title refusal rests on: a name is not enough, the
    // SOURCE has to survive the write → restart → read cycle.
    const user = row({ id: 'u', name: 'Merge lock lease expiry', nameSource: 'user' })
    const agent = row({ id: 'a', name: 'Session title slot', nameSource: 'agent' })
    s.sessions.upsertSession(user)
    s.sessions.upsertSession(agent)
    expect(s.sessions.loadSessions()).toEqual([user, agent])

    // A value that is neither must never read back as one that could out-rank the
    // user — an unknown source degrades to "nobody named it".
    s.sessions.upsertSession({ ...user, nameSource: 'root' } as unknown as SessionRow)
    expect(s.sessions.loadSessions().find((r) => r.id === 'u')?.nameSource).toBeNull()
    s.close()
  })

  it('round-trips #285 workflow pass-through metadata verbatim (never interpreted)', () => {
    const s = new SessionStore(':memory:')
    const r = row({
      workflowRunId: 'run_9',
      workflowStepId: 'step_3',
      executionProfileId: 'prof_x',
    })
    s.sessions.upsertSession(r)
    expect(s.sessions.loadSessions()).toEqual([r])
    s.close()
  })

  it('hides issue-deleted session tombstones and restores them as exited records', () => {
    const store = new SessionStore(':memory:')
    const deletedAt = '2026-07-13T10:00:00.000Z'
    store.sessions.upsertSession(row({ issueId: 'iss_1', status: 'live' }))

    store.sessions.softDeleteForIssue(['id-1'], 'iss_1', deletedAt)
    expect(store.sessions.loadSessions()).toEqual([])
    expect(store.sessions.loadDeletedSessionsForIssue('iss_1')).toEqual([
      row({
        issueId: 'iss_1',
        status: 'live',
        deletedAt,
        deletionSource: 'issue',
        deletedByIssueId: 'iss_1',
      }),
    ])

    store.sessions.restoreDeletedForIssue('iss_1')
    expect(store.sessions.loadDeletedSessionsForIssue('iss_1')).toEqual([])
    expect(store.sessions.loadSessions()).toEqual([row({ issueId: 'iss_1', status: 'exited' })])
    store.close()
  })

  it('keeps standalone session tombstones out of active loads and issue restoration', () => {
    const store = new SessionStore(':memory:')
    const deletedAt = '2026-07-13T11:00:00.000Z'
    store.sessions.upsertSession(row({ issueId: 'iss_1', status: 'live' }))
    store.sessions.setPin('panel', 'id-1', true)
    store.sessions.setDraft('id-1', 'recoverable input')
    store.sessions.setSnooze('id-1', null)
    store.sessions.setTabOrder('/proj', ['id-1'])

    store.sessions.softDeleteSessions(['id-1'], deletedAt, 'standalone')

    expect(store.sessions.loadSessions()).toEqual([])
    expect(store.sessions.loadDeletedSessions()).toEqual([
      row({
        issueId: 'iss_1',
        status: 'live',
        deletedAt,
        deletionSource: 'standalone',
      }),
    ])
    expect(store.sessions.loadDeletedSessionsForIssue('iss_1')).toEqual([])
    expect(store.sessions.listPins().panels).toEqual(['id-1'])
    expect(store.sessions.loadDrafts()).toEqual({ 'id-1': 'recoverable input' })
    expect(store.sessions.listSnoozes()).toEqual({ 'id-1': null })
    expect(store.sessions.listTabOrders()).toEqual({ '/proj': ['id-1'] })

    store.sessions.restoreDeletedForIssue('iss_1')
    expect(store.sessions.loadSessions()).toEqual([])
    expect(store.sessions.loadDeletedSessions()).toHaveLength(1)
    store.close()
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
    store.sessions.upsertSession(r)
    expect(store.sessions.loadSessions()).toEqual([r])
    store.close()
  })

  it('round-trips the activity timestamps (output/input/resumed)', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(
      row({
        id: 's1',
        durableLabel: 'podium-s1',
        lastOutputAt: '2026-06-29T01:00:00.000Z',
        lastInputAt: '2026-06-29T02:00:00.000Z',
        lastResumedAt: '2026-06-29T03:00:00.000Z',
      }),
    )
    const [r] = store.sessions.loadSessions()
    expect(r?.lastOutputAt).toBe('2026-06-29T01:00:00.000Z')
    expect(r?.lastInputAt).toBe('2026-06-29T02:00:00.000Z')
    expect(r?.lastResumedAt).toBe('2026-06-29T03:00:00.000Z')
    store.close()
  })

  it('reads null activity timestamps for a row that never had them', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(row({ id: 's2', durableLabel: 'podium-s2' }))
    const [r] = store.sessions.loadSessions()
    expect(r?.lastOutputAt).toBeNull()
    expect(r?.lastInputAt).toBeNull()
    expect(r?.lastResumedAt).toBeNull()
    store.close()
  })

  it('round-trips spawnedBy provenance (issue #60)', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(
      row({ id: 's1', durableLabel: 'podium-s1', spawnedBy: 'issue:iss_9' }),
    )
    expect(store.sessions.loadSessions()[0]?.spawnedBy).toBe('issue:iss_9')
    store.close()
  })

  it('reads spawnedBy as null on a legacy row that never had it', () => {
    const store = new SessionStore(':memory:')
    // A row written without the field (the pre-#60 write shape) reads back null.
    const { spawnedBy: _omit, ...legacy } = row({ id: 's2', durableLabel: 'podium-s2' })
    store.sessions.upsertSession(legacy)
    expect(store.sessions.loadSessions()[0]?.spawnedBy).toBeNull()
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
    store.sessions.upsertSession(
      row({ id: 's_read', durableLabel: 'podium-s_read', readAt: '2026-07-07T00:00:00.000Z' }),
    )
    store.sessions.upsertSession(row({ id: 's_unread', durableLabel: 'podium-s_unread' }))
    const loaded = store.sessions.loadSessions()
    expect(loaded.find((s) => s.id === 's_read')?.readAt).toBe('2026-07-07T00:00:00.000Z')
    expect(loaded.find((s) => s.id === 's_unread')?.readAt).toBeNull()
    store.close()
  })
})

describe('SessionStore drafts', () => {
  it('round-trips, overwrites, and clears a draft on empty text', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.sessions.setDraft('sess', 'half typed')
    a.sessions.setDraft('sess', 'half typed and more') // overwrite, not append
    a.close()

    const b = new SessionStore(file) // survives a "restart"
    expect(b.sessions.loadDrafts()).toEqual({ sess: 'half typed and more' })
    b.sessions.setDraft('sess', '') // composer cleared on send
    expect(b.sessions.loadDrafts()).toEqual({})
    b.close()
  })

  it('exposes draft edit times: setDraft returns the timestamp (undefined on clear) and loadDraftTimes round-trips it', () => {
    const store = new SessionStore(':memory:')
    const at = store.sessions.setDraft('sess', 'typing')
    expect(typeof at).toBe('string')
    expect(store.sessions.loadDraftTimes()).toEqual({ sess: at })
    expect(store.sessions.setDraft('sess', '')).toBeUndefined()
    expect(store.sessions.loadDraftTimes()).toEqual({})
    store.close()
  })

  it('drops a session draft when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(row())
    store.sessions.setDraft('id-1', 'work in progress')
    store.sessions.purgeSession('id-1')
    expect(store.sessions.loadDrafts()).toEqual({})
    store.close()
  })

  it('ignores a blank session id', () => {
    const store = new SessionStore(':memory:')
    store.sessions.setDraft('  ', 'orphan')
    expect(store.sessions.loadDrafts()).toEqual({})
    store.close()
  })
})

describe('SessionStore repos.json import', () => {
  it('imports a sibling repos.json into an empty db, once', async () => {
    const file = await tmpDbPath()
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/a', '/b']))
    const a = new SessionStore(file)
    expect(a.repos.listRepoPaths()).toEqual(['/a', '/b'])
    a.close()
    // Re-open: repos already present, so a (possibly changed) json is NOT re-imported.
    await writeFile(join(dirname(file), 'repos.json'), JSON.stringify(['/c']))
    const b = new SessionStore(file)
    expect(b.repos.listRepoPaths()).toEqual(['/a', '/b'])
    b.close()
  })

  it('tolerates a missing or corrupt repos.json', async () => {
    const missing = await tmpDbPath()
    expect(new SessionStore(missing).repos.listRepoPaths()).toEqual([])
    const corrupt = await tmpDbPath()
    await writeFile(join(dirname(corrupt), 'repos.json'), 'not json')
    expect(new SessionStore(corrupt).repos.listRepoPaths()).toEqual([])
  })
})

// The 'SessionStore schema migration' tests (in-process upgrade of v1/v5 legacy
// databases) were removed with the legacy migration chain [spec:SP-4428]: an
// old-format database is upgraded by running a pre-drizzle Podium build first,
// not in-process.

describe('SessionStore pins', () => {
  it('starts empty, adds, dedupes, lists by kind in insertion order, and removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.sessions.listPins()).toEqual({ panels: [], worktrees: [], repos: [] })

    store.sessions.setPin('repo', '/repo/b', true)
    store.sessions.setPin('worktree', '/repo/b-feature', true)
    store.sessions.setPin('panel', 'session-2', true)
    store.sessions.setPin('repo', '/repo/a', true)
    store.sessions.setPin('repo', '/repo/b', true)

    expect(store.sessions.listPins()).toEqual({
      panels: ['session-2'],
      worktrees: ['/repo/b-feature'],
      repos: ['/repo/b', '/repo/a'],
    })

    store.sessions.setPin('repo', '/repo/b', false)
    expect(store.sessions.listPins()).toEqual({
      panels: ['session-2'],
      worktrees: ['/repo/b-feature'],
      repos: ['/repo/a'],
    })
    store.close()
  })

  it('removes a panel pin when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(row({ id: 'session-1' }))
    store.sessions.setPin('panel', 'session-1', true)

    store.sessions.purgeSession('session-1')

    expect(store.sessions.listPins()).toEqual({ panels: [], worktrees: [], repos: [] })
    store.close()
  })
})

describe('SessionStore snoozes', () => {
  it('starts empty, sets until-next-message (null) and timed, overwrites, and clears', () => {
    const store = new SessionStore(':memory:')
    expect(store.sessions.listSnoozes()).toEqual({})

    store.sessions.setSnooze('s1', null)
    store.sessions.setSnooze('s2', '2999-01-01T05:00:00.000Z')
    expect(store.sessions.listSnoozes(0)).toEqual({ s1: null, s2: '2999-01-01T05:00:00.000Z' })

    // overwrite s1 with a timed value
    store.sessions.setSnooze('s1', '2999-01-01T05:00:00.000Z')
    expect(store.sessions.listSnoozes(0).s1).toBe('2999-01-01T05:00:00.000Z')

    store.sessions.clearSnooze('s1')
    expect(store.sessions.listSnoozes(0)).toEqual({ s2: '2999-01-01T05:00:00.000Z' })
    store.close()
  })

  it('lazily drops a timed snooze whose deadline has passed; keeps null forever', () => {
    const store = new SessionStore(':memory:')
    store.sessions.setSnooze('past', '2000-01-01T00:00:00.000Z')
    store.sessions.setSnooze('forever', null)
    const now = Date.parse('2026-06-19T00:00:00.000Z')
    expect(store.sessions.listSnoozes(now)).toEqual({ forever: null })
    // the expired row was deleted, not just filtered
    expect(store.sessions.listSnoozes(0)).toEqual({ forever: null })
    store.close()
  })

  it('removes a snooze when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(row({ id: 's1' }))
    store.sessions.setSnooze('s1', null)
    store.sessions.purgeSession('s1')
    expect(store.sessions.listSnoozes(0)).toEqual({})
    store.close()
  })
})

describe('SessionStore tab order', () => {
  it('starts empty, upserts per worktree, and clears on an empty list', () => {
    const store = new SessionStore(':memory:')
    expect(store.sessions.listTabOrders()).toEqual({})

    store.sessions.setTabOrder('/repo/a', ['s1', 's2'])
    store.sessions.setTabOrder('/repo/b', ['s9'])
    store.sessions.setTabOrder('/repo/a', ['s2', 's1'])
    expect(store.sessions.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'], '/repo/b': ['s9'] })

    store.sessions.setTabOrder('/repo/b', [])
    expect(store.sessions.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'] })
    store.close()
  })

  it('rejects an empty worktree path', () => {
    const store = new SessionStore(':memory:')
    expect(() => store.sessions.setTabOrder('  ', ['s1'])).toThrow('worktree path is empty')
    store.close()
  })

  it('persists across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.sessions.setTabOrder('/repo/a', ['s2', 's1'])
    a.close()
    const b = new SessionStore(file)
    expect(b.sessions.listTabOrders()).toEqual({ '/repo/a': ['s2', 's1'] })
    b.close()
  })

  it('scrubs a session from every order when it is deleted', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession(row({ id: 's1' }))
    store.sessions.setTabOrder('/repo/a', ['s2', 's1'])
    store.sessions.setTabOrder('/repo/b', ['s1'])

    store.sessions.purgeSession('s1')

    expect(store.sessions.listTabOrders()).toEqual({ '/repo/a': ['s2'] })
    store.close()
  })
})

describe('settings', () => {
  it('returns defaults when nothing was ever saved', () => {
    const store = new SessionStore(':memory:')
    const s = store.settings.getSettings()
    expect(s.roles.coding.accountId).toBe('') // '' = the role's default (claude-code)
    expect(s.roles.background.model).toBe('google/gemini-2.5-flash')
    expect(s.hibernation.memoryPct).toBe(80)
    store.close()
  })

  it('round-trips a saved blob and fills missing keys forward', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    const s = a.settings.getSettings()
    a.settings.setSettings({
      ...s,
      roles: {
        ...s.roles,
        coding: { ...s.roles.coding, accountId: 'native:codex', model: 'gpt-5-codex' },
      },
      hibernation: { ...s.hibernation, memoryPct: 90 },
    })
    a.close()
    const b = new SessionStore(file)
    const loaded = b.settings.getSettings()
    expect(loaded.roles.coding.accountId).toBe('native:codex')
    expect(loaded.roles.coding.model).toBe('gpt-5-codex')
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
    store.conversations.upsertConversations([
      conv('a', { title: 'fix the soft keyboard profiles' }),
      conv('b', { title: 'memory chip breakdown' }),
    ])
    const hits = store.conversations.searchConversations({ query: 'keyboard' })
    expect(hits.map((h) => h.id)).toEqual(['a'])
    store.close()
  })

  it('prefix-matches partial words', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([conv('a', { title: 'podium relay endpoint' })])
    expect(store.conversations.searchConversations({ query: 'rela' }).map((h) => h.id)).toEqual([
      'a',
    ])
    store.close()
  })

  it('filters by projectPath subtree and browses by recency on empty query', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([
      conv('old', { updatedAt: '2026-06-01T00:00:00.000Z' }),
      conv('new', { updatedAt: '2026-06-12T00:00:00.000Z' }),
      conv('other', { projectPath: '/src/zzz' }),
    ])
    const hits = store.conversations.searchConversations({ projectPath: '/src/app' })
    expect(hits.map((h) => h.id)).toEqual(['new', 'old'])
    store.close()
  })

  it('excludes subagent (sidechain) conversations from the resume picker', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([
      conv('top', { title: 'fix the parser' }),
      conv('sub', { title: 'fix the parser subagent', parentConversationId: 'top' }),
    ])
    // Empty-query browse: only the top-level session.
    expect(store.conversations.searchConversations({}).map((h) => h.id)).toEqual(['top'])
    // Keyword search: the subagent matches the term but is still filtered out.
    expect(store.conversations.searchConversations({ query: 'parser' }).map((h) => h.id)).toEqual([
      'top',
    ])
    store.close()
  })

  it('orders search results by recency, not relevance (matches claude --resume)', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([
      conv('older', { title: 'relay endpoint fix', updatedAt: '2026-06-01T00:00:00.000Z' }),
      conv('newer', { title: 'relay endpoint retry', updatedAt: '2026-06-12T00:00:00.000Z' }),
    ])
    // Both match "relay endpoint"; the more recently-active one comes first.
    expect(
      store.conversations.searchConversations({ query: 'relay endpoint' }).map((h) => h.id),
    ).toEqual(['newer', 'older'])
    store.close()
  })

  it('curation (name/summary) survives re-discovery and is searchable', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([conv('a')])
    store.conversations.setConversationMeta('a', {
      name: 'Soft keyboard epic',
      summary: 'shipped; awaiting review',
    })
    store.conversations.upsertConversations([conv('a', { title: 'renamed by discovery' })])
    const [hit] = store.conversations.searchConversations({ query: 'epic' })
    expect(hit?.id).toBe('a')
    expect(hit?.name).toBe('Soft keyboard epic')
    expect(hit?.summary).toBe('shipped; awaiting review')
    store.close()
  })

  it('deleteConversations removes the rows and keeps the FTS index consistent', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([
      conv('a', { title: 'keep this keyboard one' }),
      conv('b', { title: 'remove this keyboard one' }),
    ])
    // Both match before the delete.
    expect(
      store.conversations
        .searchConversations({ query: 'keyboard' })
        .map((h) => h.id)
        .sort(),
    ).toEqual(['a', 'b'])

    store.conversations.deleteConversations(['b'])

    // Browse (empty query, table read) no longer lists the deleted row...
    expect(store.conversations.searchConversations({}).map((h) => h.id)).toEqual(['a'])
    // ...and the FTS index dropped it too (the DELETE trigger keeps it in sync),
    // so a keyword search returns only the survivor — no stale match for 'b'.
    expect(store.conversations.searchConversations({ query: 'keyboard' }).map((h) => h.id)).toEqual(
      ['a'],
    )
    store.close()
  })

  it('deleteConversations is a no-op on an empty id list', () => {
    const store = new SessionStore(':memory:')
    store.conversations.upsertConversations([conv('a')])
    store.conversations.deleteConversations([])
    expect(store.conversations.searchConversations({}).map((h) => h.id)).toEqual(['a'])
    store.close()
  })
})

describe('SessionStore superagent threads', () => {
  it('creates a default global thread and scopes messages by thread', () => {
    const s = new SessionStore(':memory:')
    expect(s.superagent.listSuperagentThreads().some((t) => t.id === 'global')).toBe(true)
    s.superagent.appendSuperagentMessage('global', { role: 'user', content: 'hi' })
    s.superagent.upsertSuperagentThread({ id: 'btw_x', kind: 'btw', originSessionId: 'x' })
    s.superagent.appendSuperagentMessage('btw_x', { role: 'user', content: 'ctx' })
    expect(s.superagent.loadSuperagentMessages('global').map((m) => m.content)).toEqual(['hi'])
    expect(s.superagent.loadSuperagentMessages('btw_x').map((m) => m.content)).toEqual(['ctx'])
    s.close()
  })
  it('defaults message ops to the global thread', () => {
    const s = new SessionStore(':memory:')
    s.superagent.appendSuperagentMessage('global', { role: 'user', content: 'legacy' })
    expect(s.superagent.loadSuperagentMessages().map((m) => m.content)).toEqual(['legacy'])
    s.close()
  })
  it('stores and reads a btw watermark', () => {
    const s = new SessionStore(':memory:')
    s.superagent.upsertSuperagentThread({ id: 'btw_y', kind: 'btw', originSessionId: 'y' })
    s.superagent.setThreadWatermark('btw_y', 'item-42', '2026-06-16T08:00:00Z')
    const t = s.superagent.getSuperagentThread('btw_y')
    expect(t?.watermarkItemId).toBe('item-42')
    expect(t?.watermarkTs).toBe('2026-06-16T08:00:00Z')
    s.close()
  })
  it('clears only the targeted thread', () => {
    const s = new SessionStore(':memory:')
    s.superagent.appendSuperagentMessage('global', { role: 'user', content: 'g' })
    s.superagent.upsertSuperagentThread({ id: 'btw_z', kind: 'btw', originSessionId: 'z' })
    s.superagent.appendSuperagentMessage('btw_z', { role: 'user', content: 'z' })
    s.superagent.clearSuperagentMessages('btw_z')
    expect(s.superagent.loadSuperagentMessages('global').length).toBe(1)
    expect(s.superagent.loadSuperagentMessages('btw_z').length).toBe(0)
    s.close()
  })

  it('tolerates a corrupt tool_calls column instead of dropping the whole thread', () => {
    // One message with unparseable tool_calls must NOT throw out of the row map and
    // blank the entire thread's history — quarantine that field to undefined, keep
    // the message and the rest of the thread.
    const s = new SessionStore(':memory:')
    s.superagent.appendSuperagentMessage('global', { role: 'assistant', content: 'a' })
    s.superagent.appendSuperagentMessage('global', { role: 'assistant', content: 'b' })
    ;(s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE superagent_messages SET tool_calls = '{bad' WHERE content = 'a'")
      .run()

    expect(() => s.superagent.loadSuperagentMessages('global')).not.toThrow()
    const msgs = s.superagent.loadSuperagentMessages('global')
    expect(msgs.map((m) => m.content)).toEqual(['a', 'b'])
    expect(msgs[0]?.toolCalls).toBeUndefined()
    s.close()
  })
})
