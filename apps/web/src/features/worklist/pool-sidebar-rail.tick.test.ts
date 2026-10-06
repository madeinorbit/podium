import { MobxPool } from '@podium/client-graph'
import type { SessionView } from '@podium/client-core/session-values'
import { mostUrgentSession, sessionUrgencyRank, STALE_INACTIVE_MS } from '@podium/client-core/values'
import { autorun, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { railWaitingNow } from './pool-sidebar-rail'

const NOW = Date.parse('2026-10-01T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
function waiter(over: Record<string, unknown> = {}): SessionView {
  return {
    sessionId: 'waiter',
    status: 'live',
    agentKind: 'codex',
    createdAt: iso(NOW - 3_600_000),
    lastActiveAt: iso(NOW - 60_000),
    agentState: { phase: 'needs_user', since: iso(NOW - 60_000) },
    ...over,
  } as unknown as SessionView
}
const pools: MobxPool[] = []
function setupPool(): MobxPool {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined, {
    load: vi.fn(),
    summaries: {},
    schedule: () => () => {},
  })
  pools.push(pool)
  return pool
}
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})
function read(pool: MobxPool, waiting: SessionView[]) {
  let pick: SessionView | undefined
  let runs = 0
  const stop = autorun(() => {
    runs += 1
    pick = mostUrgentSession(waiting, railWaitingNow(pool, waiting))
  })
  return { stop, runs: () => runs, pick: () => pick }
}

it('holds the rail waiting pick across a minute tick with nothing crossing', () => {
  const pool = setupPool()
  const waiting = [waiter()]
  const view = read(pool, waiting)
  try {
    expect(view.pick()).toBe(waiting[0])
    const runs = view.runs()
    runInAction(() => pool.clock.advance(NOW + 60_000))
    expect(view.runs()).toBe(runs)
    expect(view.pick()).toBe(waiting[0])
  } finally {
    view.stop()
  }
})

it('wakes the rail waiting pick at snooze expiry but not before', () => {
  const pool = setupPool()
  const waiting = [waiter({ snoozedUntil: iso(NOW + 120_000) })]
  const view = read(pool, waiting)
  try {
    expect(sessionUrgencyRank(waiting[0]!, NOW)).toBe(2)
    const runs = view.runs()
    runInAction(() => pool.clock.advance(NOW + 60_000))
    expect(view.runs()).toBe(runs)
    runInAction(() => pool.clock.advance(NOW + 120_000))
    expect(view.runs()).toBe(runs + 1)
    expect(sessionUrgencyRank(waiting[0]!, NOW + 120_000)).toBe(0)
  } finally {
    view.stop()
  }
})

it('wakes the rail waiting pick at the 16 h stale line but not before', () => {
  const pool = setupPool()
  const waiting = [waiter({ lastActiveAt: iso(NOW - STALE_INACTIVE_MS + 30_000) })]
  const view = read(pool, waiting)
  try {
    expect(sessionUrgencyRank(waiting[0]!, NOW)).toBe(0)
    const runs = view.runs()
    runInAction(() => pool.clock.advance(NOW + 10_000))
    expect(view.runs()).toBe(runs)
    runInAction(() => pool.clock.advance(NOW + 60_000))
    expect(view.runs()).toBe(runs + 1)
    expect(sessionUrgencyRank(waiting[0]!, NOW + 60_000)).toBe(3)
  } finally {
    view.stop()
  }
})
