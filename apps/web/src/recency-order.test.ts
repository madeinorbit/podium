import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { partitionWorkItems, sortSessionsForSidebar } from './derive'
import { compareRecency, groupSessions } from './home'

const needsUser = (since: string): AgentRuntimeState => ({
  phase: 'needs_user',
  since,
  openTaskCount: 0,
  need: { kind: 'question' },
})
const working = (since: string): AgentRuntimeState => ({
  phase: 'working',
  since,
  openTaskCount: 0,
})

const SAME = '2026-06-10T00:00:00.000Z'

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    agentKind: 'shell',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: SAME,
    origin: { kind: 'spawn' },
    archived: false,
    ...over,
  }
}

describe('compareRecency', () => {
  it('orders newest-active first', () => {
    const older = meta({ sessionId: 'a', lastActiveAt: '2026-06-09T00:00:00.000Z' })
    const newer = meta({ sessionId: 'b', lastActiveAt: '2026-06-10T00:00:00.000Z' })
    expect([older, newer].sort(compareRecency).map((s) => s.sessionId)).toEqual(['b', 'a'])
  })

  it('breaks ties deterministically (createdAt desc, then sessionId) — no reshuffle', () => {
    // Equal lastActiveAt is common right after a reattach. The order must be a total
    // order so it does not depend on input order (which would flicker frame to frame).
    const a = meta({ sessionId: 'aaa', createdAt: '2026-06-01T00:00:00.000Z' })
    const b = meta({ sessionId: 'bbb', createdAt: '2026-06-02T00:00:00.000Z' })
    expect([a, b].sort(compareRecency).map((s) => s.sessionId)).toEqual(['bbb', 'aaa'])
    expect([b, a].sort(compareRecency).map((s) => s.sessionId)).toEqual(['bbb', 'aaa'])
  })
})

describe('stable ordering with equal lastActiveAt', () => {
  it('sortSessionsForSidebar is independent of input order', () => {
    const a = meta({ sessionId: 'aaa', createdAt: '2026-06-01T00:00:00.000Z' })
    const b = meta({ sessionId: 'bbb', createdAt: '2026-06-02T00:00:00.000Z' })
    const c = meta({ sessionId: 'ccc', createdAt: '2026-06-03T00:00:00.000Z' })
    const order1 = sortSessionsForSidebar([a, b, c]).map((s) => s.sessionId)
    const order2 = sortSessionsForSidebar([c, a, b]).map((s) => s.sessionId)
    expect(order1).toEqual(order2)
    expect(order1).toEqual(['ccc', 'bbb', 'aaa'])
  })

  it('groupSessions orders each group stably regardless of input order', () => {
    const a = meta({ sessionId: 'aaa', createdAt: '2026-06-01T00:00:00.000Z' })
    const b = meta({ sessionId: 'bbb', createdAt: '2026-06-02T00:00:00.000Z' })
    expect(groupSessions([a, b]).idle.map((s) => s.sessionId)).toEqual(
      groupSessions([b, a]).idle.map((s) => s.sessionId),
    )
  })
})

describe('partitionWorkItems (sidebar WORK ITEMS) ordering', () => {
  // Input is oldest-first on purpose — the raw session list arrives roughly in
  // insertion order, which is what put newest at the BOTTOM of the sidebar.
  const old = '2026-06-08T00:00:00.000Z'
  const mid = '2026-06-09T00:00:00.000Z'
  const recent = '2026-06-10T00:00:00.000Z'

  it('orders NEEDS YOUR ATTENTION newest-active first', () => {
    const a = meta({ sessionId: 'old', lastActiveAt: old, agentState: needsUser(old) })
    const b = meta({ sessionId: 'mid', lastActiveAt: mid, agentState: needsUser(mid) })
    const c = meta({ sessionId: 'new', lastActiveAt: recent, agentState: needsUser(recent) })
    const { attention } = partitionWorkItems([a, b, c], new Set(), Date.parse('2026-06-11'))
    expect(attention.map((s) => s.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('orders WORKING newest-active first', () => {
    const a = meta({ sessionId: 'old', lastActiveAt: old, agentState: working(old) })
    const b = meta({ sessionId: 'new', lastActiveAt: recent, agentState: working(recent) })
    const { working: w } = partitionWorkItems([a, b], new Set(), Date.parse('2026-06-11'))
    expect(w.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })

  it('orders PINNED PANELS newest-active first', () => {
    const a = meta({ sessionId: 'old', lastActiveAt: old })
    const b = meta({ sessionId: 'new', lastActiveAt: recent })
    const { pinnedPanels } = partitionWorkItems(
      [a, b],
      new Set(['old', 'new']),
      Date.parse('2026-06-11'),
    )
    expect(pinnedPanels.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })
})
