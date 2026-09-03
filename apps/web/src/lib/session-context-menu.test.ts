import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  handoffBlockerText,
  handoffRejectionText,
  sessionMenuEligibility,
} from './session-context-menu'

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s'),
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
  } as unknown as SessionMeta
}

describe('sessionMenuEligibility', () => {
  it('allows hibernate only for a live, recoverable, non-working agent', () => {
    expect(sessionMenuEligibility(meta({ status: 'live', resumable: true })).canHibernate).toBe(
      true,
    )
    // mid-turn → no (parking would lose the in-flight turn)
    expect(
      sessionMenuEligibility(
        meta({
          status: 'live',
          resumable: true,
          agentState: { phase: 'working', since: 'x', nativeSubagentCount: 0 },
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

  it('allows end only when there is a running process', () => {
    expect(sessionMenuEligibility(meta({ status: 'live' })).canEnd).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'starting' })).canEnd).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'reconnecting' })).canEnd).toBe(true)
    expect(sessionMenuEligibility(meta({ status: 'exited' })).canEnd).toBe(false)
    expect(sessionMenuEligibility(meta({ status: 'hibernated' })).canEnd).toBe(false)
  })

  // Delete is NOT gated on a running process (POD-1077). The old `canClose`
  // rule hid the row on exited and hibernated sessions — precisely the ones an
  // operator wants to clear away — so the only way to remove a dead session's
  // row was to resume it first.
  it('offers delete in every status, running or not', () => {
    for (const status of ['live', 'starting', 'reconnecting', 'exited', 'hibernated'] as const) {
      expect(sessionMenuEligibility(meta({ status })).canDelete).toBe(true)
    }
  })

  it('offers mark-unread on a read session and mark-read on an unread one (#138)', () => {
    const read = sessionMenuEligibility(meta({ unread: false }))
    expect(read.canMarkUnread).toBe(true)
    expect(read.canMarkRead).toBe(false)
    const unread = sessionMenuEligibility(meta({ unread: true }))
    expect(unread.canMarkUnread).toBe(false)
    expect(unread.canMarkRead).toBe(true)
  })
})

describe('handoff reason copy (POD-821)', () => {
  it('names the harness the user actually sees, not the wire kind', () => {
    expect(handoffBlockerText('harness', 'shell')).toBe("Shell sessions can't be handed off")
    expect(handoffRejectionText('harness-missing', 'claude-code')).toBe('no Claude')
    expect(handoffRejectionText('inventory-unavailable', 'claude-code')).toBe('inventory pending')
    expect(handoffRejectionText('harness-probe-timed-out', 'claude-code')).toBe(
      'probe timed out; retry',
    )
    expect(
      handoffRejectionText('harness-probe-timed-out', 'claude-code', {
        inventory: {
          agents: [
            {
              kind: 'claude-code',
              installed: null,
              probeError: { reason: 'timed-out', timeoutMs: 60_000 },
              login: { state: 'in' },
            },
          ],
          os: 'linux',
          arch: 'x64',
          tools: [],
        },
      }),
    ).toBe('probe timed out after 60s; retry')
    expect(handoffRejectionText('repo-missing', 'codex')).toBe('no clone URL for repo')
  })

  it('says "no access" for a denied machine, not "offline" (POD-303)', () => {
    // The two reasons need opposite responses from the user — ask the machine's
    // owner for `use`, versus wait for it to come back — so the copy must not
    // reuse the offline wording. Asserted as a PAIR: same call, same harness,
    // only the rejection differs, and the strings differ with it.
    expect(handoffRejectionText('unauthorized', 'codex')).toBe('no access')
    expect(handoffRejectionText('offline', 'codex')).toBe('offline')
    expect(handoffRejectionText('unauthorized', 'codex')).not.toBe(
      handoffRejectionText('offline', 'codex'),
    )
  })

  it('explains a blocked session in terms of what would unblock it', () => {
    expect(handoffBlockerText('no-worktree', 'claude-code')).toBe(
      'Only sessions in a worktree can be handed off',
    )
    expect(handoffBlockerText('repo-unregistered', 'claude-code')).toBe(
      "This repo isn't registered on another machine",
    )
    expect(handoffRejectionText('offline', 'claude-code')).toBe('offline')
  })
})
