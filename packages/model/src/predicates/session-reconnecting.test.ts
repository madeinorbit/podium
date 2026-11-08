import { describe, expect, it } from 'vitest'
import { SessionStatus } from '../entities/session'
import { isSessionReconnecting, shownSessionStatus } from './session-reconnecting'

/** The one rule every surface derives "reconnecting" through (ADR 12 D1, POD-6646). */
describe('isSessionReconnecting', () => {
  const cases: Array<[status: string, online: boolean | undefined, reconnecting: boolean]> = [
    ['live', false, true],
    ['starting', false, true],
    ['live', true, false],
    ['starting', true, false],
    // Unknown is never reconnecting: an app started offline shows "unknown",
    // not a stale answer.
    ['live', undefined, false],
    ['starting', undefined, false],
    // A process that is not meant to run cannot be reconnecting.
    ['hibernated', false, false],
    ['exited', false, false],
  ]
  it.each(cases)('%s on a machine online=%s → %s', (status, online, reconnecting) => {
    expect(isSessionReconnecting(status, online)).toBe(reconnecting)
    expect(shownSessionStatus(status, online)).toBe(reconnecting ? 'reconnecting' : status)
  })

  it('is never a stored status', () => {
    expect(SessionStatus.options).not.toContain('reconnecting')
  })
})
