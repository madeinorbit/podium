import { describe, expect, it } from 'vitest'
import { initialAgentState, reduceAgentState, withEventTime } from './reducer'

const T0 = '2026-06-12T10:00:00.000Z'
const T1 = '2026-06-12T10:00:01.000Z'
const EVENT_TIME = '2026-06-12T09:30:00.000Z'

describe('reduceAgentState', () => {
  it('starts unknown, goes idle on session_started', () => {
    const s0 = initialAgentState(T0)
    expect(s0.phase).toBe('unknown')
    const s1 = reduceAgentState(s0, { kind: 'session_started' }, T1)
    expect(s1).toMatchObject({ phase: 'idle', since: T1, nativeSubagentCount: 0 })
  })

  it('prompt_submitted → working, clearing idle/need/error detail', () => {
    let s = initialAgentState(T0)
    s = reduceAgentState(s, { kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.phase).toBe('working')
    expect(s.error).toBeUndefined()
  })

  it('activity while already working is a no-op (same reference)', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const again = reduceAgentState(s, { kind: 'activity' }, T1)
    expect(again).toBe(s)
  })

  it('activity clears needs_user (the user answered)', () => {
    let s = reduceAgentState(
      initialAgentState(T0),
      { kind: 'needs_user', need: 'question', summary: 'pick one' },
      T0,
    )
    expect(s).toMatchObject({
      phase: 'needs_user',
      need: { kind: 'question', summary: 'pick one' },
    })
    s = reduceAgentState(s, { kind: 'activity' }, T1)
    expect(s.phase).toBe('working')
    expect(s.need).toBeUndefined()
  })

  it('turn_completed defaults to done when no native subagents are live', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const idle = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(idle).toMatchObject({ phase: 'idle', idle: { kind: 'done' }, nativeSubagentCount: 0 })
  })

  it('turn_completed with nativeSubagentCount > 0 stays working + awaitingSubagents', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T0)
    const next = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(next).toMatchObject({
      phase: 'working',
      nativeSubagentCount: 1,
      awaitingSubagents: true,
    })
    expect(next.idle).toBeUndefined()
    // Old bug: bare done + count>0 invented idle.kind 'open_todos'. Gone.
    expect(next).not.toMatchObject({ phase: 'idle', idle: { kind: 'open_todos' } })
  })

  it('task_delta→0 while awaitingSubagents settles to idle (done) and clears the flag', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(s).toMatchObject({ phase: 'working', awaitingSubagents: true, nativeSubagentCount: 1 })
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(s).toMatchObject({
      phase: 'idle',
      idle: { kind: 'done' },
      nativeSubagentCount: 0,
    })
    expect(s.awaitingSubagents).toBeUndefined()
  })

  it('task_delta→0 without awaitingSubagents stays working (no spurious idle)', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(s).toMatchObject({ phase: 'working', nativeSubagentCount: 0 })
    expect(s.awaitingSubagents).toBeUndefined()
    expect(s.idle).toBeUndefined()
  })

  it('awaitingSubagents is cleared when the session returns to genuine work', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(s.awaitingSubagents).toBe(true)

    // New turn before subagents finish.
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s).toMatchObject({ phase: 'working', nativeSubagentCount: 1 })
    expect(s.awaitingSubagents).toBeUndefined()

    // Re-hold, then tool activity also clears the hold flag.
    s = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(s.awaitingSubagents).toBe(true)
    s = reduceAgentState(s, { kind: 'activity' }, T1)
    expect(s).toMatchObject({ phase: 'working', nativeSubagentCount: 1 })
    expect(s.awaitingSubagents).toBeUndefined()
    // Mid-turn drain after the flag was cleared must not idle.
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(s).toMatchObject({ phase: 'working', nativeSubagentCount: 0 })
  })

  it('turn_completed with count 0 passes question/approval/interrupted verdicts through', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const question = reduceAgentState(
      s,
      { kind: 'turn_completed', verdict: { kind: 'question', summary: 'A or B?' } },
      T1,
    )
    expect(question).toMatchObject({
      phase: 'idle',
      idle: { kind: 'question', summary: 'A or B?' },
    })
    const approval = reduceAgentState(
      s,
      { kind: 'turn_completed', verdict: { kind: 'approval', summary: 'run rm?' } },
      T1,
    )
    expect(approval).toMatchObject({
      phase: 'idle',
      idle: { kind: 'approval', summary: 'run rm?' },
    })
  })

  it('turn_completed with live subagents stays working even for question/interrupted', () => {
    let s = reduceAgentState(
      initialAgentState(T0),
      { kind: 'needs_user', need: 'question', summary: 'A or B?' },
      T0,
    )
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    const next = reduceAgentState(
      s,
      {
        kind: 'turn_completed',
        verdict: { kind: 'interrupted', summary: 'request interrupted by user' },
      },
      T1,
    )
    expect(next).toMatchObject({
      phase: 'working',
      nativeSubagentCount: 1,
      awaitingSubagents: true,
    })
    expect(next.idle).toBeUndefined()
    expect(next.need).toBeUndefined()
  })

  it('task_delta floors at zero and is a no-op when already zero', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const next = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(next).toBe(s) // 0 → 0 is a no-op
  })

  it('turn_failed → errored with class + retryable', () => {
    const s = reduceAgentState(
      initialAgentState(T0),
      { kind: 'turn_failed', errorClass: 'billing_error', retryable: false },
      T1,
    )
    expect(s).toMatchObject({
      phase: 'errored',
      error: { class: 'billing_error', retryable: false },
    })
  })

  it('compaction start/end → compacting → working', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'compaction', phase: 'start' }, T0)
    expect(s.phase).toBe('compacting')
    s = reduceAgentState(s, { kind: 'compaction', phase: 'end' }, T1)
    expect(s.phase).toBe('working')
  })

  it('session_ended → ended', () => {
    expect(reduceAgentState(initialAgentState(T0), { kind: 'session_ended' }, T1).phase).toBe(
      'ended',
    )
  })

  it('nativeSubagentCount survives phase transitions', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.nativeSubagentCount).toBe(1)
  })

  it('task_delta with agentId tracks nativeSubagents and keeps count consistent', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(
      s,
      { kind: 'task_delta', delta: 1, agentId: 'ad7e66922f0d8ff7a', agentType: 'Explore' },
      T0,
    )
    expect(s).toMatchObject({
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'ad7e66922f0d8ff7a', type: 'Explore' }],
    })

    // Second distinct subagent.
    s = reduceAgentState(
      s,
      {
        kind: 'task_delta',
        delta: 1,
        agentId: 'abb71646a07e32e0d',
        agentType: 'general-purpose',
      },
      T0,
    )
    expect(s.nativeSubagentCount).toBe(2)
    expect(s.nativeSubagents).toEqual([
      { id: 'ad7e66922f0d8ff7a', type: 'Explore' },
      { id: 'abb71646a07e32e0d', type: 'general-purpose' },
    ])

    // Duplicate start is a no-op (same reference).
    const again = reduceAgentState(
      s,
      { kind: 'task_delta', delta: 1, agentId: 'ad7e66922f0d8ff7a', agentType: 'Explore' },
      T1,
    )
    expect(again).toBe(s)

    // Remove one; count matches remaining list.
    s = reduceAgentState(
      s,
      { kind: 'task_delta', delta: -1, agentId: 'ad7e66922f0d8ff7a' },
      T1,
    )
    expect(s).toMatchObject({
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'abb71646a07e32e0d', type: 'general-purpose' }],
    })

    // Last stop clears the list key.
    s = reduceAgentState(
      s,
      { kind: 'task_delta', delta: -1, agentId: 'abb71646a07e32e0d' },
      T1,
    )
    expect(s.nativeSubagentCount).toBe(0)
    expect(s.nativeSubagents).toBeUndefined()
  })

  it('identity list survives phase transitions and settles idle with the last stop', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(
      s,
      { kind: 'task_delta', delta: 1, agentId: 'agent-1', agentType: 'Explore' },
      T0,
    )
    s = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(s).toMatchObject({
      phase: 'working',
      awaitingSubagents: true,
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'agent-1', type: 'Explore' }],
    })
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1, agentId: 'agent-1' }, T1)
    expect(s).toMatchObject({
      phase: 'idle',
      idle: { kind: 'done' },
      nativeSubagentCount: 0,
    })
    expect(s.nativeSubagents).toBeUndefined()
    expect(s.awaitingSubagents).toBeUndefined()
  })

  it('identity mode ignores anonymous deltas so count never diverges from the list', () => {
    // Invariant: count tracks list length (0 when list absent).
    const countMatchesList = (s: ReturnType<typeof initialAgentState>) => {
      expect(s.nativeSubagentCount).toBe(s.nativeSubagents?.length ?? 0)
    }

    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1, agentId: 'A', agentType: 'Explore' }, T0)
    expect(s).toMatchObject({
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'A', type: 'Explore' }],
    })
    countMatchesList(s)

    // Anonymous ±1 while identity list is live must not move the count.
    const afterAnonPlus = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T1)
    expect(afterAnonPlus).toBe(s)
    const afterAnonMinus = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(afterAnonMinus).toBe(s)
    expect(s).toMatchObject({
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'A', type: 'Explore' }],
    })
    countMatchesList(s)

    s = reduceAgentState(s, { kind: 'task_delta', delta: -1, agentId: 'A' }, T1)
    expect(s.nativeSubagentCount).toBe(0)
    expect(s.nativeSubagents).toBeUndefined()
    countMatchesList(s)
  })

  it('session_ended clears nativeSubagents and awaitingSubagents', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(
      s,
      { kind: 'task_delta', delta: 1, agentId: 'live-1', agentType: 'Explore' },
      T0,
    )
    s = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(s).toMatchObject({
      awaitingSubagents: true,
      nativeSubagentCount: 1,
      nativeSubagents: [{ id: 'live-1', type: 'Explore' }],
    })

    s = reduceAgentState(s, { kind: 'session_ended' }, T1)
    expect(s.phase).toBe('ended')
    expect(s.nativeSubagentCount).toBe(0)
    expect(s.nativeSubagents).toBeUndefined()
    expect(s.awaitingSubagents).toBeUndefined()
  })

  it('accumulates working and compacting stretches across waiting transitions', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    s = reduceAgentState(s, { kind: 'compaction', phase: 'start' }, T1)
    expect(s.workingMsTotal).toBe(1_000)

    s = reduceAgentState(s, { kind: 'compaction', phase: 'end' }, '2026-06-12T10:00:03.000Z')
    expect(s.workingMsTotal).toBe(3_000)

    s = reduceAgentState(s, { kind: 'turn_completed' }, '2026-06-12T10:00:05.000Z')
    expect(s.workingMsTotal).toBe(5_000)

    s = reduceAgentState(s, { kind: 'prompt_submitted' }, '2026-06-12T10:00:08.000Z')
    expect(s.workingMsTotal).toBe(5_000)
    s = reduceAgentState(s, { kind: 'needs_user', need: 'question' }, '2026-06-12T10:00:10.000Z')
    expect(s.workingMsTotal).toBe(7_000)
  })

  it('starts accumulating from zero when a legacy state has no total', () => {
    const legacy = { phase: 'working' as const, since: T0, nativeSubagentCount: 0 }
    const stopped = reduceAgentState(legacy, { kind: 'turn_completed' }, T1)
    expect(stopped.workingMsTotal).toBe(1_000)
  })

  it('uses the event-time (event.at) for `since`, not the observe-time `now`', () => {
    // A poller replaying an old transcript record on reattach must produce the
    // record's real timestamp as `since` — not "now" — so recency stays stable.
    const s = reduceAgentState(
      initialAgentState(T0),
      { kind: 'turn_completed', at: EVENT_TIME },
      T1,
    )
    expect(s.since).toBe(EVENT_TIME)
  })

  it('falls back to `now` for `since` when the event carries no event-time', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T1)
    expect(s.since).toBe(T1)
  })
})

describe('withEventTime', () => {
  it('stamps `at` onto events that lack it', () => {
    const out = withEventTime([{ kind: 'prompt_submitted' }, { kind: 'activity' }], EVENT_TIME)
    expect(out).toEqual([
      { kind: 'prompt_submitted', at: EVENT_TIME },
      { kind: 'activity', at: EVENT_TIME },
    ])
  })

  it('leaves an event that already has `at` untouched', () => {
    const out = withEventTime([{ kind: 'activity', at: T0 }], EVENT_TIME)
    expect(out[0]?.at).toBe(T0)
  })

  it('is a no-op when no event-time is available', () => {
    const events = [{ kind: 'activity' as const }]
    expect(withEventTime(events, undefined)).toBe(events)
  })
})
