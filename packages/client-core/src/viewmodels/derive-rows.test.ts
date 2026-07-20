import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  isUnstartedSession,
  rowMotionPhase,
  rowMotionTiming,
  rowStatusLine,
  rowWaitingCount,
  type UnifiedWorkRow,
} from './derive'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')

function sess(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
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

function agentState(over: Partial<AgentRuntimeState>): AgentRuntimeState {
  return {
    phase: 'unknown',
    since: new Date(NOW - 60_000).toISOString(),
    nativeSubagentCount: 0,
    ...over,
  } as AgentRuntimeState
}

const working = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'working', ...over }) })
const waiting = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'needs_user', need: { kind: 'question' }, ...over }) })
const done = (over: Partial<AgentRuntimeState> = {}) =>
  sess({ agentState: agentState({ phase: 'idle', idle: { kind: 'done' }, ...over }) })

function issueRow(
  sessions: SessionMeta[],
  draft = false,
  issueOver: Record<string, unknown> = {},
): UnifiedWorkRow {
  return {
    kind: 'issue',
    issue: { id: 'i1', updatedAt: new Date(NOW).toISOString(), draft, ...issueOver },
    sessions,
    activityAt: NOW - 120_000,
    rank: 0,
  } as unknown as UnifiedWorkRow
}

describe('rowMotionPhase — aggregate row phase (#41)', () => {
  it('waiting dominates working; working dominates done; all-done rows are done', () => {
    expect(rowMotionPhase(issueRow([working(), waiting()]))).toBe('waiting')
    expect(rowMotionPhase(issueRow([working(), done()]))).toBe('working')
    expect(rowMotionPhase(issueRow([done(), done()]))).toBe('done')
  })

  it('idle-ready or empty rows read queued (dimmed stillness)', () => {
    expect(rowMotionPhase(issueRow([sess()]))).toBe('queued')
    expect(rowMotionPhase(issueRow([]))).toBe('queued')
  })
})

describe('rowWaitingCount — the amber pill / rail badge number', () => {
  it('counts exactly the waiting member sessions', () => {
    expect(rowWaitingCount(issueRow([waiting(), waiting(), working(), done()]))).toBe(2)
    expect(rowWaitingCount(issueRow([working()]))).toBe(0)
  })
})

describe('rowStatusLine — the second line copy grammar', () => {
  it('waiting rows surface what is waited for; multi-agent rows carry the head-count', () => {
    expect(rowStatusLine(issueRow([waiting()]), NOW)).toBe('needs answer')
    expect(rowStatusLine(issueRow([waiting(), working(), done()]), NOW)).toBe(
      '3 agents · needs answer',
    )
  })

  it('working, done and queued rows read as their phase', () => {
    expect(rowStatusLine(issueRow([working()]), NOW)).toBe('working')
    expect(rowStatusLine(issueRow([done()]), NOW)).toBe('done')
    expect(rowStatusLine(issueRow([sess()]), NOW)).toBe('queued')
    expect(rowStatusLine(issueRow([working(), working()]), NOW)).toBe('2 agents · working')
  })

  it('child progress reads as subtasks; open subtasks override a bare "done" (POD-85)', () => {
    // The old grammar produced "done · 0/1 done" — nonsense to a human.
    expect(
      rowStatusLine(issueRow([done()], false, { childCount: 1, childDoneCount: 0 }), NOW),
    ).toBe('0/1 subtasks done')
    expect(
      rowStatusLine(issueRow([working()], false, { childCount: 3, childDoneCount: 1 }), NOW),
    ).toBe('working · 1/3 subtasks')
    // All subtasks done: plain "done", no redundant tally.
    expect(
      rowStatusLine(issueRow([done()], false, { childCount: 2, childDoneCount: 2 }), NOW),
    ).toBe('done')
  })

  it('a draft vessel with only unstarted sessions reads "awaiting first prompt", not "queued"', () => {
    const fresh = sess({ title: '✳ Claude Code' })
    expect(rowStatusLine(issueRow([fresh], true), NOW)).toBe('awaiting first prompt')
    // Same session under a REAL issue keeps the phase grammar.
    expect(rowStatusLine(issueRow([fresh]), NOW)).toBe('queued')
    // A draft whose session was actually prompted (meaningful title) stays queued.
    expect(rowStatusLine(issueRow([sess()], true), NOW)).toBe('queued')
  })
})

describe('isUnstartedSession — blank-vessel detection', () => {
  it('boot-noise titles (harness name, cwd basename, empty) with no user name are unstarted', () => {
    expect(isUnstartedSession(sess({ title: '✳ Claude Code' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: 'Claude' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: '' }))).toBe(true)
    expect(isUnstartedSession(sess({ title: 'acme', agentKind: 'codex' }))).toBe(true)
  })

  it('a user-set name or a real title means the session has started', () => {
    expect(isUnstartedSession(sess({ title: '✳ Claude Code', name: 'My task' }))).toBe(false)
    expect(isUnstartedSession(sess({ title: '✳ Fix login popup' }))).toBe(false)
  })
})

describe('rowMotionTiming — the line-2 timer inputs', () => {
  it('working rows count from the EARLIEST working start, carrying its base total', () => {
    const early = working({ since: new Date(NOW - 300_000).toISOString(), workingMsTotal: 42_000 })
    const late = working({ since: new Date(NOW - 60_000).toISOString() })
    const t = rowMotionTiming(issueRow([late, early]))
    expect(t.phase).toBe('working')
    expect(t.sinceMs).toBe(NOW - 300_000)
    expect(t.baseMs).toBe(42_000)
  })

  it('waiting rows freeze at the longest wait', () => {
    const shortWait = waiting({ since: new Date(NOW - 60_000).toISOString() })
    const longWait = waiting({ since: new Date(NOW - 7_200_000).toISOString() })
    const t = rowMotionTiming(issueRow([shortWait, longWait, working()]))
    expect(t.phase).toBe('waiting')
    expect(t.sinceMs).toBe(NOW - 7_200_000)
  })

  it('done rows sum every member total for the ∑ stamp; totals absent → none', () => {
    const a = done({ workingMsTotal: 30_000 })
    const b = done({ workingMsTotal: 12_000 })
    expect(rowMotionTiming(issueRow([a, b])).totalMs).toBe(42_000)
    expect(rowMotionTiming(issueRow([done()])).totalMs).toBeUndefined()
  })

  it('queued rows fall back to the row activity stamp', () => {
    const t = rowMotionTiming(issueRow([sess()]))
    expect(t.phase).toBe('queued')
    expect(t.sinceMs).toBe(NOW - 120_000)
  })
})
