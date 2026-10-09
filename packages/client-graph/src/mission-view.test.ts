import { omitGone } from './lookup'
import { autorun, runInAction } from 'mobx'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { IssueNavigationModel } from '@podium/client-core/values'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from './pool'
import { missionView, readMissionHandoff, readMissionView, readWorkspaceMission, settled } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { SHELL_SUMMARIES } from './shell-schema'
import { createPoolProjection } from './runtime-pool'
import { LOADING } from './worklist/rollup'
import { sessionSeats } from './session-seats'

const stamp = '2026-10-01T12:00:00Z', now = Date.parse(stamp)
const coldRoot = () => issue('root', { stage: 'done', closedAt: '2026-09-20T12:00:00Z', updatedAt: '2026-09-20T12:00:00Z' })
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })
const issue = (id: string, patch: Record<string, unknown> = {}) => ({ id, seq: 1, stage: 'in_progress', title: 'Mission', description: '',
  deps: [], parentId: null, repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp, ...patch }) as unknown as IssueNavigationModel
const session = (sessionId: string, issueId: string, patch: Record<string, unknown> = {}) => ({ sessionId, issueId, cwd: '/synthetic',
  title: 'Agent', name: 'Named agent', agentKind: 'codex', status: 'exited', archived: true, createdAt: stamp, lastActiveAt: stamp,
  readAt: stamp, unread: false, ...patch }) as unknown as SessionView
function tracked<T>(read: () => T): T { let value!: T; const stop = autorun(() => { value = read() }); stop(); return value }
function open(rows: IssueNavigationModel[], seats: SessionView[], summaries: { issue: readonly string[]; session: readonly string[] } = MISSION_VIEW_SUMMARIES) {
  const input = new Map<string, object>([...rows.map(row => [`issue:${row.id}`, row] as const), ...seats.map(row => [`session:${row.sessionId}`, row] as const)])
  const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, { load, summaries, schedule: () => () => {} })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [...rows.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))] })
  return { pool, load, reader: missionView(pool) }
}

it.each([
  ['workspace', (reader: ReturnType<typeof missionView>) => readWorkspaceMission(reader, 'root', 'root')],
  ['mission pane', (reader: ReturnType<typeof missionView>) => readMissionView(reader, 'root')],
  ['handoff', (reader: ReturnType<typeof missionView>) => readMissionHandoff(reader, 'root')],
] as const)('renders a cold %s history as loading and recovers after hydration', (_name, read) => {
  // The shell makes an archived session's display summary usable before its
  // handoff/prompt history is resident, just as the production workspace does.
  const history = [session('old', 'root'), session('older', 'root'), session('oldest', 'root')]
  const { pool, reader } = open([coldRoot()], history, {
    issue: MISSION_VIEW_SUMMARIES.issue,
    session: [...new Set([...MISSION_VIEW_SUMMARIES.session, ...SHELL_SUMMARIES.session])],
  })
  expect(tracked(() => reader.issue('root'))).toBe(LOADING)
  expect(pool.hydrate()).toBe(1)
  expect(pool.tables.session.has('old')).toBe(false)
  const projection = createPoolProjection(pool, () => read(reader))
  const stop = projection.subscribe(() => {})
  const Surface = () => createElement('output', null, projection.getSnapshot() === LOADING ? 'Loading' : 'Ready')
  try {
    expect(renderToStaticMarkup(createElement(Surface))).toBe('<output>Loading</output>')
    expect(pool.hydrate()).toBe(history.length)
    expect(renderToStaticMarkup(createElement(Surface))).toBe('<output>Ready</output>')
    expect(projection.getSnapshot()).not.toBe(LOADING)
    expect(tracked(() => reader.history('root'))).toMatchObject({ count: 3, roster: 3 })
  } finally { stop(); projection.dispose() }
})

it('preserves real history errors at the workspace reader boundary', () => {
  const { pool, reader } = open([issue('root')], [session('old', 'root')])
  const failure = new Error('Broken history')
  vi.spyOn(pool.sessionObject('old'), 'moved', 'get').mockImplementation(() => { throw failure })
  const projection = createPoolProjection(pool, () => readWorkspaceMission(reader, 'root', 'root'))
  try { expect(() => projection.getSnapshot()).toThrow(failure) }
  finally { projection.dispose() }
})

it('uses archived-inclusive relations, small scalar summaries and one batched load for cold display', () => {
  const { pool, load, reader } = open([coldRoot()], [session('old', 'root')])
  expect(pool.tables.session.has('old')).toBe(false)
  expect(tracked(() => [...pool.graph.many('issue', 'root', 'missionSessions')])).toEqual(['old'])
  const summary = tracked(() => omitGone(pool.row('session', 'old', 'summary')))
  expect(summary).toMatchObject({ sessionId: 'old', issueId: 'root', archived: true })
  expect(summary).not.toHaveProperty('name'); expect(summary).not.toHaveProperty('title')
  expect(tracked(() => reader.issue('root'))).toBe(LOADING)
  expect(pool.hydrate()).toBe(1); load.mockClear()
  expect(tracked(() => readMissionView(reader, 'root'))).toBe(LOADING)
  expect(tracked(() => readMissionView(reader, 'root'))).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1); expect(load).toHaveBeenCalledTimes(1)
  const values = tracked(() => readMissionView(reader, 'root'))
  expect(values).not.toBe(LOADING)
  if (values === LOADING) throw new Error('Unsettled fixture')
  expect(values.archivedCount).toBe(1)
  // The list is its own read, made only while the archived section is open.
  const archived = tracked(() => reader.archive('root', 'full'))
  if (archived === LOADING) throw new Error('Unsettled archive')
  expect(archived.map(session => session.sessionId)).toEqual(['old'])
  expect(archived[0]?.name).toBe('Named agent')
})

it('a missing declared cold summary cannot invent an empty roster', () => {
  const { pool, load, reader } = open([coldRoot()], [session('old', 'root')])
  expect(tracked(() => reader.issue('root'))).toBe(LOADING)
  expect(pool.hydrate()).toBe(1); load.mockClear()
  vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
  expect(tracked(() => readMissionView(reader, 'root'))).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(load).toHaveBeenCalledTimes(1)
})

it('counts a closed archive without observing prompt, activity or handoff history', () => {
  const { pool, reader } = open([coldRoot()], [
    session('drawn', 'root'), session('headless', 'root', { headless: true }),
    session('shell', 'root', { agentKind: 'shell' }),
  ])
  expect(tracked(() => settled(() => reader.facts('root').visible))).toBe(LOADING)
  expect(pool.hydrate()).toBe(1)
  const history = vi.spyOn(reader, 'readHistory')
  let count: number | typeof LOADING = LOADING
  const stop = autorun(() => { count = reader.archiveCount(reader.deck('root')) })
  try {
    expect(count).toBe(LOADING)
    expect(pool.hydrate()).toBe(3)
    expect(count).toBe(1)
    expect(history).not.toHaveBeenCalled()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'headless', value: session('headless', 'root') }] })
    pool.hydrate()
    expect(count).toBe(2)
    expect(history).not.toHaveBeenCalled()
  } finally { stop() }
})

it('shares the observed seat flag when pane reads change a present session', () => {
  const live = session('live', 'root', { archived: false, status: 'live' })
  const { pool, reader } = open([issue('root')], [live])
  const stopSeat = autorun(() => { sessionSeats(pool).seat('live') })
  let count: number | typeof LOADING = LOADING
  const stopArchive = autorun(() => { count = reader.historyRosterCount('root') })
  const raw = vi.spyOn(reader, 'rawSession')
  try {
    expect(count).toBe(0)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'live', value: { ...live, readAt: null, unread: true } }] })
    expect(count).toBe(0)
    expect(raw).not.toHaveBeenCalled()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'live', value: { ...live, archived: true } }] })
    pool.hydrate()
    expect(count).toBe(1)
  } finally { stopArchive(); stopSeat() }
})

it('passes an unloaded child through its own and every ancestor rollup', () => {
  const { pool, reader } = open([issue('root'), issue('branch', { parentId: 'root' }),
    issue('leaf', { ...coldRoot(), id: 'leaf', parentId: 'branch' })], [])
  const deck = reader.deck('root'), seen: unknown[] = []
  const stop = autorun(() => { seen.push(['leaf', 'branch', 'root'].map(id => deck.model(id).rollup)) })
  try {
    expect(seen).toEqual([[LOADING, LOADING, LOADING]])
    expect(pool.hydrate()).toBe(1)
    expect(seen.at(-1)).toMatchObject([
      { tasks: 1, done: 1 }, { tasks: 2, done: 1 }, { tasks: 3, done: 1 },
    ])
  } finally { stop() }
})

it('keeps crew presentation unobserved when a hidden row asks only for its collapsed task count', () => {
  const { reader } = open([issue('root'), issue('child', { parentId: 'root' })], [
    session('crew', 'child', { archived: false, status: 'live' }),
  ])
  const roster = vi.spyOn(reader, 'roster')
  let count = -1
  const stop = autorun(() => { count = reader.deck('root').model('root').collapsedSummary.tasks })
  try {
    expect(count).toBe(1)
    expect(roster).not.toHaveBeenCalled()
  } finally { stop() }
})

it('bounds parent child-list reads for earliest-child parenting at 1x and 4x', () => {
  for (const scale of [1, 4]) {
    const children = Array.from({ length: 128 * scale }, (_, index) =>
      issue(`child-${index}`, { parentId: 'root', seq: index + 2 }))
    const { pool, reader } = open([issue('root'), ...children], [])
    const many = vi.spyOn(pool.graph, 'many')
    const stop = autorun(() => { expect(reader.deck('root').topology).not.toBe(LOADING) })
    try {
      // Membership, topology and the parent's scalar question each consume
      // this bucket a bounded number of times, independent of its width.
      expect(many.mock.calls.filter(([entity, id, relation]) =>
        entity === 'issue' && id === 'root' && relation === 'children').length).toBeLessThanOrEqual(4)
    } finally { stop(); many.mockRestore() }
  }
})

it('renders an addressed dependency label without loading that target\'s unrelated dependents', () => {
  const root = issue('root', { blocked: true, deps: [{ id: 'blocker', type: 'blocks' }] })
  const { pool, reader } = open([root, issue('blocker', { seq: 2, stage: 'backlog' }),
    issue('unrelated', { ...coldRoot(), id: 'unrelated', deps: [{ id: 'blocker', type: 'related' }] })], [])
  const read = vi.spyOn(pool, 'row')
  expect(tracked(() => settled(() => reader.note(root, true)))).toMatchObject({ kind: 'blocked', short: '#2', full: 'Blocked by #2' })
  expect(read.mock.calls.some(([entity, id]) => entity === 'issue' && id === 'unrelated')).toBe(false)
})

it('requests cold mission ancestry together without changing the shared root answer', () => {
  const rows = Array.from({ length: 100 }, (_, index) => issue(`ancestor-${index}`, {
    ...coldRoot(), id: `ancestor-${index}`, parentId: index ? `ancestor-${index - 1}` : null,
  }))
  const { pool, load, reader } = open(rows, [])
  expect(tracked(() => reader.rootFor('ancestor-99'))).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(100)
  expect(tracked(() => reader.rootFor('ancestor-99'))).toBe('ancestor-0')
})

it('reads only the selected mission attachment edges as unrelated sessions grow', () => {
  const { pool, reader } = open([issue('root'), issue('other')], [session('own', 'root', { archived: false, status: 'live' }),
    ...Array.from({ length: 1000 }, (_, index) => session(`other-${index}`, 'other', { archived: false, status: 'live' }))])
  const read = vi.spyOn(pool, 'row')
  const values = tracked(() => readMissionView(reader, 'root'))
  expect(values).not.toBe(LOADING)
  expect(read.mock.calls.filter(([entity]) => entity === 'session').every(([, id]) => id === 'own')).toBe(true)
  expect(read.mock.calls.some(([, , absent]) => String(absent) === 'peek')).toBe(false)
  runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'own', value: session('own', 'other', { archived: false, status: 'live' }) }] }))
  const moved = tracked(() => readMissionView(reader, 'root'))
  if (moved === LOADING) throw new Error('Unsettled fixture')
  expect(moved.rows[0]?.sessions).toEqual([])
})

it('counts every same-type dependency while preserving first-origin navigation', () => {
  const deps = [
    { id: 'first', type: 'discovered-from' }, { id: 'second', type: 'discovered-from' },
    { id: 'first', type: 'related' }, { id: 'second', type: 'related' },
  ]
  const { pool, reader } = open([issue('first', { stage: 'backlog' }), issue('second', { stage: 'backlog' }),
    issue('source', { stage: 'proposed', deps })], [])
  expect(tracked(() => pool.graph.one('issue', 'source', 'discoveredFrom'))).toBe('first')
  expect(tracked(() => [...pool.graph.many('issue', 'source', 'pageDependencies')]).sort()).toEqual(['first', 'second'])
  expect(tracked(() => reader.issue('second'))).toMatchObject({ dependents: [
    { id: 'source', type: 'discovered-from' }, { id: 'source', type: 'related' },
  ] })
  const values = tracked(() => readMissionView(reader, 'second'))
  expect(values).not.toBe(LOADING)
  if (values === LOADING) throw new Error('Unsettled fixture')
  expect(values.progress.total).toBe(0)
  runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'source',
    value: issue('source', { stage: 'proposed', deps: deps.filter(dep => dep.id !== 'second') }) }] }))
  expect(tracked(() => pool.graph.size('issue', 'second', 'pageDependents'))).toBe(0)
  expect(tracked(() => reader.issue('second'))).toMatchObject({ dependents: [] })
  const removed = tracked(() => readMissionView(reader, 'second'))
  if (removed === LOADING) throw new Error('Unsettled fixture')
  expect(removed.progress.total).toBe(1)
})

it('keeps raw issue member IDs and the collapsed winner in its original roster position', () => {
  const resume = { kind: 'codex-thread', value: 'same-thread' }
  const { pool, reader } = open([issue('root')], [
    session('a-old', 'root', { archived: false, status: 'hibernated', resume }),
    session('m-other', 'root', { archived: false, status: 'hibernated' }),
    session('z-winner', 'root', { archived: false, status: 'hibernated', resume,
      lastActiveAt: '2026-10-01T12:01:00Z' }),
  ])
  expect(tracked(() => reader.issue('root'))).toMatchObject({ memberSessionIds: ['a-old', 'm-other', 'z-winner'],
    sessionSummary: { total: 3, byPhase: { unknown: 3 } } })
  expect(tracked(() => reader.attached('root'))).not.toBe(LOADING)
  const attached = tracked(() => reader.attached('root'))
  if (attached === LOADING) throw new Error('Unsettled fixture')
  expect(attached.map(session => session.sessionId)).toEqual(['z-winner', 'm-other'])
  runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root',
    value: issue('root', { readAt: '2026-10-01T12:02:00Z' }) }] }))
  expect(tracked(() => reader.issue('root'))).toMatchObject({ readAt: '2026-10-01T12:02:00Z', unread: false })
})

it('updates ready and handoff at the deferral deadline without a row change', () => {
  const deadline = now + 60_000
  const { pool, reader } = open([issue('root', { stage: 'backlog', deferUntil: new Date(deadline).toISOString() })], [])
  const seen: { deferred: boolean; ready: boolean; next: readonly string[] }[] = []
  const stop = autorun(() => {
    const values = readMissionView(reader, 'root'), handoff = readMissionHandoff(reader, 'root')
    if (values === LOADING || handoff === LOADING || !values.root) throw new Error('Unsettled fixture')
    seen.push({ deferred: values.root.deferred, ready: values.root.ready, next: handoff.next.map(entry => entry.issueId) })
  })
  try {
    expect(seen).toEqual([{ deferred: true, ready: false, next: [] }])
    pool.applyLocals({ selectedIssueId: null, coarseNow: deadline - 1 }, new Set(['coarseNow']))
    expect(seen).toHaveLength(1)
    pool.applyLocals({ selectedIssueId: null, coarseNow: deadline }, new Set(['coarseNow']))
    expect(seen.at(-1)).toEqual({ deferred: false, ready: true, next: ['root'] })
    pool.applyLocals({ selectedIssueId: null, coarseNow: deadline + 60_000 }, new Set(['coarseNow']))
    expect(seen).toHaveLength(2)
  } finally { stop() }
})
