/**
 * When a running Codex session on a ChatGPT plan restarts for a fresh token
 * (epic Task 15; review focus 1 and 2 of its plan). The clock and the timers
 * are the test's.
 */
import { asSessionId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { PlanSessionRenewal, RESTART_WHEN_LEFT_MS, SESSION_TOKEN_MIN_LEFT_MS } from './session-renewal'

const T0 = Date.parse('2026-11-17T09:00:00Z')
const MIN = 60_000
const A = asSessionId('00000000-0000-4000-8000-00000000a015')
const B = asSessionId('00000000-0000-4000-8000-00000000b015')

function world() {
  let now = T0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const restarts: SessionId[] = []
  const renewal = new PlanSessionRenewal({
    now: () => now,
    setTimer: (at, fn) => {
      const timer = { at, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    restartAtTurnBoundary: async (sessionId) => {
      restarts.push(sessionId)
    },
  })
  /** Move the clock and fire every timer that came due. */
  const advanceTo = (t: number) => {
    now = t
    for (const timer of timers) {
      if (timer.live && timer.at <= now) {
        timer.live = false
        timer.fn()
      }
    }
  }
  return { renewal, restarts, advanceTo, now: () => now }
}

describe('PlanSessionRenewal', () => {
  it('the margins: a session starts with 40 minutes or more, restarts at 25 left', () => {
    expect(SESSION_TOKEN_MIN_LEFT_MS).toBe(40 * MIN)
    expect(RESTART_WHEN_LEFT_MS).toBe(25 * MIN)
    // Every delivered token leaves at least 15 minutes before its restart.
    expect(SESSION_TOKEN_MIN_LEFT_MS - RESTART_WHEN_LEFT_MS).toBeGreaterThanOrEqual(15 * MIN)
  })

  it('asks for the restart 25 minutes before the delivered token expires, not before', () => {
    const w = world()
    w.renewal.delivered(A, T0 + 60 * MIN, 'start')
    expect(w.renewal.deadlineOf(A)).toBe(T0 + 35 * MIN)
    w.advanceTo(T0 + 35 * MIN - 1)
    expect(w.restarts).toEqual([])
    w.advanceTo(T0 + 35 * MIN)
    expect(w.restarts).toEqual([A])
  })

  it('a new start replaces the deadline: the restarted session runs on its new token', () => {
    const w = world()
    w.renewal.delivered(A, T0 + 60 * MIN, 'start')
    w.advanceTo(T0 + 35 * MIN)
    w.renewal.delivered(A, T0 + 95 * MIN, 'start')
    expect(w.renewal.deadlineOf(A)).toBe(T0 + 70 * MIN)
    w.advanceTo(T0 + 69 * MIN)
    expect(w.restarts).toEqual([A])
    w.advanceTo(T0 + 70 * MIN)
    expect(w.restarts).toEqual([A, A])
  })

  it('a refresh never postpones the deadline: the surviving engine keeps its old token', () => {
    const w = world()
    w.renewal.delivered(A, T0 + 60 * MIN, 'start')
    w.renewal.delivered(A, T0 + 120 * MIN, 'refresh')
    expect(w.renewal.deadlineOf(A)).toBe(T0 + 35 * MIN)
    w.advanceTo(T0 + 35 * MIN)
    expect(w.restarts).toEqual([A])
  })

  it('a refresh with no known deadline (the server restarted) restarts at the next boundary', () => {
    const w = world()
    w.renewal.delivered(B, T0 + 60 * MIN, 'refresh')
    w.advanceTo(T0)
    expect(w.restarts).toEqual([B])
  })

  it('two sessions keep their own deadlines', () => {
    const w = world()
    w.renewal.delivered(A, T0 + 60 * MIN, 'start')
    w.renewal.delivered(B, T0 + 50 * MIN, 'start')
    w.advanceTo(T0 + 25 * MIN)
    expect(w.restarts).toEqual([B])
    w.advanceTo(T0 + 35 * MIN)
    expect(w.restarts).toEqual([B, A])
  })

  it('a forgotten session is never restarted', () => {
    const w = world()
    w.renewal.delivered(A, T0 + 60 * MIN, 'start')
    w.renewal.forget(A)
    w.advanceTo(T0 + 60 * MIN)
    expect(w.restarts).toEqual([])
    expect(w.renewal.deadlineOf(A)).toBeUndefined()
  })
})
