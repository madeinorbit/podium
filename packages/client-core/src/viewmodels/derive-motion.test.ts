import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { formatClock, motionPhase, motionTiming } from './derive'

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

function agentState(over: Partial<AgentRuntimeState>): AgentRuntimeState {
  return {
    phase: 'unknown',
    since: new Date(NOW - 60_000).toISOString(),
    openTaskCount: 0,
    ...over,
  } as AgentRuntimeState
}

describe('motionPhase — the four phases of the motion grammar', () => {
  it('working / compacting agents are working', () => {
    expect(motionPhase(sess({ agentState: agentState({ phase: 'working' }) }))).toBe('working')
    expect(motionPhase(sess({ agentState: agentState({ phase: 'compacting' }) }))).toBe('working')
  })

  it('needs_user and errored are waiting (amber stillness)', () => {
    expect(motionPhase(sess({ agentState: agentState({ phase: 'needs_user' }) }))).toBe('waiting')
    expect(motionPhase(sess({ agentState: agentState({ phase: 'errored' }) }))).toBe('waiting')
  })

  it('idle with a pending verdict (question/approval/open_todos) is waiting', () => {
    for (const kind of ['question', 'approval', 'open_todos'] as const) {
      expect(motionPhase(sess({ agentState: agentState({ phase: 'idle', idle: { kind } }) }))).toBe(
        'waiting',
      )
    }
  })

  it('a finished run (idle done / ended) is done', () => {
    expect(
      motionPhase(sess({ agentState: agentState({ phase: 'idle', idle: { kind: 'done' } }) })),
    ).toBe('done')
    expect(motionPhase(sess({ agentState: agentState({ phase: 'ended' }) }))).toBe('done')
  })

  it('a hibernated session keeps its last phase (parked needs-input stays waiting)', () => {
    expect(
      motionPhase(sess({ status: 'hibernated', agentState: agentState({ phase: 'needs_user' }) })),
    ).toBe('waiting')
  })

  it('shells are working only while a command runs', () => {
    expect(motionPhase(sess({ agentKind: 'shell', busy: true }))).toBe('working')
    expect(motionPhase(sess({ agentKind: 'shell', busy: false }))).toBe('queued')
  })

  it('booting / exited / uninstrumented-quiet sessions are queued (dim stillness)', () => {
    expect(motionPhase(sess({ status: 'starting' }))).toBe('queued')
    expect(motionPhase(sess({ status: 'exited' }))).toBe('queued')
    expect(motionPhase(sess())).toBe('queued') // live but no agentState yet
  })
})
describe('motionTiming — canonical PhaseTimer inputs', () => {
  it('exposes the persisted base for a live working stretch', () => {
    const since = NOW - 10_000
    expect(
      motionTiming(
        sess({
          agentState: agentState({
            phase: 'working',
            since: new Date(since).toISOString(),
            workingMsTotal: 330_000,
          }),
        }),
      ),
    ).toEqual({ phase: 'working', sinceMs: since, baseMs: 330_000 })
  })

  it('exposes the persisted total only when the run is done', () => {
    const timing = motionTiming(
      sess({
        agentState: agentState({
          phase: 'idle',
          idle: { kind: 'done' },
          workingMsTotal: 340_000,
        }),
      }),
    )
    expect(timing).toEqual({
      phase: 'done',
      sinceMs: NOW - 60_000,
      totalMs: 340_000,
    })
  })

  it('keeps timing fields absent for legacy runtime state', () => {
    expect(motionTiming(sess({ agentState: agentState({ phase: 'working' }) }))).toEqual({
      phase: 'working',
      sinceMs: NOW - 60_000,
    })
  })
})

describe('formatClock — the motion m:ss format', () => {
  it('formats seconds and minutes as m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7_000)).toBe('0:07')
    expect(formatClock(390_000)).toBe('6:30')
  })

  it('never rolls minutes into hours', () => {
    expect(formatClock(4_335_000)).toBe('72:15')
  })

  it('clamps negatives to zero', () => {
    expect(formatClock(-5_000)).toBe('0:00')
  })
})
