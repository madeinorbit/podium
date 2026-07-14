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

describe('sessionDotClass — still status dots', () => {
  it.each([
    'starting',
    'reconnecting',
    'live',
  ] as const)('does not add a looping animation class while %s', (status) => {
    const classes = sessionDotClass(sess({ status }))
    expect(classes).not.toContain('dot-starting')
    expect(classes).not.toContain('dot-working')
  })

  it('keeps the parked marker without an animation class', () => {
    const classes = sessionDotClass(sess({ status: 'hibernated' }))
    expect(classes).toContain('parked')
    expect(classes).not.toContain('dot-working')
  })
})
