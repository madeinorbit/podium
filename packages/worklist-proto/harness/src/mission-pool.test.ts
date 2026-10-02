import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'
import { dedupeSessions } from '@podium/client-core/engine'
import { missionIssueIds, missionRootFor, missionIndexStats, type MissionIssueTopology } from '@podium/client-core/viewmodels'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'
import { MobxPool } from '@podium/client-graph/pool'
import { missions } from '@podium/client-graph/mission'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { checkMissions, compareMissionSnapshots, type MissionCheckRow } from '@podium/client-graph/diagnostics/mission-check'
import { LOADING } from '@podium/client-graph'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap({ errors: true })
const NOW = Date.parse('2026-10-01T12:00:00Z'), STAMP = '2026-09-01T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.restoreAllMocks() })
const issue = (id: string, patch: Partial<SliceIssue> = {}): SliceIssue => ({
  id, seq: 1, title: 'Synthetic task', stage: 'backlog', repoPath: '/synthetic', createdAt: STAMP, updatedAt: STAMP, ...patch,
})
const session = (sessionId: string, issueId: string, patch: Partial<SliceSession> = {}): SliceSession => ({
  sessionId, issueId, status: 'live', cwd: '/synthetic', createdAt: STAMP, lastActiveAt: STAMP, agentKind: 'codex', ...patch,
})
const topology = (rows: SliceIssue[]) => rows as unknown as MissionIssueTopology[]
const sessions = (rows: SliceSession[]) => dedupeSessions(rows as unknown as SessionView[])

function open(issues: SliceIssue[], seats: SliceSession[] = [], lazy = false) {
  const input = new Map<string, object>([
    ...issues.map(row => [`issue:${row.id}`, row] as const), ...seats.map(row => [`session:${row.sessionId}`, row] as const),
  ])
  const load = vi.fn((kind: string, id: string) => input.get(`${kind}:${id}`))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined,
    lazy ? { load, summaries: MISSION_SUMMARIES, schedule: () => () => {} } : undefined)
  pools.push(pool)
  pool.apply({ type: 'replace', rows: [
    ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
  ] })
  const check = () => runInAction(() => checkMissions(pool, topology(issues), sessions(seats)))
  const patchIssue = (id: string, patch: Partial<SliceIssue>) => {
    const index = issues.findIndex(row => row.id === id), value = { ...issues[index]!, ...patch }
    issues[index] = value; input.set(`issue:${id}`, value)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value }] })
  }
  const patchSession = (id: string, patch: Partial<SliceSession>) => {
    const index = seats.findIndex(row => row.sessionId === id), value = { ...seats[index]!, ...patch }
    seats[index] = value; input.set(`session:${id}`, value)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value }] })
  }
  return { pool, view: missions(pool), load, check, patchIssue, patchSession }
}

describe('declared pool mission', () => {
  it('matches archived/deleted ancestors, drafts, cycles and provenance chains', () => {
    const rows = [issue('root'), issue('child', { parentId: 'root' }),
      issue('archived', { parentId: 'root', archived: true }), issue('below-archived', { parentId: 'archived' }),
      issue('deleted', { parentId: 'root', deletedAt: STAMP }), issue('below-deleted', { parentId: 'deleted' }),
      issue('missing-parent', { parentId: 'absent' }), issue('draft', { isDraftVessel: true }), issue('draft-child', { parentId: 'draft' }),
      issue('cycle-a', { parentId: 'cycle-b' }), issue('cycle-b', { parentId: 'cycle-a' }),
      issue('spin', { startedBySession: 'headless', deps: [{ id: 'root', type: 'discovered-from' }] }),
      issue('grafted-child', { parentId: 'spin' }), issue('cold-spin', { startedBySession: 'archived-sender', archived: true }),
      issue('next-spin', { startedBySession: 'cold-sender', deletedAt: STAMP }),
      issue('departed', { startedBySession: 'headless', stage: 'planning', deps: [{ id: 'absent', type: 'discovered-from' }] }),
      issue('formal-departed', { parentId: 'root', stage: 'planning', deps: [{ id: 'absent', type: 'discovered-from' }] }),
      issue('orphan-start', { startedBySession: 'missing-sender' })]
    const ctx = open(rows, [session('headless', 'child', { headless: true }),
      session('archived-sender', 'spin', { archived: true }), session('cold-sender', 'cold-spin', { archived: true })])
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    expect(ctx.view.members('root')).toEqual(new Set(['root', 'child', 'formal-departed', 'spin', 'cold-spin', 'next-spin']))
    expect(ctx.view.rootFor('below-archived')).toBe('below-archived')
    expect(ctx.view.rootFor('draft-child')).toBe('draft')
    expect(ctx.view.rootFor('absent')).toBeUndefined()
    expect(ctx.view.rootFor(null)).toBeUndefined()
    expect(ctx.view.members('absent')).toEqual(new Set(['absent', 'missing-parent']))
  })

  it('keeps roots and member sets invariant under issue order, provenance rounds and ties', () => {
    const rows = [issue('root'), issue('a', { parentId: 'root' }), issue('b', { parentId: 'root' }),
      issue('early-chain', { startedBySession: 'second' }), issue('late-starter', { startedBySession: 'first' }),
      issue('draft', { isDraftVessel: true, startedBySession: 'first' })]
    const seats = [session('first', 'a'), session('second', 'late-starter')]
    const expected = missionIssueIds(topology(rows), 'root', sessions(seats))
    const orders = [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]
    // Legacy iteration order differs; neither root nor membership changes.
    expect([...missionIssueIds(topology(orders[1]!), 'root', sessions(seats))]).not.toEqual([...expected])
    for (const order of orders) for (const senders of [seats, [...seats].reverse()]) {
      for (const row of rows) expect(missionRootFor(topology(order), asIssueId(row.id))?.id)
        .toBe(missionRootFor(topology(rows), asIssueId(row.id))?.id)
      expect(missionIssueIds(topology(order), 'root', sessions(senders))).toEqual(expected)
      expect(open([...order], [...senders]).check()).toMatchObject({ differences: 0, pending: 0 })
    }
  })

  it('invalidates only affected missions when sessions move; cursor/title/heartbeat updates reuse the cache', () => {
    const ctx = open([issue('a'), issue('b'), issue('c'), issue('child', { parentId: 'a' }),
      issue('spin', { startedBySession: 'sender' })], [session('sender', 'child'), session('unrelated', 'c')])
    const legacy = missionIndexStats()
    const c = ctx.view.members('c'), a = ctx.view.members('a'), b = ctx.view.members('b')
    ctx.view.rootFor('child')
    const count = { ...ctx.view.stats }
    ctx.patchIssue('child', { title: 'A new title', readAt: STAMP })
    ctx.patchSession('unrelated', { lastActiveAt: new Date(NOW).toISOString() })
    expect(ctx.view.members('a')).toBe(a)
    expect(ctx.view.members('b')).toBe(b)
    expect(ctx.view.stats).toEqual(count)
    ctx.patchSession('sender', { issueId: 'b' })
    expect(ctx.view.members('a')).toEqual(new Set(['a', 'child']))
    expect(ctx.view.members('b')).toEqual(new Set(['b', 'spin']))
    expect(ctx.view.members('c')).toBe(c)
    expect(ctx.view.stats.members - count.members).toBe(2)
    ctx.patchIssue('child', { parentId: 'b' })
    expect(ctx.view.rootFor('child')).toBe('b')
    expect(missionIndexStats()).toEqual(legacy)
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    expect(missions(ctx.pool)).toBe(ctx.view)
  })

  it('follows spin-off departure, sender eviction and resume collapse', () => {
    const ctx = open([issue('root'), issue('other'), issue('spin', { startedBySession: 'sender', deps: [{ id: 'missing-origin', type: 'discovered-from' }] })],
      [session('sender', 'root', { status: 'hibernated', resume: { kind: 'codex-thread', value: 'same' } }),
        session('twin', 'other', { status: 'exited', resume: { kind: 'codex-thread', value: 'same' } })])
    for (const stage of ['proposed', 'backlog', 'planning', 'in_progress', 'review', 'shipping', 'done', 'cancelled', 'backlog']) {
      ctx.patchIssue('spin', { stage })
      expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
      expect(ctx.view.contains('root', 'spin')).toBe(stage === 'proposed' || stage === 'backlog')
    }
    ctx.patchSession('twin', { status: 'hibernated', lastActiveAt: new Date(NOW).toISOString() })
    expect(ctx.view.contains('root', 'spin')).toBe(false)
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    ctx.patchSession('sender', { headless: true, archived: true })
    expect(ctx.view.contains('root', 'spin')).toBe(true)
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    ctx.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'sender', value: undefined }] })
    expect(ctx.view.contains('root', 'spin')).toBe(false)
  })

  it('answers cold missions through declared summaries without loading or peeking', () => {
    const ctx = open([issue('root', { archived: true }), issue('child', { parentId: 'root', stage: 'done', closedAt: STAMP }),
      issue('spin', { archived: true, startedBySession: 'sender' })], [session('sender', 'root', { archived: true, status: 'exited' })], true)
    expect(runInAction(() => ctx.pool.tables.issue.has('root'))).toBe(false)
    const before = ctx.load.mock.calls.length, read = vi.spyOn(ctx.pool, 'row')
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
    expect(ctx.view.members('root')).toEqual(new Set(['root', 'child', 'spin']))
    expect(ctx.load.mock.calls.length).toBe(before)
    expect(read.mock.calls.some(call => call[2] === 'peek')).toBe(false)
    expect(runInAction(() => ctx.pool.tables.issue.has('root'))).toBe(false)
    ctx.patchIssue('spin', { stage: 'planning', deps: [{ type: 'discovered-from', id: 'absent' }] })
    expect(ctx.view.contains('root', 'spin')).toBe(false)
    expect(ctx.check()).toMatchObject({ differences: 0, pending: 0 })
  })

  it('returns LOADING and batches a cold read when the summary is incomplete', () => {
    const ctx = open([issue('root', { archived: true })], [], true)
    const original = ctx.pool.row.bind(ctx.pool)
    vi.spyOn(ctx.pool, 'row').mockImplementation(((kind: string, id: string, absent?: string) =>
      absent === 'summary' && ctx.pool.residence('issue', id) !== 'resident'
        ? {} : original(kind as 'issue', id, absent as 'load')) as typeof ctx.pool.row)
    expect(ctx.view.rootFor('root')).toBe(LOADING)
    expect(ctx.view.members('root')).toBe(LOADING)
    expect(ctx.view.contains('root', 'root')).toBe(LOADING)
    const count = ctx.load.mock.calls.length
    ctx.pool.hydrate()
    expect(ctx.load.mock.calls.length - count).toBe(1)
    expect(ctx.view.rootFor('root')).toBe('root')
    expect(ctx.view.members('root')).toEqual(new Set(['root']))
  })

  it('tracks added, archived, deleted and removed ancestors and a late sender', () => {
    const ctx = open([issue('root'), issue('child', { parentId: 'missing' }), issue('spin', { startedBySession: 'late' })])
    expect(ctx.view.rootFor('child')).toBe('child')
    expect(ctx.view.contains('root', 'spin')).toBe(false)
    const parent = issue('missing', { parentId: 'root' })
    ctx.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: parent.id, value: parent },
      { kind: 'session', id: 'late', value: session('late', 'root') }] })
    expect(ctx.view.rootFor('child')).toBe('root')
    expect(ctx.view.contains('root', 'spin')).toBe(true)
    for (const patch of [{ archived: true }, { deletedAt: STAMP }]) {
      ctx.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: parent.id, value: { ...parent, ...patch } }] })
      expect(ctx.view.rootFor('child')).toBe('child')
      expect(ctx.view.contains('root', 'child')).toBe(false)
    }
    ctx.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: parent.id, value: undefined }] })
    expect(ctx.view.rootFor('child')).toBe('child')
  })

  it('drops stale members on replace and releases caches on pool disposal', () => {
    const ctx = open([issue('root'), issue('child', { parentId: 'root' })])
    expect(ctx.view.members('root')).toEqual(new Set(['root', 'child']))
    ctx.pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'root', value: issue('root') }] })
    expect(ctx.view.members('root')).toEqual(new Set(['root']))
    ctx.pool.dispose()
    expect(ctx.view.members('root')).toBe(LOADING)
    expect(ctx.view.rootFor('root')).toBe(LOADING)
  })
})

describe('mission differential locations', () => {
  it('detects missing spin-offs, wrong roots, duplicate members and evicted issues while another root loads', () => {
    const expected: MissionCheckRow[] = [ { id: 'root', root: 'root', members: ['root', 'spin'] }, { id: 'cold', root: 'cold', members: ['cold'] } ]
    const result = compareMissionSnapshots(expected, [
      { id: 'root', root: 'wrong', members: ['root', 'root'] }, { id: 'cold', root: LOADING, members: LOADING },
      { id: 'evicted', root: 'evicted', members: ['evicted'] },
    ])
    expect(result).toMatchObject({ differences: 4, pending: 2, first: { field: 'issue', issueId: 'evicted' } })
    expect(compareMissionSnapshots(expected, expected)).toMatchObject({ differences: 0, pending: 0 })
  })
})
