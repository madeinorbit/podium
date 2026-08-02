import { asSessionId, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { mostUrgentSession, sortSessionsForSidebar } from './session-urgency'

// ---------------------------------------------------------------------------
// POD-330 — F3, "how sessions rank against each other".
//
// The two properties below had NO test anywhere when this module was extracted:
// mutating the snooze de-emphasis in `sortSessionsForSidebar`, and mutating the
// rank/recency tiebreak in `mostUrgentSession`, both left the whole suite GREEN.
// Both lines are reached on every call (verified before writing these), so the
// silence was an assertion gap, not dead code.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

/** Blocked on the human. */
const needsYou = (id: string, over: Partial<SessionMeta> = {}) =>
  session(id, {
    agentState: { phase: 'needs_user', since: new Date(NOW - HOUR).toISOString() },
    ...over,
  } as Partial<SessionMeta>)

/** Running fine without us. */
const working = (id: string, over: Partial<SessionMeta> = {}) =>
  session(id, {
    agentState: { phase: 'working', since: new Date(NOW - HOUR).toISOString() },
    ...over,
  } as Partial<SessionMeta>)

describe('sortSessionsForSidebar', () => {
  it('de-emphasises a SNOOZED attention session below an un-snoozed one, even when it is more recent', () => {
    const snoozed = needsYou('snoozed', {
      snoozedUntil: new Date(NOW + HOUR).toISOString(),
      lastActiveAt: new Date(NOW - 60_000).toISOString(),
    })
    const awake = needsYou('awake', { lastActiveAt: new Date(NOW - 10 * HOUR).toISOString() })
    expect(sortSessionsForSidebar([snoozed, awake], NOW).map((s) => s.sessionId)).toEqual([
      'awake',
      'snoozed',
    ])
  })

  it('keeps working sessions at the bottom, under both attention ranks', () => {
    const order = sortSessionsForSidebar(
      [
        working('busy', { lastActiveAt: new Date(NOW - 60_000).toISOString() }),
        needsYou('snoozed', { snoozedUntil: new Date(NOW + HOUR).toISOString() }),
        needsYou('awake'),
      ],
      NOW,
    )
    expect(order.map((s) => s.sessionId)).toEqual(['awake', 'snoozed', 'busy'])
  })

  it('does not mutate its input', () => {
    const input = [working('b'), needsYou('a')]
    sortSessionsForSidebar(input, NOW)
    expect(input.map((s) => s.sessionId)).toEqual(['b', 'a'])
  })
})

describe('mostUrgentSession', () => {
  it('prefers the more URGENT session over the more RECENT one', () => {
    // The working session is 59 minutes fresher; urgency still wins, because the
    // row's dot answers "does this need me", not "what moved last".
    const stale = needsYou('blocked', { lastActiveAt: new Date(NOW - HOUR).toISOString() })
    const fresh = working('busy', { lastActiveAt: new Date(NOW - 60_000).toISOString() })
    expect(mostUrgentSession([fresh, stale], NOW)?.sessionId).toBe('blocked')
  })

  it('falls back to recency only WITHIN one rank', () => {
    const older = needsYou('older', { lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() })
    const newer = needsYou('newer', { lastActiveAt: new Date(NOW - HOUR).toISOString() })
    expect(mostUrgentSession([older, newer], NOW)?.sessionId).toBe('newer')
  })

  it('is undefined for a session-less row', () => {
    expect(mostUrgentSession([], NOW)).toBeUndefined()
  })
})
