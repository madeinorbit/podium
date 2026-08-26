import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { hibernateAction, recoveryAction } from './lifecycle-actions'

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
    resumable: true,
    ...over,
  } as unknown as SessionMeta
}

describe('recoveryAction', () => {
  it('wakes a parked session, whatever the exit verb would have been', () => {
    const a = recoveryAction('parked', 'resume')
    expect(a.run).toBe('resurrect')
    expect([a.label, a.compactLabel, a.busyLabel]).toEqual(['Resume session', 'Resume', 'Waking…'])
  })

  it('restarts a shell, which has nothing to lose', () => {
    const a = recoveryAction('ended', 'restart')
    expect(a.run).toBe('resurrect')
    expect([a.label, a.compactLabel, a.busyLabel]).toEqual([
      'Restart shell',
      'Restart',
      'Restarting…',
    ])
    expect(a.hint).toContain('fresh shell in the same directory')
  })

  it('resumes an exited agent that left a ref', () => {
    const a = recoveryAction('ended', 'resume')
    expect(a.busyLabel).toBe('Resuming…')
    expect(a.hint).toContain('resume to pick up where it left off')
  })

  it('keeps NO busy state for remove — the row goes away, so there is nothing to re-label', () => {
    const a = recoveryAction('ended', 'remove')
    expect(a.run).toBe('kill')
    expect(a.busyLabel).toBeNull()
  })

  it('offers a fresh start to an agent that died before opening a conversation', () => {
    // The Codex-updater case (POD-2392). Same `resurrect` call as Resume — the
    // server decides it goes out without a ref — but never the same WORDS:
    // "Resume" over a conversation that never existed is a promise the user only
    // discovers is empty afterwards.
    const a = recoveryAction('ended', 'relaunch')
    expect(a.run).toBe('resurrect')
    expect([a.label, a.compactLabel, a.busyLabel]).toEqual([
      'Start the agent again',
      'Start again',
      'Starting…',
    ])
    expect(a.hint).toContain('nothing to resume')
    expect(a.label).not.toContain('Resume')
  })

  it('gives removal its one honest reason', () => {
    // The worktree-gone variant of this hint ("Remove it to clear it away.") went
    // with the flag that produced it (POD-1704) — it was the copy shown when a
    // degraded repo scan made the UI believe a live worktree had been deleted.
    // Removal used to claim "It left no conversation to resume", which POD-2392
    // showed was the wrong half of the fact: the case we can PROVE left no
    // conversation is `relaunch` above. Removal is the case where a conversation
    // may well exist and nothing recorded the way back to it — which is exactly
    // why starting over is not offered here.
    expect(recoveryAction('ended', 'remove').hint).toBe(
      'No way back into its conversation was recorded.',
    )
  })
})

describe('hibernateAction', () => {
  it('offers hibernation for a live, resumable agent', () => {
    const a = hibernateAction(meta({}))
    expect(a?.id).toBe('hibernate')
    expect(a?.disabledReason).toBeNull()
  })

  it('OFFERS it mid-turn and says why, rather than hiding it', () => {
    // The context menu hides what you cannot do now; the panel is the session's
    // own home and owes the explanation. Same eligibility, different affordance.
    const a = hibernateAction(
      meta({
        agentState: { phase: 'working', since: '2026-06-03T00:00:00.000Z', nativeSubagentCount: 0 },
      }),
    )
    expect(a?.disabledReason).toBe('Agent is working — hibernate once it reaches idle')
    expect(
      hibernateAction(
        meta({
          agentState: {
            phase: 'compacting',
            since: '2026-06-03T00:00:00.000Z',
            nativeSubagentCount: 0,
          },
        }),
      )?.disabledReason,
    ).toBe('Agent is working — hibernate once it reaches idle')
  })

  it('does not offer it for a session that cannot come back', () => {
    expect(hibernateAction(meta({ resumable: false }))).toBeNull()
  })

  it('does not offer it for a session with no process to park', () => {
    expect(hibernateAction(meta({ status: 'hibernated' }))).toBeNull()
    expect(hibernateAction(meta({ status: 'exited' }))).toBeNull()
  })

  it('does not offer it before the process exists — the divergence this replaced', () => {
    // AgentPanel used to read `!hibernated && !exited && resumable`, so it
    // offered Hibernate on a `starting`/`reconnecting` session where the shared
    // rule (`sessionMenuEligibility`, and the server) says no.
    expect(hibernateAction(meta({ status: 'starting' }))).toBeNull()
    expect(hibernateAction(meta({ status: 'reconnecting' }))).toBeNull()
  })

  it('has nothing to say about a session that has not arrived', () => {
    expect(hibernateAction(undefined)).toBeNull()
  })
})
