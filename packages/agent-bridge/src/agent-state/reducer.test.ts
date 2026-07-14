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
    expect(s1).toMatchObject({ phase: 'idle', since: T1, openTaskCount: 0 })
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

  it('turn_completed defaults to done, upgrades to open_todos when tasks remain', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    expect(reduceAgentState(s, { kind: 'turn_completed' }, T1).idle).toEqual({ kind: 'done' })
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T0)
    const idle = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(idle.idle?.kind).toBe('open_todos')
    expect(idle.openTaskCount).toBe(1)
  })

  it('a provider verdict (question/approval) outranks open todos', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    const idle = reduceAgentState(
      s,
      { kind: 'turn_completed', verdict: { kind: 'question', summary: 'A or B?' } },
      T1,
    )
    expect(idle.idle).toEqual({ kind: 'question', summary: 'A or B?' })
  })

  it('interrupted outranks open todos and clears active blockers', () => {
    let s = reduceAgentState(
      initialAgentState(T0),
      { kind: 'needs_user', need: 'question', summary: 'A or B?' },
      T0,
    )
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    const idle = reduceAgentState(
      s,
      {
        kind: 'turn_completed',
        verdict: { kind: 'interrupted', summary: 'request interrupted by user' },
      },
      T1,
    )
    expect(idle).toMatchObject({
      phase: 'idle',
      openTaskCount: 1,
      idle: { kind: 'interrupted', summary: 'request interrupted by user' },
    })
    expect(idle.need).toBeUndefined()
  })

  it('task_delta floors at zero and never changes phase', () => {
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

  it('openTaskCount survives phase transitions', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.openTaskCount).toBe(1)
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
    const legacy = { phase: 'working' as const, since: T0, openTaskCount: 0 }
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
