import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { sessionMenuEligibility } from './SessionContextMenu'

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's',
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: '2026-06-10T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  }
}

describe('sessionMenuEligibility', () => {
  it('allows hibernate only for a live, recoverable, non-working agent', () => {
    expect(sessionMenuEligibility(meta({ status: 'live', resumable: true })).canHibernate).toBe(true)
    // mid-turn → no (parking would lose the in-flight turn)
    expect(
      sessionMenuEligibility(
        meta({
          status: 'live',
          resumable: true,
          agentState: { phase: 'working', since: 'x', openTaskCount: 0 },
        }),
      ).canHibernate,
    ).toBe(false)
    // not recoverable → no
    expect(sessionMenuEligibility(meta({ status: 'live', resumable: false })).canHibernate).toBe(
      false,
    )
  })

  it('allows resume for a hibernated or recoverable-exited session', () => {
    expect(sessionMenuEligibility(meta({ status: 'hibernated' })).canResume).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'exited', resumable: true })).canResume).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'exited', resumable: false })).canResume).toBe(
      false,
    )
    expect(sessionMenuEligibility(meta({ status: 'live' })).canResume).toBe(false)
  })

  it('allows close only when there is a running process', () => {
    expect(sessionMenuEligibility(meta({ status: 'live' })).canClose).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'starting' })).canClose).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'exited' })).canClose).toBe(false)
    expect(sessionMenuEligibility(meta({ status: 'hibernated' })).canClose).toBe(false)
  })
})
