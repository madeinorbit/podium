import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { defaultSeat } from './mission-seat'
import { MobxPool } from './pool'

/** Which session a task opens on, on desktop and phone alike. */
const session = (partial: Partial<SessionView> & { id: string }): SessionView =>
  ({
    sessionId: asSessionId(partial.id),
    agentKind: 'claude-code',
    status: 'live',
    archived: false,
    cwd: '/src/podium',
    lastActiveAt: '2026-08-11T00:00:00.000Z',
    ...partial,
  }) as SessionView

/** Runs the pick over the pool's own session objects, as both callers do. */
function pick(sessions: readonly SessionView[], coordinator: string | null = null) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    pool.apply({
      type: 'replace',
      rows: sessions.map((value) => ({
        kind: 'session' as const,
        id: value.sessionId,
        value: value as never,
      })),
    })
    return defaultSeat(
      sessions.map((s) => pool.sessionObject(s.sessionId)),
      coordinator,
    )?.sessionId
  } finally {
    pool.dispose()
  }
}

describe('defaultSeat', () => {
  const older = session({ id: 'older', lastActiveAt: '2026-08-11T08:00:00.000Z' })
  const newer = session({ id: 'newer', lastActiveAt: '2026-08-11T10:00:00.000Z' })

  it('opens on the coordinator even when a helper spoke last', () => {
    expect(pick([newer, older], 'older')).toBe('older')
  })

  it('opens on the lone open member', () => {
    const gone = session({ id: 'gone', status: 'exited', lastActiveAt: '2026-08-11T12:00:00.000Z' })
    expect(pick([gone, older])).toBe('older')
  })

  it('otherwise opens on the most recently active member', () => {
    expect(pick([older, newer])).toBe('newer')
  })

  it('skips a coordinator that is no longer open', () => {
    const lead = session({ id: 'lead', status: 'exited' })
    expect(pick([lead, older, newer], 'lead')).toBe('newer')
  })

  it('has no answer when nobody is open', () => {
    expect(pick([session({ id: 'a', archived: true })])).toBeUndefined()
    expect(pick([])).toBeUndefined()
  })
})
