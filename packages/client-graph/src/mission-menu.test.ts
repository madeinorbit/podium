import type { SessionView } from '@podium/client-core/session-values'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { reposToViews } from '@podium/client-core/values'
import { asMachineId, asRepoId, handoffAvailability, handoffSource } from '@podium/model/browser'
import type { HeaderRows } from './header-schema'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { missionView, readMissionActionInputs } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const stamp = '2026-10-01T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })
function fixture(scale: number, capable = 2) {
  const issue = (id: string) => ({ id, seq: 1, stage: 'done', title: id, description: '', deps: [],
    parentId: null, repoPath: '/menu', createdAt: stamp, updatedAt: stamp,
    closedAt: stamp, readAt: stamp }) as unknown as IssueNavigationModel
  const session = (id: string, owner = 'chosen', handoff = false) => ({ sessionId: id, issueId: owner,
    cwd: '/menu', title: id, agentKind: 'codex', status: 'exited', archived: true,
    harnessHandoff: handoff, createdAt: stamp, lastActiveAt: stamp, unread: false }) as unknown as SessionView
  const rows = [issue('chosen'), ...Array.from({ length: 64 * scale }, (_, i) => issue(`other-${i}`))]
  const seats = Array.from({ length: 32 * scale }, (_, i) => session(`history-${i}`, 'chosen', i < capable))
  seats.push(session('picked', 'chosen'))
  const input = new Map<string, object>([...rows.map(row => [`issue:${row.id}`, row] as const),
    ...seats.map(row => [`session:${row.sessionId}`, row] as const)])
  const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
    { load, summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {} })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [...rows.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))] })
  return { pool, load, input, session, view: missionView(pool) }
}
function observe<T>(read: () => T) {
  let value!: T
  const stop = autorun(() => { value = read() })
  return { get value() { return value }, stop }
}

it('an open task menu reads its issue, keeps exact cascade counts and never reads hidden history or a global catalog at 1x/4x', () => {
  const work: number[] = []
  for (const scale of [1, 4]) {
    const { pool, view, load } = fixture(scale)
    // The menu is opened from a drawn issue row, whose unread badge already
    // observes the maintained activity summary. Its cold history stays cold.
    const badge = observe(() => pool.issueObject('chosen').unread)
    load.mockClear()
    const row = vi.spyOn(pool, 'row'), catalog = vi.spyOn(pool.queries, 'ids')
    const menu = observe(() => readMissionActionInputs(view, ['chosen']))
    try {
      expect(menu.value).toMatchObject({ issues: [{ id: 'chosen', sessionSummary: { total: 32 * scale + 1 } }],
        sessions: [], handoff: { blocker: 'multiple-sessions' } })
      expect(load).not.toHaveBeenCalled()
      expect(row.mock.calls.some(([kind]) => kind === 'session')).toBe(false)
      expect(catalog).not.toHaveBeenCalled()
      work.push(row.mock.calls.length)
    } finally { menu.stop(); badge.stop() }
  }
  expect(work[1]).toBe(work[0])
})

it('a session menu reads only its addressed session and attached issue, including cold history at 1x/4x', () => {
  const work: number[] = []
  for (const scale of [1, 4]) {
    const { pool, view, load } = fixture(scale)
    const row = vi.spyOn(pool, 'row'), attached = vi.spyOn(view, 'attached')
    const menu = observe(() => readMissionActionInputs(view, [], 'picked'))
    try {
      expect(menu.value).toBe(LOADING)
      expect(pool.hydrate()).toBe(1)
      expect(menu.value).toMatchObject({ session: { sessionId: 'picked' }, issue: { id: 'chosen' }, sessions: [] })
      expect(load.mock.calls).toEqual([['session', 'picked']])
      expect(row.mock.calls.filter(([kind]) => kind === 'session').every(([, id]) => id === 'picked')).toBe(true)
      expect(attached).not.toHaveBeenCalled()
      work.push(row.mock.calls.length)
    } finally { menu.stop() }
  }
  expect(work[1]).toBe(work[0])
})

it('loads the sole capable archived sender and updates eligibility after capability and ownership changes', () => {
  const { pool, view, load, session } = fixture(4, 1)
  const menu = observe(() => readMissionActionInputs(view, ['chosen']))
  try {
    pool.hydrate()
    expect(menu.value).toMatchObject({ handoff: { session: { sessionId: 'history-0', archived: true } } })
    expect(load.mock.calls).toEqual([['issue', 'chosen'], ['session', 'history-0']])
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-1', value: session('history-1', 'chosen', true) }] })
    expect(menu.value).toMatchObject({ handoff: { blocker: 'multiple-sessions' } })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-1', value: session('history-1', 'elsewhere', true) }] })
    expect(menu.value).toMatchObject({ handoff: { session: { sessionId: 'history-0' } } })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-0', value: session('history-0') }] })
    expect(menu.value).toMatchObject({ handoff: { blocker: 'no-agent-session' } })
  } finally { menu.stop() }
})

it('does not demand handoff catalogs or the attached issue when the feature is hidden', () => {
  const { pool, view, load } = fixture(4)
  const ids = vi.spyOn(pool.headerViews, 'ids'), machines = vi.spyOn(pool.headerViews, 'machines')
  const menu = observe(() => readMissionActionInputs(view, [], 'picked', false))
  try {
    pool.hydrate()
    expect(menu.value).toMatchObject({ session: { sessionId: 'picked' }, issues: [], repos: [], machines: [] })
    expect(load.mock.calls).toEqual([['session', 'picked']])
    expect(ids).not.toHaveBeenCalled(); expect(machines).not.toHaveBeenCalled()
  } finally { menu.stop() }
})

it('keeps source lanes and targets exact without reading hidden repositories or worktrees, including headless and cwd drift', async () => {
  const work: Array<{ rows: number; elements: number }> = []
  for (const headless of [false, true]) for (const scale of [1, 4]) {
    const { pool, view, input } = fixture(scale)
    const repoId = asRepoId('menu-repo')
    const target: HeaderRows['repository'] = { kind: 'repository', path: '/target', repoId,
      machineId: asMachineId('source'),
      worktrees: [{ path: '/menu', branch: 'issue' }, ...Array.from({ length: 128 * scale }, (_, i) => ({ path: `/target/history-${i}` }))] }
    const clone: HeaderRows['repository'] = { kind: 'repository', path: '/clone', repoId,
      machineId: asMachineId('destination'), worktrees: Array.from({ length: 128 * scale }, (_, i) => ({ path: `/clone/history-${i}` })) }
    const others: HeaderRows['repository'][] = Array.from({ length: 128 * scale }, (_, i) => ({
      kind: 'repository', path: `/other/${i}`, worktrees: [], originUrl: `https://example.test/other-${i}`,
    }))
    const picked = { ...input.get('session:picked'), cwd: '/menu', machineId: asMachineId('source'), headless } as SessionView
    const chosen = { ...input.get('issue:chosen'), worktreePath: '/menu' } as IssueNavigationModel
    input.set('session:picked', picked); input.set('issue:chosen', chosen)
    pool.apply({ type: 'update', rows: [
      { kind: 'session', id: 'picked', value: picked }, { kind: 'issue', id: 'chosen', value: chosen },
      { kind: 'worktree', id: '/menu', value: { path: '/menu', repoPath: '/target', repoId, repoName: 'Menu' } },
      { kind: 'worktree', id: '/target', value: { path: '/target', repoPath: '/target', repoId, repoName: 'Menu', isMain: true } },
    ] })
    pool.header.apply([
      { kind: 'repository', id: 'target', value: target }, { kind: 'repository', id: 'clone', value: clone },
      ...others.map((value, i) => ({ kind: 'repository' as const, id: `other-${i}`, value })),
      { kind: 'machine', id: 'destination', value: { id: asMachineId('destination'), name: 'Destination', hostname: 'destination', lastSeenAt: stamp, online: true } },
    ])
    const row = vi.spyOn(pool, 'row'), repoRow = vi.spyOn(pool.headerViews, 'row'), ids = vi.spyOn(pool.headerViews, 'ids')
    let menu!: ReturnType<typeof observe<ReturnType<typeof readMissionActionInputs>>>
    const measured = await measureWork(async () => insideReader('menu', () => {
      menu = observe(() => readMissionActionInputs(view, [], 'picked'))
      pool.hydrate()
    }), { pool })
    try {
      const value = menu.value
      expect(value).not.toBe(LOADING)
      if (value === LOADING || !value.session) throw new Error('Menu did not load')
      expect(value.repos.map(repo => [repo.path, repo.worktrees.map(tree => tree.path)]))
        .toEqual([['/target', ['/menu']], ['/clone', []]])
      expect(handoffAvailability(value.session, reposToViews(value.repos), value.machines, value.issue))
        .toEqual(handoffAvailability(value.session, reposToViews([target, clone, ...others]), value.machines, value.issue))
      expect(value.machines).toHaveLength(1)
      expect(ids).not.toHaveBeenCalled()
      expect(repoRow.mock.calls.filter(([kind]) => kind === 'repository').every(([, id]) => id === 'target' || id === 'clone')).toBe(true)
      work.push({ rows: measured.work.rows ?? 0, elements: measured.work.elements })
      row.mockClear()
      pool.header.apply([{ kind: 'repository', id: 'other-0', value: { ...others[0]!, branch: 'changed' } }])
      expect(row).not.toHaveBeenCalled()
      const drift = { ...picked, cwd: '/target/src' }
      input.set('session:picked', drift)
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'picked', value: drift }] })
      const drifted = menu.value
      if (drifted === LOADING || !drifted.session) throw new Error('Drifted menu did not load')
      const boundedSource = handoffSource(drifted.session, reposToViews(drifted.repos), drifted.issue)
      const fullSource = handoffSource(drifted.session, reposToViews([target, clone, ...others]), drifted.issue)
      expect(boundedSource?.worktreePath).toBe('/menu')
      expect(boundedSource?.via).toBe('issue')
      expect(boundedSource?.worktreePath).toBe(fullSource?.worktreePath)
    } finally { menu.stop() }
  }
  expect(work[1]).toEqual(work[0])
  expect(work[3]).toEqual(work[2])
})
