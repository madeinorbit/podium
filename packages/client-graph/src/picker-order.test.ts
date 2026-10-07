import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { CommandSessionRow, createCommandPalette, commandLaunchViews } from './command-launch-views'
import { createReferencePicker, chatReferenceSessions, chatMentionMatches } from './chat-context'
import { createLaunchCatalogPicker, launchOptionViews } from './launch-option-views'
import { headerEntities } from './header-entities'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

// The old answer is still available here: the existing live catalog readers.
// Every comparison includes a deliberately wrong answer to prove sensitivity.
for (const scale of [1, 4]) {
  it(`stores reference identities on open/search and does zero catalog work for H at ${scale}x`, () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const stamp = '2026-10-07T00:00:00Z'
    const sessions = Array.from({ length: 64 * scale }, (_, i) => ({ sessionId: `s${i}`, cwd: '/repo', agentKind: 'codex', status: 'live', lastActiveAt: stamp, title: `Session ${i}` }))
    pool.apply({ type: 'replace', rows: [
      ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
      ...sessions.map((_, i) => ({ kind: 'issue' as const, id: `i${i}`, value: { id: `i${i}`, title: 'Task', seq: i, stage: 'in_progress', createdAt: stamp, updatedAt: stamp } })),
    ] })
    const order = observable.box(sessions.map(s => s.sessionId))
    pool.sources.register(['chatSessionOrder', 'chatIssueOrder'], { read: entity => ({ ids: entity === 'chatSessionOrder' ? order.get() : sessions.map((_, i) => `i${i}`) }), dispose() {} })
    const picker = createReferencePicker(pool)
    picker.open()
    expect(picker.sessionIds).toEqual(chatReferenceSessions(pool).sessions.map(s => s.sessionId))
    const assertSameIds = (ids: string[]) => expect(ids).toEqual(picker.sessionIds)
    expect(() => assertSameIds([...picker.sessionIds].reverse())).toThrow()
    picker.search('task')
    expect(picker.issueIds).toEqual(chatMentionMatches(pool, 'task').issues.map(i => i.id))
    expect(picker.issueIds).not.toEqual([])
    let renders = 0
    const stop = autorun(() => { picker.sessionIds; picker.issueIds; picker.sessions; picker.issues; renders++ })
    const rows = vi.spyOn(pool, 'row'), ids = vi.spyOn(pool.queries, 'ids'), sort = vi.spyOn(Array.prototype, 'sort')
    try {
      const before = renders
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 's1', value: { ...sessions[1]!, lastActiveAt: '2026-10-07T01:00:00Z' } }] })
      expect(renders).toBe(before)
      expect(rows.mock.calls.filter(([kind]) => String(kind) === 'chatSessionOrder' || String(kind) === 'chatIssueOrder')).toEqual([])
      expect(rows.mock.calls.filter(([kind]) => kind === 'session')).toHaveLength(1)
      expect(ids).not.toHaveBeenCalled()
      expect(sort).not.toHaveBeenCalled()
      runInAction(() => order.set(['s1', ...sessions.filter(s => s.sessionId !== 's1').map(s => s.sessionId)]))
      expect(picker.sessionIds[0]).toBe('s0')
      picker.open()
      expect(picker.sessionIds[0]).toBe('s1')
    } finally { stop(); rows.mockRestore(); ids.mockRestore(); sort.mockRestore(); picker.close(); pool.dispose() }
  })
}

it('stores new-task catalog order while machine/catalog metadata stays live', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const entities = headerEntities(pool)
  entities.apply(['/a', '/b'].map(path => ({ kind: 'repository' as const, id: path, value: { kind: 'repository', path, worktrees: [] } as never })))
  const activity = observable.map([['/a', 2], ['/b', 1]])
  const query = vi.spyOn(pool.queries, 'activity').mockImplementation(q => activity.get(q.roots[0]!) ?? 0)
  const picker = createLaunchCatalogPicker(pool)
  picker.open()
  expect(picker.catalog()).toEqual(launchOptionViews(pool).catalog())
  expect(() => expect(picker.catalog().repoPaths).toEqual(['/b', '/a'])).toThrow()
  let runs = 0
  const stop = autorun(() => { picker.catalog(); runs++ })
  try {
    const before = runs
    query.mockClear()
    runInAction(() => activity.set('/b', 3))
    expect(runs).toBe(before)
    expect(query).not.toHaveBeenCalled()
    expect(picker.catalog().repoPaths).toEqual(['/a', '/b'])
    entities.apply([{ kind: 'machine', id: 'm', value: { id: 'm', name: 'Host', online: true } as never }])
    expect(picker.catalog().machines.map(m => m.id)).toEqual(['m'])
    picker.open()
    expect(picker.catalog().repoPaths).toEqual(['/b', '/a'])
  } finally { stop(); query.mockRestore(); pool.dispose() }
})

it('stores palette recent commands on open and keeps the addressed rows live', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const a = { sessionId: 'a', cwd: '/repo', title: 'A', agentKind: 'codex', status: 'live', lastActiveAt: '2026-10-07T02:00:00Z' }
  const b = { ...a, sessionId: 'b', title: 'B', lastActiveAt: '2026-10-07T01:00:00Z' }
  pool.apply({ type: 'replace', rows: [a, b].map(value => ({ kind: 'session' as const, id: value.sessionId, value })) })
  pool.sources.register(['commandCatalog', 'commandWindow'], { read: entity => entity === 'commandCatalog'
    ? { sessions: ['a', 'b'], issues: [], repositories: [], repos: [], worktrees: [], machines: [] }
    : { paletteOpen: true, pins: { repos: [], worktrees: [] }, selectedIssueId: null, openIssueId: null, selectedWorktree: null, paneA: null, recentFiles: [], sidebarSettings: {} } as never, dispose() {} })
  const picker = createCommandPalette(pool)
  picker.open()
  const old = commandLaunchViews(pool).palette()
  if (!old || old === LOADING) throw new Error('Palette did not open')
  expect(picker.palette()).toMatchObject(old)
  expect(picker.recent).toEqual([{ kind: 'session', id: 'a' }, { kind: 'session', id: 'b' }])
  expect(() => expect(picker.recent).toEqual([{ kind: 'session', id: 'b' }])).toThrow()
  let runs = 0
  const row = new CommandSessionRow(pool, 'b')
  const stop = autorun(() => { picker.palette(); picker.sessions; row.presentation; runs++ })
  const ids = vi.spyOn(pool.queries, 'ids'), rows = vi.spyOn(pool, 'row')
  try {
    const before = runs
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'b', value: { ...b, lastActiveAt: '2026-10-07T03:00:00Z' } }] })
    expect(runs).toBe(before)
    expect(ids).not.toHaveBeenCalled()
    expect(rows.mock.calls.filter(([kind]) => kind === 'session')).toHaveLength(1)
    expect(picker.recent[0]).toEqual({ kind: 'session', id: 'a' })
    picker.open()
    expect(picker.recent[0]).toEqual({ kind: 'session', id: 'b' })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'b', value: { ...b, title: 'Renamed' } }] })
    expect(picker.session('b')).toMatchObject({ title: 'Renamed' })
  } finally { stop(); ids.mockRestore(); rows.mockRestore(); picker.close(); pool.dispose() }
})
