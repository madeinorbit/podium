import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import type { EngineState, NavigationTopologyDelta } from '@podium/client-core/engine'
import { loadingNavigationProvider } from '@podium/client-core/engine'
import { Reactions } from '../../client-core/src/engine/reactions'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { createPoolNavigationProvider } from './navigation-provider'
import { NAVIGATION_SUMMARIES } from './navigation-schema'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

const old = '2020-01-01T00:00:00Z'
const lane = (path: string, projectIndex = 0, patch: object = {}): RowRecord => ({ kind: 'worktree', id: path,
  value: { path, repoId: path, repoPath: path, repoName: path, isMain: true, projectRoot: true, projectIndex, ...patch } } as RowRecord)
const session = (id: string, cwd = '/old', patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, displayRef: 'POD-1-A', cwd, title: id, status: 'exited', archived: true,
  agentKind: 'codex', createdAt: old, lastActiveAt: old, ...patch,
} } as RowRecord)
function fixture(rows: RowRecord[]) {
  let source = createColdIndex(SCHEMA, NAVIGATION_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    cold: () => source, load: () => undefined, summaries: NAVIGATION_SUMMARIES,
    worklist: 'demand', schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  return { pool, provider: createPoolNavigationProvider(pool),
    publish(event: RowSourceEvent) { source.apply(event); pool.apply(event) },
    rebuild(rows: RowRecord[]) {
      source = createColdIndex(SCHEMA, NAVIGATION_SUMMARIES)
      source.apply({ type: 'replace', rows })
      pool.apply({ type: 'update', rows })
    } }
}

it('answers registered roots and the ordered fallback without projecting repositories', () => {
  const f = fixture([lane('/late', 4), lane('/old', 0), lane('/old/deep/', 1),
    { kind: 'worktree', id: 'raw-repo', value: { prefix: 'POD' } } as unknown as RowRecord])
  try {
    expect(f.provider.firstWorktree!()).toBe('/old')
    expect(f.provider.registeredWorktree!('raw-repo')).toBe(false)
    expect(f.provider.worktreeForCwd!('/old/deep/file')).toBe('/old/deep/')
    expect(f.provider.worktreeForCwd!('/old/deep')).toBe('/old')
    expect(f.provider.worktreeForCwd!('/old/')).toBe('/old')
    expect(f.provider.worktreeForCwd!('/oldish')).toBeNull()
    f.publish({ type: 'update', rows: [lane('/late', -1)] })
    expect(f.provider.firstWorktree!()).toBe('/late')
    f.publish({ type: 'update', rows: [{ kind: 'worktree', id: '/late', value: undefined }] })
    expect(f.provider.firstWorktree!()).toBe('/old')
    f.publish({ type: 'replace', rows: [] })
    expect(f.provider.firstWorktree!()).toBeNull()
  } finally { f.pool.dispose() }
})

it('keeps the loading port addressed before the pool import resolves', () => {
  const state = { navigation: loadingNavigationProvider, reposLoaded: true, selectedWorktree: '/old' } as unknown as EngineState
  Object.defineProperty(state, 'repos', { get() { throw new Error('global repositories during loading') } })
  const publish = vi.fn()
  const reactions = new Reactions({ state: () => state, publish, hub: {} as never, notices: {} as never,
    isVisible: () => false, markSessionRead: vi.fn(), markIssueRead: vi.fn() })
  try { expect(reactions.worktreeFallback()).toBe(false); expect(publish).not.toHaveBeenCalled() }
  finally { reactions.dispose() }
})

it('anchors archived/headless/shell sessions with invalid timestamps and releases addressed path observers', () => {
  const f = fixture([session('anchor', '/unlisted/sub', { headless: true, agentKind: 'shell', lastActiveAt: '' })])
  let value = false, runs = 0
  const stop = autorun(() => { runs++; value = f.provider.hasWorktreeSession!('/unlisted') === true })
  try {
    expect(value).toBe(true)
    expect(f.provider.hasWorktreeSession!('/unlisted/')).toBe(false)
    f.publish({ type: 'update', rows: [session('anchor', '/unlisted/sub', { headless: true, agentKind: 'shell', lastActiveAt: old })] })
    expect(runs).toBe(1)
    f.publish({ type: 'update', rows: [session('anchor', '/other', { headless: true, agentKind: 'shell' })] })
    expect(value).toBe(false); expect(runs).toBe(2)
    stop()
    f.publish({ type: 'update', rows: [session('anchor', '/unlisted/sub')] })
    expect(runs).toBe(2)
  } finally { stop(); f.pool.dispose() }
})

it('reports changed topology keys, first sight, eviction and cold collapse swaps', () => {
  const twin = { displayRef: 'POD-2-A', resume: { kind: 'codex-thread', value: 'same' } }
  const f = fixture([session('a', '/old', twin), session('z', '/dest', { ...twin, status: 'hibernated' })])
  const deltas: NavigationTopologyDelta[] = []
  const stop = f.provider.onTopology!(delta => { if (delta) deltas.push(delta) })
  try {
    f.publish({ type: 'update', rows: [session('z', '/dest', { ...twin, status: 'hibernated', title: 'Rename' })] })
    expect(deltas).toEqual([])
    f.publish({ type: 'update', rows: [session('a', '/old', { ...twin, status: 'hibernated', lastActiveAt: '2020-01-02' })] })
    const changes = deltas.flatMap(delta => delta.sessions)
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', before: undefined, after: expect.objectContaining({ cwd: '/old' }) }),
      expect.objectContaining({ id: 'z', before: expect.objectContaining({ cwd: '/dest' }), after: undefined }),
    ]))
    expect(f.provider.hasWorktreeSession!('/old')).toBe(true)
    expect(f.provider.hasWorktreeSession!('/dest')).toBe(false)
    deltas.length = 0
    f.publish({ type: 'update', rows: [session('new', '/new', { displayRef: 'POD-3-A' })] })
    expect(deltas.flatMap(delta => delta.sessions)).toEqual([expect.objectContaining({ id: 'new', before: undefined })])
    deltas.length = 0
    f.publish({ type: 'update', rows: [{ kind: 'session', id: 'new', value: undefined }] })
    expect(deltas.flatMap(delta => delta.sessions)).toEqual([expect.objectContaining({ id: 'new', after: undefined })])
  } finally { stop(); f.pool.dispose() }
})

it('preserves same-ID relocations in replacement publications', () => {
  const f = fixture([session('target')]), changed = vi.fn()
  const stop = f.provider.onTopology!(changed)
  try {
    f.publish({ type: 'replace', rows: [session('target', '/dest'), session('new', '/other')] })
    const changes = changed.mock.calls.flatMap(([delta]) => delta?.sessions ?? [])
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'target', before: expect.objectContaining({ cwd: '/old' }), after: expect.objectContaining({ cwd: '/dest' }) }),
      expect.objectContaining({ id: 'new', before: undefined }),
    ]))
  } finally { stop(); f.pool.dispose() }
})

it('captures warm same-ID moves before a fresh source reaches table observers', () => {
  const f = fixture([session('target', '/old', { archived: false, status: 'live' })])
  const changed = vi.fn(), stop = f.provider.onTopology!(changed)
  try {
    expect(f.pool.tables.session.has('target')).toBe(true)
    f.rebuild([session('target', '/dest', { archived: false, status: 'live' })])
    expect(changed.mock.calls.flatMap(([delta]) => delta?.sessions ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'target', before: expect.objectContaining({ cwd: '/old' }), after: expect.objectContaining({ cwd: '/dest' }) }),
    ]))
  } finally { stop(); f.pool.dispose() }
})

it('keeps one move, fallback, path lookup and unrelated heartbeat flat at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture([lane('/old', 0), lane('/dest', 1), session('target'),
      ...Array.from({ length: scale * 128 }, (_, n) => lane(`/foreign-${n}`, n + 2)),
      ...Array.from({ length: scale * 128 }, (_, n) => session(`history-${n}`, `/foreign-${n}`, { displayRef: `POD-${n + 2}-A` })),
    ])
    const calls = vi.spyOn(f.pool.queries, 'ids'), rows = vi.spyOn(f.pool, 'row')
    let changes: NavigationTopologyDelta['sessions'] = []
    const stop = f.provider.onTopology!(delta => { changes = [...changes, ...(delta?.sessions ?? [])] })
    const info = vi.fn()
    const state = { navigation: f.provider, reposLoaded: true, selectedWorktree: '/old', selectedIssueId: null,
      view: 'workspace', paneA: 'target', paneB: null, split: false, workspaces: {}, fileTabs: [] } as unknown as EngineState
    Object.defineProperty(state, 'repos', { get() { throw new Error('global repository read') } })
    const reactions = new Reactions({ state: () => state, publish: patch => Object.assign(state, patch),
      hub: {} as never, notices: { info } as never, isVisible: () => true, markSessionRead: vi.fn(), markIssueRead: vi.fn() })
    try {
      const first = await measureWork(() => insideReader('navigation path', () => runInAction(() => {
        expect(f.provider.worktreeForCwd!('/dest/src')).toBe('/dest')
        state.selectedWorktree = '/gone'
        expect(reactions.worktreeFallback()).toBe(true)
        expect(state.selectedWorktree).toBe('/old')
      })), { pool: f.pool })
      const move = await measureWork(() => insideReader('navigation move', () => {
        f.publish({ type: 'update', rows: [session('target', '/dest')] })
        runInAction(() => expect(reactions.worktreeFollow(changes)).toBe(true))
      }), { pool: f.pool })
      expect(state.selectedWorktree).toBe('/dest'); expect(info).not.toHaveBeenCalled()
      changes = []
      const unrelated = await measureWork(() => insideReader('navigation heartbeat', () => {
        f.publish({ type: 'update', rows: [session('history-0', '/foreign-0', { displayRef: 'POD-2-A', lastActiveAt: '2020-01-02' })] })
      }), { pool: f.pool })
      expect(changes).toEqual([]); expect(calls).not.toHaveBeenCalled()
      expect(rows.mock.calls.filter(([kind]) => kind === 'session').every(([, id]) => id === 'target' || id === 'history-0')).toBe(true)
      return { first: first.work, move: move.work, unrelated: unrelated.work }
    } finally { stop(); reactions.dispose(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('navigation work 1x/4x', JSON.stringify({ first, second }))
  for (const action of ['first', 'move', 'unrelated'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action][counter]).toBe(first[action][counter])
})
