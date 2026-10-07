import { autorun } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '@podium/client-core/session-values'
import { sessionAtWork, sessionNeedsHuman, sessionPresentOnTask } from '@podium/client-core/values'
import { MobxPool } from './pool'
import { missionView, settled } from './mission-view'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { LOADING } from './worklist/rollup'

// Written against the pre-move mission predicates and row contract. These
// expectations remain independent of the shared-model implementations.
const stamp = '2026-10-07T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => { pools.splice(0).forEach(pool => pool.dispose()); vi.restoreAllMocks() })
const issueRow = (patch: object = {}) => ({ id: 'root', seq: 1, title: 'Mission', stage: 'in_progress',
  parentId: null, deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
const sessionRow = (patch: object = {}) => ({ sessionId: 'crew', issueId: 'root', title: 'Agent',
  cwd: '/synthetic', agentKind: 'codex', status: 'live', archived: false, createdAt: stamp,
  lastActiveAt: stamp, agentState: { phase: 'idle' }, ...patch }) as SessionView
function open(issue: object = issueRow(), sessions: SessionView[] = [sessionRow()]) {
  const records = [{ kind: 'issue' as const, id: 'root', value: issue as never },
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value: value as never }))]
  const load = vi.fn((entity: string, id: string) => records.find(row => row.kind === entity && row.id === id)?.value)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
    { load, summaries: MISSION_VIEW_SUMMARIES, schedule: () => () => {} })
  pools.push(pool); pool.apply({ type: 'replace', rows: records })
  return { pool, load, view: missionView(pool) }
}
function tracked<T>(read: () => T): T {
  let value!: T
  const stop = autorun(() => { value = settled(read) as T }); stop(); return value
}

const patches = [
  {}, { archived: true }, { headless: true }, { agentKind: 'shell' }, { status: 'exited' },
  { status: 'starting' }, { status: 'reconnecting' }, { agentState: { phase: 'working' } },
  { agentState: { phase: 'needs_user' } }, { agentState: { phase: 'errored' } },
  { offer: { createdAt: stamp } }, { archived: true, offer: { createdAt: stamp } },
  { status: 'exited', agentState: { phase: 'errored' } },
]
const old = {
  archived: (row: SessionView) => Boolean(row.archived),
  open: sessionPresentOnTask,
  onRoster: (row: SessionView) => !row.archived && !row.headless && row.agentKind !== 'shell',
  atWork: sessionAtWork,
  asking: (row: SessionView) => !row.archived && sessionNeedsHuman(row),
}
describe.each(Object.entries(old))('session %s parity', (name, answer) => {
  it.each(patches)('matches the previous answer for %j', patch => {
    const row = sessionRow(patch), { pool } = open(issueRow(), [row])
    const model = pool.model('session', row.sessionId)! as unknown as Record<string, unknown>
    expect(tracked(() => model[name])).toBe(answer(row))
  })
  it('rejects a deliberately wrong new field', () => {
    const row = sessionRow(), { pool } = open(), model = pool.model('session', row.sessionId)!
    Object.defineProperty(model, name, { configurable: true, get: () => !answer(row) })
    expect(() => expect((model as unknown as Record<string, unknown>)[name]).toBe(answer(row))).toThrow()
  })
})

it.each([{},{ archived: true },{ deletedAt: stamp },{ stage: 'done' }])('issue visibility matches the old archive/deletion rule for %j', patch => {
  const row = issueRow(patch), { pool } = open(row, [])
  expect(tracked(() => pool.issueObject('root').visible)).toBe(!('archived' in row && row.archived) && !('deletedAt' in row && row.deletedAt))
})

it.each(patches)('issue live and lead match the old mission crew for %j', patch => {
  const row = sessionRow(patch), { pool } = open(issueRow({ coordinatorSessionId: row.sessionId }), [row])
  expect(tracked(() => pool.issueObject('root').live)).toBe(sessionPresentOnTask(row))
  expect(tracked(() => pool.issueObject('root').hasLead)).toBe(old.onRoster(row) && sessionPresentOnTask(row))
})

it('member summary preserves raw membership, ID phase order and activity', () => {
  const { pool, view } = open(issueRow(), [sessionRow({ sessionId: 'z', agentState: { phase: 'working' } }),
    sessionRow({ sessionId: 'a', headless: true, agentState: { phase: 'needs_user' } }),
    sessionRow({ sessionId: 'shell', agentKind: 'shell' })])
  const model = pool.issueObject('root')
  const previous = tracked(() => view.issueMembers('root'))
  expect(previous).not.toBe(LOADING)
  if (previous === LOADING) throw LOADING
  expect(tracked(() => model.memberSessionIds)).toEqual(previous.ids)
  expect(tracked(() => model.memberSummary)).toEqual(previous.summary)
  expect(tracked(() => model.memberLatestActivity)).toBe(previous.latest)
  expect(Object.keys(model.memberSummary.byPhase)).toEqual(['needs_user', 'working'])
})

it('cold facts queue batched loads and never synchronously invoke the loader', () => {
  const { pool, load } = open(issueRow({ stage: 'done', closedAt: '2026-09-01T12:00:00Z' }),
    [sessionRow({ archived: true, status: 'exited' })])
  expect(tracked(() => pool.issueObject('root').visible)).toBe(LOADING)
  expect(load).not.toHaveBeenCalled()
  expect(pool.hydrate()).toBe(1)
  expect(tracked(() => pool.issueObject('root').visible)).toBe(true)
})
