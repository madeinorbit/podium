import { describe, expect, it } from 'vitest'
import { dedupeSessionsByResume, type ResumableSession } from './session-identity'

function session(
  sessionId: string,
  status: string,
  resumeValue: string,
  lastActiveAt: string,
): ResumableSession {
  return {
    sessionId,
    status,
    lastActiveAt,
    resume: { kind: 'codex-thread', value: resumeValue },
  }
}

describe('dedupeSessionsByResume live identity', () => {
  it('never uses a native ref to hide a Podium row when the group contains a live pane', () => {
    const rows = [
      session('parked-pane', 'hibernated', 'thread-collision', '2026-07-16T08:00:00Z'),
      session('live-pane', 'live', 'thread-collision', '2026-07-16T09:00:00Z'),
    ]

    expect(dedupeSessionsByResume(rows).map((row) => row.sessionId)).toEqual([
      'parked-pane',
      'live-pane',
    ])
  })

  it('still collapses all-parked legacy duplicates', () => {
    const rows = [
      session('old-pane', 'exited', 'thread-legacy', '2026-07-15T08:00:00Z'),
      session('new-pane', 'hibernated', 'thread-legacy', '2026-07-16T08:00:00Z'),
    ]

    expect(dedupeSessionsByResume(rows).map((row) => row.sessionId)).toEqual(['new-pane'])
  })
})
