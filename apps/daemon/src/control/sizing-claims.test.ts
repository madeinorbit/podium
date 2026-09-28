/**
 * SIZING PLAN ASSUMPTION TESTS — daemon half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * The daemon-side facts the terminal-sizing plan (POD-3190) relies on. C7 —
 * a pre-bridge resize held and applied at wireBridge — pinned a design that
 * design rev 3 deleted (POD-4723: an ask with no terminal is dropped, and the
 * size is the host's own statement); its replacement lives in
 * `session-geometry.test.ts`. C8, how long the output scheduler may hold
 * bytes, still stands.
 */

import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { OutputScheduler } from '../output-scheduler'

const SESSION = asSessionId('s-sizing')

// ---------------------------------------------------------------------------
// C8
// ---------------------------------------------------------------------------

describe('C8: OutputScheduler can hold P2/P3 bytes up to coalesceMs (75) before flushing', () => {
  function harness(coalesceMs?: number) {
    const flushed: DaemonPtyOutputBatch[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const immediates: Array<() => void> = []
    const scheduler = new OutputScheduler({
      flush: (b) => flushed.push(b),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length - 1
      },
      clearTimer: () => {},
      scheduleImmediate: (fn) => immediates.push(fn),
      ...(coalesceMs !== undefined ? { coalesceMs } : {}),
    })
    return { scheduler, flushed, timers, immediates }
  }

  it('the default coalescing window is 75 ms, and nothing leaves before it elapses', () => {
    const { scheduler, flushed, timers } = harness()
    scheduler.setPriority(SESSION, 2)
    scheduler.enqueue(SESSION, new Uint8Array([1, 2, 3]))

    expect(flushed).toEqual([]) // still held
    expect(timers.map((t) => t.ms)).toEqual([75])

    scheduler.enqueue(SESSION, new Uint8Array([4]))
    expect(flushed).toEqual([]) // one timer for the whole window, not one per frame
    expect(timers).toHaveLength(1)

    timers[0]!.fn() // the window elapses
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toMatchObject({ sessionId: SESSION, sourceFrames: 2 })
    expect([...(flushed[0]!.bytes as Uint8Array)]).toEqual([1, 2, 3, 4])
  })

  it('P3 coalesces the same way; P0/P1 do not wait on the timer at all', () => {
    const p3 = harness()
    p3.scheduler.setPriority(SESSION, 3)
    p3.scheduler.enqueue(SESSION, new Uint8Array([9]))
    expect(p3.flushed).toEqual([])
    expect(p3.timers.map((t) => t.ms)).toEqual([75])

    const p1 = harness()
    p1.scheduler.setPriority(SESSION, 1)
    p1.scheduler.enqueue(SESSION, new Uint8Array([9]))
    expect(p1.timers).toEqual([]) // no coalescing window for a watched session
    expect(p1.immediates).toHaveLength(1)
    p1.immediates[0]!()
    expect(p1.flushed).toHaveLength(1)
  })

  it('the window is the deps value when one is given', () => {
    const { scheduler, timers } = harness(5)
    scheduler.setPriority(SESSION, 2)
    scheduler.enqueue(SESSION, new Uint8Array([1]))
    expect(timers.map((t) => t.ms)).toEqual([5])
  })
})
