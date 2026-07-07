import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { sessionDotClass } from './derive'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')

function sess(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 's1',
    cwd: '/r/acme',
    lastActiveAt: new Date(NOW - 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 'some title',
    ...over,
  } as unknown as SessionMeta
}

describe('sessionDotClass — booting spinner', () => {
  it('shows dot-starting while status is starting', () => {
    expect(sessionDotClass(sess({ status: 'starting' }))).toContain('dot-starting')
  })

  it('shows dot-starting while status is reconnecting', () => {
    expect(sessionDotClass(sess({ status: 'reconnecting' }))).toContain('dot-starting')
  })

  it('does not show dot-starting for a live session', () => {
    expect(sessionDotClass(sess({ status: 'live' }))).not.toContain('dot-starting')
  })

  it('does not show dot-starting for a hibernated (parked) session', () => {
    expect(sessionDotClass(sess({ status: 'hibernated' }))).not.toContain('dot-starting')
  })
})
