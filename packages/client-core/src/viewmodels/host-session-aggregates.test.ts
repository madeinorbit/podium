import { asMachineId, type SessionMeta } from '@podium/model'
import { afterEach, expect, it } from 'vitest'
import { readRuntimeStoreStats, storeStats } from '../perf/store-stats'
import { createHostSessionAggregatesSelector } from './host-session-aggregates'
import { hostAgentsView, hostAgentsViewFromCounts, idleSessionSplit, residencyBreakdown, residentWorktreeKey } from './slices/machines/facts'

const ids = [asMachineId('a'), asMachineId('b'), undefined]
const fixture = () => Array.from({ length: 4304 }, (_, i) => ({
  machineId: ids[i % 3], status: ['live', 'starting', 'reconnecting', 'exited'][i % 4],
  cwd: `/repo/${i % 20}`, archived: i % 7 === 0, resumable: i % 2 === 0,
  agentState: { phase: ['working', 'compacting', 'idle', 'ended', 'needs_user', 'unknown'][i % 6] },
}) as SessionMeta)
afterEach(() => { storeStats.enable(false); storeStats.reset() })

function legacy(rows: SessionMeta[]) {
  return { occupancyKey: residentWorktreeKey(rows), machines: ids.map((id) => ({
    agents: hostAgentsView(rows, id, 12, 'host'),
    idleSplit: idleSessionSplit(rows, id), phases: residencyBreakdown(rows, id),
  })) }
}
function optimized(result: ReturnType<ReturnType<typeof createHostSessionAggregatesSelector>>) {
  return { occupancyKey: result.occupancyKey, machines: ids.map((id) => {
    const a = result.forMachine(id)
    return { agents: hostAgentsViewFromCounts(a.count, a.idleSplit.idle, 12, 'host'),
      idleSplit: a.idleSplit, phases: a.phases }
  }) }
}

it('armed before/after: disconnected renders scan zero sessions; immaterial replacements build zero aggregates', () => {
  const results = []
  for (const disconnected of [true, false]) {
    for (const old of [true, false]) {
      let visits = 0
      const tracked = (rows: SessionMeta[]) => new Proxy(rows, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) visits++
          return Reflect.get(target, property, receiver)
        },
      })
      const initial = fixture()
      let rows = tracked(initial)
      const select = createHostSessionAggregatesSelector()
      const derive = () => old ? legacy(rows) : optimized(select(rows))
      const expected = derive()
      visits = 0; storeStats.reset(); storeStats.enable()
      for (let frame = 0; frame < 3; frame++) {
        if (!disconnected) rows = tracked(initial.map((s) => ({ ...s, title: `frame ${frame}` })))
        expect(derive()).toEqual(expected)
      }
      const stats = readRuntimeStoreStats(select)
      results.push({ disconnected, old, visits, builds: stats?.slices['hostSessions.aggregateBuild'] ?? 0 })
      if (old) expect(visits).toBeGreaterThan(3 * 4304)
      else expect(visits).toBe(disconnected ? 0 : 3 * 4304)
      expect(stats?.slices['hostSessions.aggregateBuild'] ?? 0).toBe(0)
    }
  }
  console.info('Host aggregate armed A/B, 4304 sessions, 3 frames', results)
})

it('preserves legacy semantics across all material changes, removal and independent scopes', () => {
  const select = createHostSessionAggregatesSelector()
  let rows = fixture()
  const check = () => expect(optimized(select(rows))).toEqual(legacy(rows))
  check()
  const first = select(rows)
  rows = rows.map((s) => ({ ...s, title: 'changed', agentKind: 'shell' }))
  expect(select(rows)).toBe(first)
  const changes: Partial<SessionMeta>[] = [
    { machineId: asMachineId('b') }, { status: 'live' }, { archived: false },
    { cwd: '/moved' }, { resumable: true },
    { agentState: { phase: 'needs_user' } as SessionMeta['agentState'] },
    { agentState: undefined },
  ]
  for (const change of changes) {
    rows = rows.map((s, i) => i === 0 ? { ...s, ...change } : s)
    check()
  }
  rows = rows.slice(1); check()
  rows = [...rows].reverse(); check()
  expect(optimized(createHostSessionAggregatesSelector()([]))).toEqual(legacy([]))
  rows = []; check()
  rows = fixture()
  for (const target of [null, 0, 1, 12]) {
    for (const id of ids) {
      const a = select(rows).forMachine(id)
      expect(hostAgentsViewFromCounts(a.count, a.idleSplit.idle, target, 'renamed'))
        .toEqual(hostAgentsView(rows, id, target, 'renamed'))
    }
  }
})
