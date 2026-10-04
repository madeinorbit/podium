import type { SessionView } from '@podium/client-core/session-values'
import { createHostSessionAggregatesSelector } from '@podium/client-core/viewmodels'
import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, isAgentConfirmedComputing, type MachineId } from '@podium/model/browser'
import { autorun, observe, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_HOST_AGGREGATE } from './header-session'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const HOSTS = ['header-host-a', 'header-host-b'] as MachineId[]
const stamp = (ms = NOW) => new Date(ms).toISOString()
const state = (phase: NonNullable<SessionView['agentState']>['phase'], at = NOW): NonNullable<SessionView['agentState']> =>
  ({ phase, since: stamp(at), nativeSubagentCount: 0 })
function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return { sessionId: id, title: id, name: `Name ${id}`, displayRef: `S-${id}`, agentKind: 'codex',
    status: 'live', cwd: '/synthetic/header', machineId: HOSTS[0], resumable: true,
    lastActiveAt: stamp(), agentState: state('idle'), ...patch } as SessionView
}

function fixture(coldCount = 0) {
  const rows = new Map<string, SessionView>()
  for (let index = 0; index < 32; index++) {
    const id = `resident-${index}`
    rows.set(id, session(id))
  }
  for (let index = 0; index < coldCount; index++) {
    const id = `cold-${index}`
    rows.set(id, session(id, { status: 'exited', stoppedAt: stamp(NOW - 30 * 86_400_000) }))
  }
  // The feed's per-row read answers the row it last published: the painted
  // row while a change is pending (POD-5432's pooled feed), else the server's.
  const painted = new Map<string, SessionView>()
  const load = vi.fn((_entity: string, id: string) => painted.get(id) ?? rows.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined,
    { header: true, load, schedule: () => () => {} })
  const apply = (id: string, value: SessionView | undefined) => {
    if (value) rows.set(id, value)
    else rows.delete(id)
    painted.delete(id)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: value as never }] })
  }
  pool.apply({ type: 'replace', rows: [...rows].map(([id, value]) => ({ kind: 'session', id, value: value as never })) })
  expect(pool.tables.session.size).toBe(32)
  // POD-5407: the pool keeps no list of its cold rows; the index knows them.
  expect(pool.coldIndex().count('session') - pool.tables.session.size).toBe(coldCount)
  // The old aggregate uses the header source's resident-only machine edges.
  const stopEdges = observe(pool.tables.session, change => pool.header.change('session', change.name,
    change.type === 'delete' ? undefined : pool.row('session', change.name) as object | undefined))
  runInAction(() => { for (const [id, value] of rows) if (pool.tables.session.has(id)) pool.header.change('session', id, value) })
  // POD-5432: a pending change arrives as the row the transaction log painted
  // (the server row in `rows` stays), and its rollback as the server row.
  const paint = (id: string, patch: Partial<SessionView>) => {
    const value = { ...rows.get(id)!, ...patch }
    painted.set(id, value)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: value as never }] })
  }
  const rebase = (id: string) => {
    painted.delete(id)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: rows.get(id) as never }] })
  }
  return { pool, rows, load, apply, paint, rebase, change(id: string, patch: Partial<SessionView>) { apply(id, { ...rows.get(id)!, ...patch }) },
    dispose() { stopEdges(); pool.dispose() } }
}

/**
 * POD-5407: a cold row's declared summary is read through the one per-row
 * reader (`load`), not kept by the pool. Every read was such a summary read:
 * of the named cold rows only, none of them installed.
 */
function expectSummaryReadsOnly(f: ReturnType<typeof fixture>, ids: readonly string[]): void {
  expect([...new Set(f.load.mock.calls.map(([, id]) => id))].sort()).toEqual([...ids].sort())
  for (const id of ids) expect(f.pool.tables.session.has(id), `${id} stays cold`).toBe(false)
}

function visits(pool: MobxPool) {
  const ids: string[] = []
  const model = pool.model.bind(pool), row = pool.row.bind(pool)
  const stops = [
    vi.spyOn(pool, 'model').mockImplementation(((kind: Parameters<typeof model>[0], id: string) => {
      if (kind === 'session') ids.push(id)
      return model(kind, id)
    }) as typeof pool.model),
    vi.spyOn(pool, 'row').mockImplementation(((kind: string, id: string, absent?: string) => {
      if (kind === 'session') ids.push(id)
      return (row as Function)(kind, id, absent)
    }) as typeof pool.row),
  ]
  return { ids, reset() { ids.length = 0 }, restore() { for (const stop of stops) stop.mockRestore() } }
}

describe('incremental header sessions', () => {
  it('reads painted fields of a working cold session without hydrating it', () => {
    const f = fixture(1)
    f.change('cold-0', { status: 'live', agentState: state('working') })
    let working: ReturnType<typeof f.pool.headerViews.working> = []
    const stop = autorun(() => { working = f.pool.headerViews.working() })
    try {
      f.paint('cold-0', { title: 'Pending title', name: 'Pending name' })
      expect(working).toEqual([expect.objectContaining({ sessionId: 'cold-0', title: 'Pending title', name: 'Pending name' })])
      f.paint('cold-0', { archived: true })
      expect(working).toEqual([])
      f.rebase('cold-0')
      expect(working).toEqual([expect.objectContaining({ sessionId: 'cold-0', title: 'cold-0' })])
      expect(f.pool.tables.session.has('cold-0')).toBe(false)
      expect(f.pool.hydrate()).toBe(0)
      expectSummaryReadsOnly(f, ['cold-0'])
    } finally { stop(); f.dispose() }
  })

  it('queues a missing cold header summary once and restores the roster on hydration', () => {
    const f = fixture(1)
    f.change('cold-0', { status: 'live', agentState: state('working') })
    const missing = vi.spyOn(f.pool.residency!, 'summary').mockReturnValue(undefined)
    let working: string[] = []
    const stop = autorun(() => { working = f.pool.headerViews.working().map(row => row.sessionId) })
    try {
      expect(working).toEqual([])
      expect(f.load).not.toHaveBeenCalled()
      expect(f.pool.hydrate()).toBe(1)
      expect(f.load).toHaveBeenCalledExactlyOnceWith('session', 'cold-0')
      expect(working).toEqual(['cold-0'])
      expect(f.pool.hydrate()).toBe(0)
    } finally { missing.mockRestore(); stop(); f.dispose() }
  })

  it.each([128, 17_000])('roster visits only the changed session with %i cold sessions', (coldCount) => {
    const f = fixture(coldCount)
    let working: string[] = []
    const stop = autorun(() => { working = f.pool.headerViews.working().map(row => row.sessionId) })
    const count = visits(f.pool)
    const check = (id: string, change: () => void) => {
      count.reset()
      change()
      expect(count.ids.length).toBeLessThanOrEqual(16)
      expect([...new Set(count.ids)]).toEqual([id])
    }
    try {
      check('resident-0', () => f.change('resident-0', { agentState: state('working') }))
      expect(working).toEqual(['resident-0'])
      check('cold-0', () => f.change('cold-0', { status: 'live', agentState: state('compacting') }))
      expect(f.pool.residency!.isCold('session', 'cold-0')).toBe(true)
      expect(working).toEqual(['cold-0', 'resident-0'])
      expectSummaryReadsOnly(f, ['cold-0'])
      check('cold-0', () => { expect(f.pool.row('session', 'cold-0')).toBe(LOADING); expect(f.pool.hydrate()).toBe(1) })
      expect(working).toEqual(['cold-0', 'resident-0'])
      check('resident-0', () => f.change('resident-0', { archived: true }))
      expect(working).toEqual(['cold-0'])
      count.reset()
      f.apply('cold-0', undefined)
      expect(new Set(count.ids).size).toBeLessThanOrEqual(1)
      expect(working).toEqual([])
    } finally { count.restore(); stop(); f.dispose() }
  })

  it.each([128, 17_000])('aggregate visits only the changed session with %i cold sessions', (coldCount) => {
    const f = fixture(coldCount)
    let first = EMPTY_HOST_AGGREGATE, second = EMPTY_HOST_AGGREGATE
    const stop = autorun(() => { first = f.pool.headerViews.aggregate(HOSTS[0]); second = f.pool.headerViews.aggregate(HOSTS[1]) })
    const count = visits(f.pool)
    const check = (id: string, change: () => void) => {
      count.reset()
      change()
      expect(count.ids.length).toBeLessThanOrEqual(16)
      expect([...new Set(count.ids)]).toEqual([id])
    }
    try {
      check('resident-0', () => f.change('resident-0', { agentState: state('needs_user') }))
      expect(first).toMatchObject({ count: 32, phases: { waiting: 1, idle: 31 }, idleSplit: { idle: 32, parkable: 31, protected: 1 } })
      check('cold-0', () => f.change('cold-0', { status: 'live', resumable: false }))
      expect(first.idleSplit).toEqual({ idle: 33, parkable: 31, protected: 2 })
      expectSummaryReadsOnly(f, ['cold-0'])
      check('cold-0', () => f.change('cold-0', { machineId: HOSTS[1] }))
      expect(first.count).toBe(32)
      expect(second).toMatchObject({ count: 1, idleSplit: { protected: 1 } })
      check('cold-0', () => { f.pool.row('session', 'cold-0'); f.pool.hydrate() })
      expect(second.count).toBe(1)
      check('resident-0', () => f.change('resident-0', { archived: true }))
      expect(first.count).toBe(31)
    } finally { count.restore(); stop(); f.dispose() }
  })

  it('preserves legacy values and canonical roster order through status, phase, archive, machine, hydration, removal and replacement', () => {
    const f = fixture(2)
    const stop = autorun(() => { f.pool.headerViews.working(); for (const id of HOSTS) f.pool.headerViews.aggregate(id) })
    const parity = () => {
      const rows = [...f.rows.values()]
      const expected = rows.filter(row => isAgentConfirmedComputing(row, f.pool.clock.current)).sort((a, b) => a.sessionId < b.sessionId ? -1 : 1)
      expect(f.pool.headerViews.working()).toEqual(expected.map(({ sessionId, title, name, displayRef, agentKind }) => ({ sessionId, title, name, displayRef, agentKind })))
      const hosts = createHostSessionAggregatesSelector()(rows)
      for (const id of HOSTS) expect(f.pool.headerViews.aggregate(id)).toEqual(hosts.forMachine(id))
      expect(f.pool.headerViews.aggregate(undefined)).toEqual(EMPTY_HOST_AGGREGATE)
    }
    try {
      parity()
      for (const phase of ['working', 'compacting', 'needs_user', 'idle', 'ended', 'errored'] as const) {
        f.change('resident-0', { agentState: state(phase) }); parity()
      }
      for (const status of ['starting', 'reconnecting', 'hibernated', 'exited', 'live'] as const) {
        f.change('resident-0', { status, agentState: state('working') }); parity()
      }
      f.change('cold-0', { status: 'live', agentState: state('working'), machineId: HOSTS[1] }); parity()
      f.change('resident-0', { title: 'Renamed', name: 'New name', displayRef: 'S-999', archived: true }); parity()
      f.change('resident-0', { archived: false, machineId: HOSTS[1] }); parity()
      f.pool.row('session', 'cold-0'); f.pool.hydrate(); parity()
      f.apply('resident-0', undefined); parity()
      // A resident eviction followed by a returning cold summary must replace,
      // rather than duplicate, its earlier contribution.
      const returned = f.rows.get('cold-0')!
      f.apply('cold-0', undefined); parity()
      f.apply('cold-0', returned); parity()
      expect(f.pool.residency!.isCold('session', 'cold-0')).toBe(true)
      f.rows.clear()
      f.rows.set('z', session('z', { agentState: state('working') }))
      f.rows.set('a', session('a', { agentState: state('compacting') }))
      f.pool.apply({ type: 'replace', rows: [...f.rows].map(([id, value]) => ({ kind: 'session', id, value: value as never })) }); parity()
      expect(f.pool.headerViews.working().map(row => row.sessionId)).toEqual(['a', 'z'])
    } finally { stop(); f.dispose() }
  })

  it('expires only affected evidence, preserves the inclusive boundary, and handles rewinds for resident and cold members', () => {
    const f = fixture(1)
    f.change('resident-0', { agentState: state('working') })
    f.change('cold-0', { status: 'live', agentState: state('working', NOW + 1000), lastActiveAt: stamp(NOW + 1000) })
    let ids: string[] = []
    const stop = autorun(() => { ids = f.pool.headerViews.working().map(row => row.sessionId) })
    const count = visits(f.pool)
    const tick = (ms: number) => f.pool.applyLocals({ selectedIssueId: null, coarseNow: ms }, new Set(['coarseNow']))
    try {
      count.reset(); tick(NOW + 60_000)
      expect(count.ids).toEqual([])
      tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS)
      expect(ids).toEqual(['cold-0', 'resident-0'])
      count.reset(); tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1)
      expect(ids).toEqual(['cold-0'])
      expect([...new Set(count.ids)]).toEqual(['resident-0'])
      tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1001)
      expect(ids).toEqual([])
      tick(NOW)
      expect(ids).toEqual(['cold-0', 'resident-0'])
      expectSummaryReadsOnly(f, ['cold-0'])
    } finally { count.restore(); stop(); f.dispose() }
  })

  it('follows resident painted changes through the one reader and releases subscriptions on clear', () => {
    const f = fixture(0)
    let ids: string[] = [], count = 0
    const stop = autorun(() => { ids = f.pool.headerViews.working().map(row => row.sessionId); count = f.pool.headerViews.aggregate(HOSTS[0]).count })
    try {
      f.paint('resident-0', { agentState: state('working') })
      expect(ids).toEqual(['resident-0'])
      f.paint('resident-0', { archived: true })
      expect(ids).toEqual([])
      expect(count).toBe(31)
      f.rebase('resident-0')
      expect(count).toBe(32)
      stop()
      f.pool.headerViews.clear()
      const reads = visits(f.pool)
      try {
        f.paint('resident-0', { archived: true })
        // The change arrives as a row (POD-5432), so the fixture's own edge
        // forwarder (the `observe` above) and the header source read that one
        // row; no header view re-runs after clear, and no other row is read.
        expect(reads.ids.length).toBeGreaterThan(0)
        expect(new Set(reads.ids)).toEqual(new Set(['resident-0']))
      } finally { reads.restore() }
      expect(f.pool.headerViews.aggregate(HOSTS[0]).count).toBe(31)
    } finally { stop(); f.dispose() }
  })
})
