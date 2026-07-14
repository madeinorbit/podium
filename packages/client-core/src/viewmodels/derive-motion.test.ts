import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { formatClock, motionPhase } from './derive'

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
