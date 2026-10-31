import { describe, expect, it } from 'vitest'
import { composerState, issueClosedPlaceholder } from './compose/chat'
import { sessionIssueOutcome } from './session-outcome'

const stopped = {
  status: 'hibernated',
  stopReason: 'parent',
  stoppedAt: '2026-10-26T19:59:05Z',
} as const
const landed = {
  stage: 'done',
  closedReason: 'done',
  closedAt: '2026-10-26T19:59:01Z',
  landedAt: '2026-10-26T19:59:00Z',
  landedSha: 'fcd1385aa9e0',
  parentBranch: 'tf.dev',
}

describe('sessionIssueOutcome (POD-2151)', () => {
  it('a session stopped by its landed issue ends Landed on the parent branch', () => {
    expect(sessionIssueOutcome(stopped, landed)).toEqual({
      kind: 'landed',
      at: landed.landedAt,
      branch: 'tf.dev',
      sha: 'fcd1385',
    })
    // Unlanded work outranks the stamp, which outlives a reopen.
    const reopened = {
      ...landed,
      branch: 'issue/1-x',
      gitState: { updatedAt: '2026-10-26T20:30:00Z', shared: false, ahead: 1 },
    }
    expect(sessionIssueOutcome(stopped, reopened)).toMatchObject({ kind: 'closed', reason: 'done' })
    // An exit (no resume ref) is the same ending.
    expect(sessionIssueOutcome({ ...stopped, status: 'exited' }, landed)?.kind).toBe('landed')
  })

  it('a close without a landing ends Closed as its reason', () => {
    const cancelled = { stage: 'done', closedReason: 'cancelled', closedAt: landed.closedAt }
    expect(sessionIssueOutcome(stopped, cancelled)).toEqual({
      kind: 'closed',
      at: landed.closedAt,
      reason: 'cancelled',
    })
    const done = { ...cancelled, closedReason: 'done' }
    expect(sessionIssueOutcome(stopped, done)).toMatchObject({ kind: 'closed', reason: 'done' })
  })

  it('every other stop keeps today’s pane', () => {
    // Stopped by the agent itself, forced, or still running.
    expect(sessionIssueOutcome({ ...stopped, stopReason: 'self' }, landed)).toBeNull()
    expect(sessionIssueOutcome({ ...stopped, stopReason: 'forced' }, landed)).toBeNull()
    expect(sessionIssueOutcome({ ...stopped, status: 'live' }, landed)).toBeNull()
    // The issue is still open: an operator's plain stop is also 'parent'.
    expect(sessionIssueOutcome(stopped, { stage: 'in_progress' })).toBeNull()
    // Parked before the issue closed: it did not end with the issue.
    expect(
      sessionIssueOutcome({ ...stopped, stoppedAt: '2026-10-26T18:00:00Z' }, landed),
    ).toBeNull()
    expect(sessionIssueOutcome(undefined, landed)).toBeNull()
    expect(sessionIssueOutcome(stopped, undefined)).toBeNull()
  })
})

describe('issueClosedPlaceholder (POD-2151)', () => {
  const state = (status: 'hibernated' | 'exited' | 'live', queuedMessageCount = 0) =>
    composerState({
      session: { status, resumable: false, agentState: undefined, queuedMessageCount },
      headless: false,
      turnRunning: false,
      compact: false,
    })

  it('says the issue stays closed where a message resumes the agent', () => {
    expect(issueClosedPlaceholder(state('hibernated'))).toBe(
      'Message the agent to resume it — the issue stays closed…',
    )
  })

  it('leaves every other placeholder as it is', () => {
    expect(issueClosedPlaceholder(state('exited'))).toBe('Session is not running.')
    expect(issueClosedPlaceholder(state('live'))).toBe('Message the agent…')
  })
})
