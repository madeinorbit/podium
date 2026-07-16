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

describe('sessionDotClass — still statuses', () => {
  it.each([
    ['starting', null],
    ['reconnecting', null],
    ['live', null],
    ['hibernated', 'parked'],
  ] as const)('%s carries no looping animation class (marker: %s)', (status, marker) => {
    const classes = sessionDotClass(sess({ status }))
    expect(classes).not.toContain('dot-starting')
    expect(classes).not.toContain('dot-working')
    if (marker) expect(classes).toContain(marker)
  })
})
