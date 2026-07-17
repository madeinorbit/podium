import type { SessionMeta } from '@podium/protocol'
import { describe, expect, test } from 'vitest'
import { formatElapsed, workingSinceMs } from './time-indicators'

describe('formatElapsed', () => {
  test('seconds only under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(34_000)).toBe('34s')
  })
  test('minutes + seconds under an hour', () => {
    expect(formatElapsed(12 * 60_000 + 34_000)).toBe('12m 34s')
  })
  test('hours + minutes under a day', () => {
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m')
  })
  test('days + hours beyond a day', () => {
    expect(formatElapsed(27 * 3_600_000)).toBe('1d 3h')
  })
  test('never negative', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

function session(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'running',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-12T10:00:00Z',
    lastActiveAt: '2026-07-12T10:30:00Z',
    origin: 'user',
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as SessionMeta
}

function agentState(phase: 'working' | 'idle', since: string): SessionMeta['agentState'] {
  return { phase, since, nativeSubagentCount: 0 }
}

describe('workingSinceMs', () => {
  test('null when nothing is working', () => {
    expect(
      workingSinceMs([session({ agentState: agentState('idle', '2026-07-12T10:00:00Z') })]),
    ).toBeNull()
  })
  test('uses the working phase change time', () => {
    const s = session({ agentState: agentState('working', '2026-07-12T10:10:00Z') })
    expect(workingSinceMs([s])).toBe(Date.parse('2026-07-12T10:10:00Z'))
  })
  test('earliest working session wins across a set', () => {
    const a = session({ agentState: agentState('working', '2026-07-12T10:10:00Z') })
    const b = session({
      sessionId: 's2',
      agentState: agentState('working', '2026-07-12T09:50:00Z'),
    })
    const idle = session({
      sessionId: 's3',
      agentState: agentState('idle', '2026-07-12T08:00:00Z'),
    })
    expect(workingSinceMs([a, b, idle])).toBe(Date.parse('2026-07-12T09:50:00Z'))
  })
  test('busy shell without agentState falls back to lastActiveAt', () => {
    const shell = session({ agentKind: 'shell', busy: true, agentState: undefined })
    expect(workingSinceMs([shell])).toBe(Date.parse('2026-07-12T10:30:00Z'))
  })
})
