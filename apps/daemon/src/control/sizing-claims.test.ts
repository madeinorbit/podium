/**
 * SIZING PLAN ASSUMPTION TESTS — daemon half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * The daemon-side facts the terminal-sizing plan (POD-3190) relies on: how a
 * resize that arrives before a bridge is handled, what `bridge.resize()` gives
 * back, how long the output scheduler may hold bytes, and the post-bind repaint
 * nudge. Stage 1 (POD-3239 B7) has now inserted the flush + `geometryApplied`
 * report into this path; everything the claims pin is unchanged around it, and
 * T2 below is the new ordering guarantee.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import type { AgentSession } from '@podium/pty'
import { describe, expect, it } from 'vitest'
import { OutputScheduler } from '../output-scheduler'
import type { DaemonContext } from './context'
import { sessionHandlers, wireBridge } from './session'

const SESSION = asSessionId('s-sizing')

function fakeSession(): AgentSession & { resizes: Array<[number, number]>; redraws: number } {
  const resizes: Array<[number, number]> = []
  const self = {
    resizes,
    redraws: 0,
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      resizes.push([cols, rows])
    },
    redraw: () => {
      self.redraws += 1
    },
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {},
  }
  return self as unknown as AgentSession & { resizes: Array<[number, number]>; redraws: number }
}

function daemonContext(over: Partial<DaemonContext> = {}): DaemonContext {
  return {
    backend: 'none',
    settingsDir: join(tmpdir(), 'podium-sizing-claims'),
    bridges: new Map<SessionId, AgentSession>(),
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    durableLabels: new Map<SessionId, string>(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: { clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: () => {},
    ...over,
  } as unknown as DaemonContext
}

// ---------------------------------------------------------------------------
// C7
// ---------------------------------------------------------------------------

describe('C7: a pre-bridge resize is held (last-wins) and applied by wireBridge, which returns the effective geometry', () => {
  it('holds, last-wins, applies at bind, and reports the applied grid — not the spawn grid', () => {
    const ctx = daemonContext()
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 100, rows: 40 })
    expect(ctx.pendingResizes.get(SESSION)).toEqual({ cols: 100, rows: 40 })
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 132, rows: 43 })
    expect(ctx.pendingResizes.get(SESSION)).toEqual({ cols: 132, rows: 43 }) // last wins

    const session = fakeSession()
    const geometry = wireBridge(ctx, SESSION, session, 'codex', 'podium-s-sizing', {
      cols: 80,
      rows: 24,
    })

    expect(session.resizes).toEqual([[132, 43]])
    expect(geometry).toEqual({ cols: 132, rows: 43 })
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })

  it('with no pending resize, wireBridge reports the geometry it was given', () => {
    const ctx = daemonContext()
    const session = fakeSession()
    expect(
      wireBridge(ctx, SESSION, session, 'codex', 'podium-s-sizing', { cols: 80, rows: 24 }),
    ).toEqual({ cols: 80, rows: 24 })
    expect(session.resizes).toEqual([])
  })

  it('CORRECTION to the claim: a clientTerminals session takes the resize INSTEAD of pendingResizes', () => {
    // SPEC-0b C14 states the pre-bridge path as "held in pendingResizes". The
    // real branch tries the driver-owned client terminals first and only holds
    // the request when that returns false — a session driven by
    // e.g. opencode-server never reaches pendingResizes at all.
    const taken: Array<[number, number]> = []
    const ctx = daemonContext({
      clientTerminals: {
        resize: (_id: SessionId, cols: number, rows: number) => {
          taken.push([cols, rows])
          return true
        },
      },
    } as unknown as Partial<DaemonContext>)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 132, rows: 43 })

    expect(taken).toEqual([[132, 43]])
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })

  it('bridge.resize() returns nothing — the daemon learns no applied geometry from it', () => {
    const ctx = daemonContext()
    const session = fakeSession()
    wireBridge(ctx, SESSION, session, 'codex', 'podium-s-sizing', { cols: 80, rows: 24 })

    // The handler cannot report an applied grid because the seam has no return
    // value; SPEC-1 B7 has to emit `geometryApplied` itself for that reason.
    expect(session.resize(132, 43)).toBeUndefined()
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 120, rows: 40 })
    expect(session.resizes).toEqual([
      [132, 43],
      [120, 40],
    ])
  })
})

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
