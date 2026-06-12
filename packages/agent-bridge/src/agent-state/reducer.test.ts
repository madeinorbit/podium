import { describe, expect, it } from 'vitest'
import { initialAgentState, reduceAgentState } from './reducer'

const T0 = '2026-06-12T10:00:00.000Z'
const T1 = '2026-06-12T10:00:01.000Z'

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
    expect(s).toMatchObject({ phase: 'needs_user', need: { kind: 'question', summary: 'pick one' } })
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
    expect(s).toMatchObject({ phase: 'errored', error: { class: 'billing_error', retryable: false } })
  })

  it('compaction start/end → compacting → working', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'compaction', phase: 'start' }, T0)
    expect(s.phase).toBe('compacting')
    s = reduceAgentState(s, { kind: 'compaction', phase: 'end' }, T1)
    expect(s.phase).toBe('working')
  })

  it('session_ended → ended', () => {
    expect(reduceAgentState(initialAgentState(T0), { kind: 'session_ended' }, T1).phase).toBe('ended')
  })

  it('openTaskCount survives phase transitions', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.openTaskCount).toBe(1)
  })
})
