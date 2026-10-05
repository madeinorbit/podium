import type { SessionView } from '@podium/client-core/session-values'
import { createHostSessionAggregatesSelector } from '@podium/client-core/values'
import {
  CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS,
  isAgentConfirmedComputing,
  type MachineId,
} from '@podium/model/browser'
import { autorun, observe, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { EMPTY_HOST_AGGREGATE } from './header-session'
import { HeaderSessions } from './header-sessions'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const HOSTS = ['header-host-a', 'header-host-b'] as MachineId[]
const REF_REPO = 'header-references'
const stamp = (ms = NOW) => new Date(ms).toISOString()
const state = (
  phase: NonNullable<SessionView['agentState']>['phase'],
  at = NOW,
): NonNullable<SessionView['agentState']> => ({ phase, since: stamp(at), nativeSubagentCount: 0 })
function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  const refSeq = Number(id.match(/\d+$/)?.[0] ?? 0) + 1
  return {
    sessionId: id,
    title: id,
    name: `Name ${id}`,
    refRepoId: REF_REPO,
    refSeq,
    refLetter: 'A',
    displayRef: `HEAD-${refSeq}-A`,
    agentKind: 'codex',
    status: 'live',
    cwd: '/synthetic/header',
    machineId: HOSTS[0],
    resumable: true,
    lastActiveAt: stamp(),
    agentState: state('idle'),
    ...patch,
  } as SessionView
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
  const load = vi.fn((_entity: string, id: string) => rows.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined, {
    header: true,
    load,
    schedule: () => () => {},
  })
  const apply = (id: string, value: SessionView | undefined) => {
    if (value) rows.set(id, value)
    else rows.delete(id)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: value as never }] })
  }
  const replace = () => pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: REF_REPO, value: { id: REF_REPO, prefix: 'HEAD', repoPath: '/synthetic/header' } as never },
      ...[...rows].map(([id, value]) => ({ kind: 'session' as const, id, value: value as never })),
    ],
  })
  replace()
  expect(pool.tables.session.size).toBe(32)
  // POD-5407: the pool keeps no list of its cold rows; the index knows them.
  expect(pool.coldIndex().count('session') - pool.tables.session.size).toBe(coldCount)
  // The old aggregate uses the header source's resident-only machine edges.
  const stopEdges = observe(pool.tables.session, (change) =>
    pool.header.change(
      'session',
      change.name,
      change.type === 'delete'
        ? undefined
        : (pool.row('session', change.name) as object | undefined),
    ),
  )
  runInAction(() => {
    for (const [id, value] of rows)
      if (pool.tables.session.has(id)) pool.header.change('session', id, value)
  })
  // POD-5432: a pending change arrives as the row the transaction log painted
  // (the server row in `rows` stays), and its rollback as the server row.
  const paint = (id: string, patch: Partial<SessionView>) =>
    pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id, value: { ...rows.get(id)!, ...patch } as never }],
    })
  const rebase = (id: string) =>
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: rows.get(id) as never }] })
  return {
    pool,
    rows,
    load,
    apply,
    paint,
    rebase,
    replace,
    change(id: string, patch: Partial<SessionView>) {
      apply(id, { ...rows.get(id)!, ...patch })
    },
    dispose() {
      stopEdges()
      pool.dispose()
    },
  }
}

function visits(pool: MobxPool) {
  const ids: string[] = []
  const model = pool.model.bind(pool),
    row = pool.row.bind(pool)
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
  return {
    ids,
    reset() {
      ids.length = 0
    },
    restore() {
      for (const stop of stops) stop.mockRestore()
    },
  }
}

describe('incremental header sessions', () => {
  it('tracks cold working labels without a session publication', () => {
    const f = fixture(1)
    f.change('cold-0', { status: 'live', agentState: state('working') })
    expect(f.pool.queries.ids({ kind: 'headerSessions' })).toContain('cold-0')
    expect(f.pool.tables.session.has('cold-0')).toBe(false)
    let references: (string | undefined)[] = []
    const stop = autorun(() => { references = f.pool.headerViews.working().map(value => value.displayRef) })
    try {
      expect(references).toEqual(['HEAD-1-A'])
      f.pool.apply({ type: 'update', rows: [{ kind: 'repo', id: REF_REPO,
        value: { id: REF_REPO, prefix: 'NEXT', repoPath: '/synthetic/header' } as never }] })
      expect(references).toEqual(['NEXT-1-A'])
      expect(f.pool.tables.session.has('cold-0')).toBe(false)
      expect(f.load).not.toHaveBeenCalled()
    } finally { stop(); f.dispose() }
  })

  it('counts working sessions and adjusts history without visiting the roster at 1x/4x', async () => {
    const samples = []
    for (const scale of [1, 4] as const) {
      const f = fixture(128 * scale)
      for (const id of f.rows.keys()) f.change(id, { status: 'live', agentState: state('working') })
      f.pool.header.apply([
        {
          kind: 'history',
          id: 'fleet',
          value: {
            sampledAt: stamp(),
            bucketMs: 1800000,
            peak: 0,
            buckets: Array.from({ length: 24 }, (_, index) => ({
              start: stamp(NOW - index * 1800000),
              count: 0,
            })),
          },
        },
      ])
      // Establish header demand outside the measurement. A count reads
      // resident flags and cold deadline totals, never the roster values.
      const warm = autorun(() => { f.pool.headerViews.workingCount() })
      expect(f.pool.headerViews.workingCount()).toBe(32 + 128 * scale)
      const roster = vi.spyOn(HeaderSessions.prototype, 'working')
      let count = 0,
        paints = 0,
        stop = () => {}
      const read = () => {
        count = f.pool.headerViews.workingCount()
        expect(f.pool.headerViews.history()?.buckets.at(-1)?.count).toBe(count)
        paints++
      }
      const measure = (name: string, action: () => void) =>
        measureWork(async () => insideReader(name, action), { pool: f.pool })
      try {
        const first = await measure('first header count', () => {
          stop = autorun(read)
        })
        const repeat = await measure('repeat header count', () => {
          f.pool.headerViews.workingCount()
          f.pool.headerViews.history()
        })
        const beforeRename = paints
        const renamed = await measure('working title changed', () =>
          f.change('resident-0', { title: 'Renamed' }),
        )
        expect(paints).toBe(beforeRename)
        const removed = await measure('working phase ended', () =>
          f.change('resident-0', { agentState: state('idle') }),
        )
        expect(count).toBe(31 + 128 * scale)
        expect(paints).toBe(beforeRename + 1)
        expect(roster).not.toHaveBeenCalled()
        stop()
        warm()
        const closed = await measure('closed header count', () =>
          f.change('resident-1', { agentState: state('idle') }),
        )
        expect(paints).toBe(beforeRename + 1)
        expect(roster).not.toHaveBeenCalled()
        const control = await measure('whole roster count control', () => {
          expect(f.pool.headerViews.working().length).toBe(30 + 128 * scale)
        })
        expect(roster).toHaveBeenCalledOnce()
        expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale)
        samples.push({
          scale,
          first: first.work,
          repeat: repeat.work,
          renamed: renamed.work,
          removed: removed.work,
          closed: closed.work,
          control: control.work,
        })
      } finally {
        stop()
        warm()
        roster.mockRestore()
        f.dispose()
      }
    }
    console.info('[header count work1x4x]', JSON.stringify(samples))
    for (const name of ['first', 'repeat', 'renamed', 'removed', 'closed'] as const)
      for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
        expect(samples[1]![name][counter], `${name}:${counter}`).toBe(samples[0]![name][counter])
    expect(samples[1]!.control.elements).toBeGreaterThan(samples[0]!.control.elements)
  })

  it('reads resident and cold contributions inside the applying action', () => {
    const f = fixture(1)
    const stop = autorun(() => {
      f.pool.headerViews.working()
      f.pool.headerViews.workingCount()
      f.pool.headerViews.aggregate(HOSTS[0])
    })
    try {
      runInAction(() => {
        f.change('resident-0', { agentState: state('working') })
        expect(f.pool.headerViews.workingCount()).toBe(1)
        expect(f.pool.headerViews.working().map((row) => row.sessionId)).toEqual(['resident-0'])
        expect(f.pool.headerViews.aggregate(HOSTS[0]).phases.working).toBe(1)
        f.change('cold-0', { status: 'live', agentState: state('working') })
        expect(f.pool.tables.session.has('cold-0')).toBe(false)
        expect(f.pool.headerViews.workingCount()).toBe(2)
        expect(f.pool.headerViews.working().map((row) => row.sessionId)).toEqual(['cold-0', 'resident-0'])
        expect(f.pool.headerViews.aggregate(HOSTS[0]).phases.working).toBe(2)
      })
    } finally { stop(); f.dispose() }
  })

  it('releases header demand at the last reader and leaves untracked reads unsubscribed', () => {
    const f = fixture(1)
    const dispose = vi.spyOn(HeaderSessions.prototype, 'dispose')
    const cold = vi.spyOn(HeaderSessions.prototype as unknown as { cold(id: string): void }, 'cold')
    try {
      expect(f.pool.headerViews.workingCount()).toBe(0)
      expect(dispose).toHaveBeenCalledTimes(1)
      const first = autorun(() => { f.pool.headerViews.workingCount() })
      const second = autorun(() => { f.pool.headerViews.aggregate(HOSTS[0]) })
      first()
      expect(dispose).toHaveBeenCalledTimes(1)
      second()
      expect(dispose).toHaveBeenCalledTimes(2)
      cold.mockClear()
      f.change('cold-0', { status: 'live', agentState: state('working') })
      f.change('resident-0', { agentState: state('working') })
      f.pool.applyLocals({ selectedIssueId: null, coarseNow: NOW + 1000 }, new Set(['coarseNow']))
      expect(cold).not.toHaveBeenCalled()
      const stop = autorun(() => { expect(f.pool.headerViews.workingCount()).toBe(2) })
      stop()
      expect(dispose).toHaveBeenCalledTimes(3)
    } finally { cold.mockRestore(); dispose.mockRestore(); f.dispose() }
  })

  it('reads painted fields of a working cold session without hydrating it', () => {
    const f = fixture(1)
    f.change('cold-0', { status: 'live', agentState: state('working') })
    let working: ReturnType<typeof f.pool.headerViews.working> = []
    const stop = autorun(() => {
      working = f.pool.headerViews.working()
    })
    try {
      f.paint('cold-0', { title: 'Pending title', name: 'Pending name' })
      expect(working).toEqual([
        expect.objectContaining({
          sessionId: 'cold-0',
          title: 'Pending title',
          name: 'Pending name',
        }),
      ])
      f.paint('cold-0', { archived: true })
      expect(working).toEqual([])
      f.rebase('cold-0')
      expect(working).toEqual([expect.objectContaining({ sessionId: 'cold-0', title: 'cold-0' })])
      expect(f.pool.tables.session.has('cold-0')).toBe(false)
      expect(f.pool.hydrate()).toBe(0)
      expect(f.load).not.toHaveBeenCalled()
    } finally {
      stop()
      f.dispose()
    }
  })

  it('queues a missing cold header summary once and restores the roster on hydration', () => {
    const f = fixture(1)
    f.change('cold-0', { status: 'live', agentState: state('working') })
    const missing = vi.spyOn(f.pool.residency!, 'summary').mockReturnValue(undefined)
    let working: string[] = []
    const stop = autorun(() => {
      working = f.pool.headerViews.working().map((row) => row.sessionId)
    })
    try {
      expect(working).toEqual([])
      expect(f.load).not.toHaveBeenCalled()
      expect(f.pool.hydrate()).toBe(1)
      expect(f.load).toHaveBeenCalledExactlyOnceWith('session', 'cold-0')
      expect(working).toEqual(['cold-0'])
      expect(f.pool.hydrate()).toBe(0)
    } finally {
      missing.mockRestore()
      stop()
      f.dispose()
    }
  })

  it.each([
    128, 17_000,
  ])('roster visits only the changed session with %i cold sessions', (coldCount) => {
    const f = fixture(coldCount)
    let working: string[] = []
    const stop = autorun(() => {
      working = f.pool.headerViews.working().map((row) => row.sessionId)
    })
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
      expect(f.load).not.toHaveBeenCalled()
      check('cold-0', () => {
        expect(f.pool.row('session', 'cold-0')).toBe(LOADING)
        expect(f.pool.hydrate()).toBe(1)
      })
      expect(working).toEqual(['cold-0', 'resident-0'])
      check('resident-0', () => f.change('resident-0', { archived: true }))
      expect(working).toEqual(['cold-0'])
      count.reset()
      f.apply('cold-0', undefined)
      expect(new Set(count.ids).size).toBeLessThanOrEqual(1)
      expect(working).toEqual([])
    } finally {
      count.restore()
      stop()
      f.dispose()
    }
  })

  it.each([
    128, 17_000,
  ])('aggregate visits only the changed session with %i cold sessions', (coldCount) => {
    const f = fixture(coldCount)
    let first = EMPTY_HOST_AGGREGATE,
      second = EMPTY_HOST_AGGREGATE
    const stop = autorun(() => {
      first = f.pool.headerViews.aggregate(HOSTS[0])
      second = f.pool.headerViews.aggregate(HOSTS[1])
    })
    const count = visits(f.pool)
    const check = (id: string, change: () => void) => {
      count.reset()
      change()
      expect(count.ids.length).toBeLessThanOrEqual(16)
      expect([...new Set(count.ids)]).toEqual([id])
    }
    try {
      check('resident-0', () => f.change('resident-0', { agentState: state('needs_user') }))
      expect(first).toMatchObject({
        count: 32,
        phases: { waiting: 1, idle: 31 },
        idleSplit: { idle: 32, parkable: 31, protected: 1 },
      })
      check('cold-0', () => f.change('cold-0', { status: 'live', resumable: false }))
      expect(first.idleSplit).toEqual({ idle: 33, parkable: 31, protected: 2 })
      expect(f.load).not.toHaveBeenCalled()
      check('cold-0', () => f.change('cold-0', { machineId: HOSTS[1] }))
      expect(first.count).toBe(32)
      expect(second).toMatchObject({ count: 1, idleSplit: { protected: 1 } })
      check('cold-0', () => {
        f.pool.row('session', 'cold-0')
        f.pool.hydrate()
      })
      expect(second.count).toBe(1)
      check('resident-0', () => f.change('resident-0', { archived: true }))
      expect(first.count).toBe(31)
    } finally {
      count.restore()
      stop()
      f.dispose()
    }
  })

  it('preserves legacy values and canonical roster order through status, phase, archive, machine, hydration, removal and replacement', () => {
    const f = fixture(2)
    const stop = autorun(() => {
      f.pool.headerViews.working()
      for (const id of HOSTS) f.pool.headerViews.aggregate(id)
    })
    const parity = () => {
      const rows = [...f.rows.values()]
      const expected = rows
        .filter((row) => isAgentConfirmedComputing(row, f.pool.clock.current))
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
      expect(f.pool.headerViews.working()).toEqual(
        expected.map(({ sessionId, title, name, displayRef, agentKind }) => ({
          sessionId,
          title,
          name,
          displayRef,
          agentKind,
        })),
      )
      const hosts = createHostSessionAggregatesSelector()(rows)
      for (const id of HOSTS) expect(f.pool.headerViews.aggregate(id)).toEqual(hosts.forMachine(id))
      expect(f.pool.headerViews.aggregate(undefined)).toEqual(EMPTY_HOST_AGGREGATE)
    }
    try {
      parity()
      for (const phase of [
        'working',
        'compacting',
        'needs_user',
        'idle',
        'ended',
        'errored',
      ] as const) {
        f.change('resident-0', { agentState: state(phase) })
        parity()
      }
      for (const status of ['starting', 'reconnecting', 'hibernated', 'exited', 'live'] as const) {
        f.change('resident-0', { status, agentState: state('working') })
        parity()
      }
      f.change('cold-0', { status: 'live', agentState: state('working'), machineId: HOSTS[1] })
      parity()
      f.change('resident-0', {
        title: 'Renamed',
        name: 'New name',
        refSeq: 999,
        displayRef: 'HEAD-999-A',
        archived: true,
      })
      parity()
      f.change('resident-0', { archived: false, machineId: HOSTS[1] })
      parity()
      f.pool.row('session', 'cold-0')
      f.pool.hydrate()
      parity()
      f.apply('resident-0', undefined)
      parity()
      // A resident eviction followed by a returning cold summary must replace,
      // rather than duplicate, its earlier contribution.
      const returned = f.rows.get('cold-0')!
      f.apply('cold-0', undefined)
      parity()
      f.apply('cold-0', returned)
      parity()
      expect(f.pool.residency!.isCold('session', 'cold-0')).toBe(true)
      f.rows.clear()
      f.rows.set('z', session('z', { agentState: state('working') }))
      f.rows.set('a', session('a', { agentState: state('compacting') }))
      f.replace()
      parity()
      expect(f.pool.headerViews.working().map((row) => row.sessionId)).toEqual(['a', 'z'])
    } finally {
      stop()
      f.dispose()
    }
  })

  it('expires only affected evidence, preserves the inclusive boundary, and handles rewinds for resident and cold members', () => {
    const f = fixture(1)
    f.change('resident-0', { agentState: state('working') })
    f.change('cold-0', {
      status: 'live',
      agentState: state('working', NOW + 1000),
      lastActiveAt: stamp(NOW + 1000),
    })
    let ids: string[] = []
    const stop = autorun(() => {
      ids = f.pool.headerViews.working().map((row) => row.sessionId)
    })
    const count = visits(f.pool)
    const tick = (ms: number) =>
      f.pool.applyLocals({ selectedIssueId: null, coarseNow: ms }, new Set(['coarseNow']))
    try {
      count.reset()
      tick(NOW + 60_000)
      expect(count.ids).toEqual([])
      tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS)
      expect(ids).toEqual(['cold-0', 'resident-0'])
      count.reset()
      tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1)
      expect(ids).toEqual(['cold-0'])
      expect([...new Set(count.ids)]).toEqual(['resident-0'])
      tick(NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1001)
      expect(ids).toEqual([])
      tick(NOW)
      expect(ids).toEqual(['cold-0', 'resident-0'])
      expect(f.load).not.toHaveBeenCalled()
    } finally {
      count.restore()
      stop()
      f.dispose()
    }
  })

  it('follows resident painted changes through the one reader and releases subscriptions on clear', () => {
    const f = fixture(0)
    let ids: string[] = [],
      count = 0
    const stop = autorun(() => {
      ids = f.pool.headerViews.working().map((row) => row.sessionId)
      count = f.pool.headerViews.aggregate(HOSTS[0]).count
    })
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
      } finally {
        reads.restore()
      }
      expect(f.pool.headerViews.aggregate(HOSTS[0]).count).toBe(31)
    } finally {
      stop()
      f.dispose()
    }
  })
})
