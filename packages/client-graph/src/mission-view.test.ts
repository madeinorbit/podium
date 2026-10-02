import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool } from './pool'
import { missionView, readMissionView } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { LOADING } from './worklist/rollup'

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
function open(rows: IssueNavigationModel[], seats: SessionView[]) {
  const input = new Map<string, object>([...rows.map(row => [`issue:${row.id}`, row] as const), ...seats.map(row => [`session:${row.sessionId}`, row] as const)])
  const load = vi.fn((entity: string, id: string) => input.get(`${entity}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, { load, summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {} })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [...rows.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))] })
  return { pool, load, reader: missionView(pool) }
}

it('uses archived-inclusive relations, small scalar summaries and one batched load for cold display', () => {
  const { pool, load, reader } = open([coldRoot()], [session('old', 'root')])
  expect(pool.tables.session.has('old')).toBe(false)
  expect(tracked(() => [...pool.graph.many('issue', 'root', 'missionSessions')])).toEqual(['old'])
  const summary = tracked(() => pool.row('session', 'old', 'summary'))
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
  expect(values.archived.map(session => session.sessionId)).toEqual(['old'])
  expect(values.archived[0]?.name).toBe('Named agent')
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
  expect(tracked(() => [...pool.graph.many('issue', 'source', 'viewOrigins')]).sort()).toEqual(['first', 'second'])
  expect(tracked(() => [...pool.graph.many('issue', 'source', 'viewRelated')]).sort()).toEqual(['first', 'second'])
  expect(tracked(() => reader.issue('second'))).toMatchObject({ dependents: [
    { id: 'source', type: 'discovered-from' }, { id: 'source', type: 'related' },
  ] })
  const values = tracked(() => readMissionView(reader, 'second'))
  expect(values).not.toBe(LOADING)
  if (values === LOADING) throw new Error('Unsettled fixture')
  expect(values.progress.total).toBe(0)
  runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'source',
    value: issue('source', { stage: 'proposed', deps: deps.filter(dep => dep.id !== 'second') }) }] }))
  expect(tracked(() => pool.graph.size('issue', 'second', 'viewDiscoveries'))).toBe(0)
  expect(tracked(() => reader.issue('second'))).toMatchObject({ dependents: [] })
  const removed = tracked(() => readMissionView(reader, 'second'))
  if (removed === LOADING) throw new Error('Unsettled fixture')
  expect(removed.progress.total).toBe(1)
})
