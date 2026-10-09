import { autorun, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { MobxPool } from '../pool'
import { LOADING, motionPhase, seatVerdictOf } from './rollup'
import { fleetOf, sidebarSessionFacts, sidebarTiming } from './sidebar-row'
import { worklistView } from './view-model'
import type { SliceSession } from '../shared/slice-types'

const stamp = '2026-10-09T07:00:00Z'
const lane = '/synthetic/lane'
const session = (id: string, patch: object = {}) => ({ sessionId: id, cwd: lane,
  agentKind: 'codex', status: 'live', archived: false, createdAt: stamp, lastActiveAt: stamp,
  agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' }, workingMsTotal: 42 }, ...patch }) as SliceSession
const fixtures = [
  session('done'),
  session('working', { agentState: { phase: 'working', since: stamp, workingMsTotal: 10 } }),
  session('waiting', { agentState: { phase: 'needs_user', since: stamp } }),
  session('offer', { offer: { createdAt: '2026-10-09T06:00:00Z' } }),
  session('archived', { archived: true }),
  session('headless', { headless: true }),
  session('parked', { status: 'hibernated', agentState: { phase: 'working', nativeSubagentCount: 3 } }),
  session('errored', { agentState: { phase: 'errored', since: stamp, error: { class: 'auth' } } }),
  session('exited', { status: 'exited', agentState: { phase: 'errored', since: stamp } }),
  session('unknown', { agentState: undefined }),
  session('invalid-stamp', { lastActiveAt: 'invalid', agentState: undefined }),
  session('zero-total', { agentState: { phase: 'ended', since: stamp, workingMsTotal: 0 } }),
]
const candidate = <T>(value: T): T | string => process.env.POD5651_MUTATE === '1' ? '__wrong_answer__' : value

describe('shared session facts equal the old verdict on identical records', () => {
  for (const row of fixtures) it(row.sessionId, () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: [{ kind: 'session', id: row.sessionId, value: row as never }] })
    const model = pool.sessionObject(row.sessionId)
    try {
      const actual = { fleet: model.fleet, working: model.workingTimer,
        waitingOpen: model.motion === 'waiting' ? model.waitingTimer : undefined,
        waitingFinished: motionPhase(row, true) === 'waiting' ? model.waitingTimer : undefined,
        doneSince: model.doneSinceMs, totalMs: model.workingMsTotal,
        errorClass: model.errorClass, allUnstarted: model.unstarted }
      // Undefined optional keys compare the same through toEqual.
      expect(candidate(actual)).toEqual(sidebarSessionFacts(row))
      expect(model.unread).toEqual(row.unread)
    } finally { pool.dispose() }
  })
})

describe('owner totals equal the previous roster helpers', () => {
  for (const rows of [[], [fixtures[0]!], [fixtures[1]!], [fixtures[2]!], fixtures,
    [fixtures[3]!, fixtures[2]!], [fixtures[0]!, fixtures[11]!]]) it(rows.map(row => row.sessionId).join(',') || 'empty', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: [
      { kind: 'worktree', id: lane, value: { path: lane, repoPath: '/synthetic', repoName: 'Synthetic' } },
      ...rows.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })),
    ] })
    const tree = worklistView(pool).tree(pool.model('worktree', lane)!)
    const stop = autorun(() => { void tree.timing; void tree.visibleFleet })
    try {
      const shown = tree.sessions as unknown as SliceSession[]
      expect(candidate(tree.timing)).toEqual(sidebarTiming(shown, tree.visiblePhase, false, tree.activityAt))
      expect(candidate(tree.visibleFleet)).toEqual(fleetOf(shown))
      expect(tree.waitingCount).toEqual(shown.filter(row => motionPhase(row, false) === 'waiting').length)
      expect(tree.visibleUnread).toEqual(!tree.visibleWorking && shown.some(row => row.unread))
    } finally { stop(); pool.dispose() }
  })
})

it('cold/LOADING and absent verdicts retain their old answers without warming timer facts', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load: () => undefined, schedule: () => () => {},
  })
  const old = '2026-01-01T00:00:00Z'
  const cold = session('cold', { issueId: 'cold-owner', archived: true, status: 'exited', lastActiveAt: old })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'cold-owner', value: { id: 'cold-owner', seq: 1, title: 'Cold owner',
      repoPath: '/synthetic', stage: 'done', closedAt: old, updatedAt: old, createdAt: old } },
    { kind: 'session', id: 'cold', value: cold as never },
  ] })
  try {
    const view = worklistView(pool)
    expect(pool.resident('session', 'cold')).toBe('loading')
    expect(view.session(pool.sessionObject('cold')).verdict).toBe(LOADING)
    expect(view.session(pool.sessionObject('absent')).verdict).toBeUndefined()
    const since = vi.spyOn(pool.sessionObject('cold'), 'storedField')
    void view.session(pool.sessionObject('cold')).verdict
    expect(since).not.toHaveBeenCalled()
  } finally { pool.dispose() }
})

it('live totals follow heartbeat, read state and archiving on the same records', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const row = session('seat', { unread: true })
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: lane, value: { path: lane, repoPath: '/synthetic' } },
    { kind: 'session', id: 'seat', value: row as never },
  ] })
  const tree = worklistView(pool).tree(pool.model('worktree', lane)!)
  const stop = autorun(() => {
    const shown = tree.sessions as unknown as SliceSession[]
    expect(candidate(tree.timing)).toEqual(sidebarTiming(shown, tree.visiblePhase, false, tree.activityAt))
    expect(candidate(tree.visibleFleet)).toEqual(fleetOf(shown))
    expect(tree.visibleUnread).toEqual(!tree.visibleWorking && shown.some(row => row.unread))
  })
  try {
    for (const patch of [{ unread: false }, { lastActiveAt: '2026-10-09T07:01:00Z',
      agentState: { phase: 'working', since: stamp, workingMsTotal: 99, nativeSubagentCount: 2 } },
      { archived: true }]) runInAction(() => pool.apply({ type: 'update', rows: [
        { kind: 'session', id: 'seat', value: { ...row, ...patch } as never },
      ] }))
  } finally { stop(); pool.dispose() }
})

// Frozen old answers stay callable after the production companion forwards
// to the shared model. In particular, finished rows suppress only offer asks.
it('finished and unfinished issue verdicts preserve attention and timestamps', () => {
  for (const row of fixtures) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: [{ kind: 'session', id: row.sessionId, value: row as never }] })
    try {
      const verdict = worklistView(pool).session(pool.sessionObject(row.sessionId)).verdict
      expect(candidate(verdict)).toEqual(seatVerdictOf(row))
    } finally { pool.dispose() }
  }
})
