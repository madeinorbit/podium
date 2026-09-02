/**
 * T2 (POD-3239 SPEC-1 acceptance) — the daemon applies, then reports.
 *
 * WHAT THIS PROVES, EXACTLY: the half of the ordering the DAEMON owns. With the
 * output scheduler holding bytes for this session, a resize flushes those bytes
 * and only then emits `geometryApplied` — so a viewer can never receive the new
 * grid and afterwards be handed output the daemon was already sitting on at the
 * old one.
 *
 * WHAT IT DOES NOT PROVE: that the pty is at the new size when the report goes
 * out. For an abduco session the resize reaches the session pty asynchronously
 * (attach-pty TIOCSWINSZ → SIGWINCH → MSG_RESIZE → master), and the master may
 * forward bytes it had already read after applying it. That residual is accepted
 * on purpose — see MODEL.md "Accepted residuals" — and 0b's C14 harness
 * (`packages/pty/src/abduco-winsize.integration.test.ts`) is what exercises it.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { AgentSession } from '@podium/pty'
import { describe, expect, it } from 'vitest'
import { OutputScheduler } from '../output-scheduler'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'

const SESSION = asSessionId('s-report')

function fakeSession(): AgentSession & { resizes: Array<[number, number]> } {
  const resizes: Array<[number, number]> = []
  return {
    resizes,
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      resizes.push([cols, rows])
    },
    redraw: () => {},
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {},
  } as unknown as AgentSession & { resizes: Array<[number, number]> }
}

/**
 * The REAL OutputScheduler with its timer forced open: nothing this session
 * enqueues leaves until something flushes it deliberately. That is what makes
 * the ordering assertion non-vacuous — without it a P2 flush would fire on its
 * own timer and the test could pass whatever the handler did.
 */
function harness(over: Partial<DaemonContext> = {}): {
  ctx: DaemonContext
  sent: DaemonMessage[]
  timeline: string[]
} {
  const sent: DaemonMessage[] = []
  const timeline: string[] = []
  const outputScheduler = new OutputScheduler({
    flush: (batch: DaemonPtyOutputBatch) => {
      timeline.push(`output:${[...(batch.bytes as Uint8Array)].join(',')}`)
    },
    // Held forever unless flushed on purpose.
    setTimer: () => 0,
    clearTimer: () => {},
    scheduleImmediate: () => {},
  })
  const ctx = {
    backend: 'none',
    settingsDir: join(tmpdir(), 'podium-geometry-report'),
    bridges: new Map<SessionId, AgentSession>(),
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    durableLabels: new Map<SessionId, string>(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler,
    observers: { clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: (msg: DaemonMessage) => {
      sent.push(msg)
      if (msg.type === 'geometryApplied')
        timeline.push(`report:${msg.geometry.cols}x${msg.geometry.rows}`)
    },
    ...over,
  } as unknown as DaemonContext
  return { ctx, sent, timeline }
}

describe('T2: with the scheduler holding bytes, the geometry report follows the daemon-held output', () => {
  it('flushes what it was holding, dispatches the resize, then reports — in that order', () => {
    const { ctx, timeline } = harness()
    const session = fakeSession()
    ctx.bridges.set(SESSION, session)
    // P2 = attached but not focused: the tier that actually coalesces.
    ctx.outputScheduler.setPriority(SESSION, 2)

    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([1, 2]))
    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([3]))
    // ARMED: nothing has left yet, so the order below is the handler's doing.
    expect(timeline).toEqual([])

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 120, rows: 40 })

    expect(timeline).toEqual(['output:1,2,3', 'report:120x40'])
    expect(session.resizes).toEqual([[120, 40]])
  })

  it('reports SYNCHRONOUSLY, so output produced after the resize cannot overtake it', () => {
    const { ctx, timeline } = harness()
    const session = fakeSession()
    ctx.bridges.set(SESSION, session)
    ctx.outputScheduler.setPriority(SESSION, 2)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 100, rows: 30 })
    // The handler has returned and the report is already out; the next frame
    // this session produces is unambiguously post-resize output.
    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([7]))
    ctx.outputScheduler.flushNow(SESSION)

    expect(timeline).toEqual(['report:100x30', 'output:7'])
  })

  it('a session with no bridge and no client terminal HOLDS and reports nothing', () => {
    const { ctx, sent } = harness()

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 132, rows: 43 })

    // There is no applied grid to report — `wireBridge` applies this at bind and
    // `bind` carries the effective geometry, which is that session's report.
    expect(ctx.pendingResizes.get(SESSION)).toEqual({ cols: 132, rows: 43 })
    expect(sent.filter((m) => m.type === 'geometryApplied')).toEqual([])
  })

  it('a driver-owned session takes the resize through clientTerminals and reports too', () => {
    const taken: Array<[number, number]> = []
    const { ctx, timeline } = harness({
      clientTerminals: {
        resize: (_id: SessionId, cols: number, rows: number) => {
          taken.push([cols, rows])
          return true
        },
      },
    } as unknown as Partial<DaemonContext>)
    ctx.outputScheduler.setPriority(SESSION, 2)
    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([5]))

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 90, rows: 28 })

    // Its frames travel through the same scheduler and its W has to move for the
    // same reason, so it gets the same flush-then-report treatment — and it
    // still never touches pendingResizes (0b C7's narrowing).
    expect(taken).toEqual([[90, 28]])
    expect(timeline).toEqual(['output:5', 'report:90x28'])
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })
})
