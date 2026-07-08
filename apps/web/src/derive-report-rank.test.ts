import type { AgentStopReport, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { sessionUrgencyRank } from './derive'

const NOW = Date.parse('2026-07-08T12:00:00.000Z')
const HOUR = 3_600_000

function sess(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd: '/repo',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 't',
    ...over,
  } as unknown as SessionMeta
}

const report = (attention: AgentStopReport['attention']): AgentStopReport => ({
  outcome: 'partial',
  need: 'decision',
  attention,
  summary: `declared ${attention}`,
  at: new Date(NOW - HOUR).toISOString(),
})

const idleDone: Partial<SessionMeta> = {
  agentState: { phase: 'idle', since: new Date(NOW - HOUR).toISOString(), openTaskCount: 0, idle: { kind: 'done' } },
}

describe('sessionUrgencyRank — declared attention refines the top tier', () => {
  it('orders blocking < soon < working < whenever, and un-reported keeps rank 0', () => {
    const blocking = sessionUrgencyRank(sess('b', { ...idleDone, stopReport: report('blocking') }), NOW)
    const soon = sessionUrgencyRank(sess('s', { ...idleDone, stopReport: report('soon') }), NOW)
    const working = sessionUrgencyRank(sess('w', { agentState: { phase: 'working', since: '', openTaskCount: 0 } }), NOW)
    const whenever = sessionUrgencyRank(sess('f', { ...idleDone, stopReport: report('whenever') }), NOW)
    const bare = sessionUrgencyRank(sess('x', idleDone), NOW)

    expect(bare).toBe(0)
    expect(blocking).toBe(0)
    expect(blocking).toBeLessThan(soon)
    expect(soon).toBeLessThan(working)
    expect(working).toBeLessThan(whenever)
    // whenever (a self-declared FYI) still beats snoozed/stale, i.e. below the working tier only.
    expect(whenever).toBeLessThan(2)
  })

  it('a snoozed session is still muted regardless of a blocking report', () => {
    const snoozed = sessionUrgencyRank(
      sess('z', { ...idleDone, stopReport: report('blocking'), snoozedUntil: new Date(NOW + HOUR).toISOString() }),
      NOW,
    )
    expect(snoozed).toBe(2)
  })

  it('a long-stale session with a whenever report sinks to stale, not the FYI tier', () => {
    const stale = sessionUrgencyRank(
      sess('old', {
        lastActiveAt: new Date(NOW - 48 * HOUR).toISOString(),
        ...idleDone,
        stopReport: report('whenever'),
      }),
      NOW,
    )
    expect(stale).toBe(3)
  })
})
