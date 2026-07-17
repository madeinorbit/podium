import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { partitionWorkItems, sortSessionsForSidebar } from './derive'
import { compareRecency, groupSessions } from './home'

const needsUser = (since: string): AgentRuntimeState => ({
  phase: 'needs_user',
  since,
  nativeSubagentCount: 0,
  need: { kind: 'question' },
})
const working = (since: string): AgentRuntimeState => ({
  phase: 'working',
  since,
  nativeSubagentCount: 0,
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
    readAt: null,
    unread: false,
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

  const agent = (over: Partial<SessionMeta> & { sessionId: string }): SessionMeta =>
    meta({ agentKind: 'claude-code', ...over })

  it('orders NEEDS YOUR ATTENTION newest-active first', () => {
    const a = agent({ sessionId: 'old', lastActiveAt: old, agentState: needsUser(old) })
    const b = agent({ sessionId: 'mid', lastActiveAt: mid, agentState: needsUser(mid) })
    const c = agent({ sessionId: 'new', lastActiveAt: recent, agentState: needsUser(recent) })
    const { attention } = partitionWorkItems([a, b, c], new Set(), Date.parse('2026-06-11'))
    expect(attention.map((s) => s.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('never shows shells in NEEDS YOUR ATTENTION (an idle shell is not a work item)', () => {
    const idleShell = meta({ sessionId: 'sh', agentKind: 'shell' }) // not busy → idle shell
    const blockedAgent = agent({ sessionId: 'ag', agentState: needsUser(recent) })
    const { attention } = partitionWorkItems(
      [idleShell, blockedAgent],
      new Set(),
      Date.parse('2026-06-11'),
    )
    expect(attention.map((s) => s.sessionId)).toEqual(['ag'])
  })

  it('shells never appear in the sidebar — not even a busy one in WORKING', () => {
    const busyShell = meta({ sessionId: 'sh', agentKind: 'shell', busy: true })
    const {
      attention,
      working: w,
      pinnedPanels,
    } = partitionWorkItems([busyShell], new Set(['sh']), Date.parse('2026-06-11'))
    expect(attention).toEqual([])
    expect(w).toEqual([])
    expect(pinnedPanels).toEqual([])
  })

  it('orders WORKING newest-active first', () => {
    const a = meta({
      sessionId: 'old',
      lastActiveAt: old,
      agentState: working(old),
      agentKind: 'claude-code',
    })
    const b = meta({
      sessionId: 'new',
      lastActiveAt: recent,
      agentState: working(recent),
      agentKind: 'claude-code',
    })
    const { working: w } = partitionWorkItems([a, b], new Set(), Date.parse('2026-06-11'))
    expect(w.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })

  it('orders PINNED PANELS newest-active first', () => {
    const a = meta({ sessionId: 'old', lastActiveAt: old, agentKind: 'claude-code' })
    const b = meta({ sessionId: 'new', lastActiveAt: recent, agentKind: 'claude-code' })
    const { pinnedPanels } = partitionWorkItems(
      [a, b],
      new Set(['old', 'new']),
      Date.parse('2026-06-11'),
    )
    expect(pinnedPanels.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })
})
