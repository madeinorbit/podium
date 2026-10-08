/**
 * T2 (POD-3239 SPEC-1 acceptance, moved to the size event by POD-4723) — the
 * daemon flushes, then reports.
 *
 * WHAT THIS PROVES, EXACTLY: the half of the ordering the DAEMON owns. With the
 * output scheduler holding bytes for this session, the size event (the host's
 * RESIZED) flushes those bytes and only then emits `geometryApplied` — so a
 * viewer can never receive the new grid and afterwards be handed output the
 * daemon was already sitting on at the old one. The flush belongs to the size
 * event, not the ask: DATA that preceded RESIZED on the host socket was drawn
 * at the old grid, and the ask no longer reports anything at all.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { DurableAttachment } from '@podium/process/screen'
import { describe, expect, it } from 'vitest'
import { OutputScheduler } from '../output-scheduler'
import type { DaemonContext } from './context'
import { sessionHandlers, wireBridge } from './session'
import { testSessions } from '../session/testing.js'

const SESSION = asSessionId('s-report')

/** A host-shaped attachment: the test plays the host's RESIZED. */
function fakeHost(): DurableAttachment & {
  asks: Array<[number, number]>
  state: (cols: number, rows: number) => void
} {
  const asks: Array<[number, number]> = []
  const sizeCbs = new Set<(g: { cols: number; rows: number }) => void>()
  let size = { cols: 80, rows: 24 }
  return {
    asks,
    state: (cols, rows) => {
      size = { cols, rows }
      for (const cb of [...sizeCbs]) cb(size)
    },
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      asks.push([cols, rows])
      return Promise.resolve()
    },
    size: () => size,
    onSize: (cb) => {
      sizeCbs.add(cb)
      return () => sizeCbs.delete(cb)
    },
    dispose: () => {},
  }
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
    backend: 'host',
    settingsDir: join(tmpdir(), 'podium-geometry-report'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler,
    observers: { clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    send: (msg: DaemonMessage) => {
      sent.push(msg)
      if (msg.type === 'geometryApplied')
        timeline.push(`report:${msg.geometry.cols}x${msg.geometry.rows}`)
    },
    ...over,
  } as unknown as DaemonContext
  return { ctx, sent, timeline }
}

describe('T2: with the scheduler holding bytes, the size event reports after the daemon-held output', () => {
  it('the ask flushes nothing and reports nothing; the size event flushes, then reports', () => {
    const { ctx, timeline } = harness()
    const host = fakeHost()
    wireBridge(ctx, SESSION, host, 'claude-code', 'podium-s-report')
    timeline.length = 0 // the WELCOME statement at wire-up
    // P2 = attached but not focused: the tier that actually coalesces.
    ctx.outputScheduler.setPriority(SESSION, 2)

    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([1, 2]))
    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([3]))
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 120, rows: 40 })
    // ARMED: the ask moved nothing, so the order below is the size event's doing.
    expect(timeline).toEqual([])
    expect(host.asks).toEqual([[120, 40]])

    host.state(120, 40)
    expect(timeline).toEqual(['output:1,2,3', 'report:120x40'])
  })

  it('reports SYNCHRONOUSLY within the size event, so later output cannot overtake it', () => {
    const { ctx, timeline } = harness()
    const host = fakeHost()
    wireBridge(ctx, SESSION, host, 'claude-code', 'podium-s-report')
    timeline.length = 0
    ctx.outputScheduler.setPriority(SESSION, 2)

    host.state(100, 30)
    ctx.outputScheduler.enqueue(SESSION, new Uint8Array([7]))
    ctx.outputScheduler.flushNow(SESSION)

    expect(timeline).toEqual(['report:100x30', 'output:7'])
  })

  it('a session with no terminal drops the ask and reports nothing', () => {
    const { ctx, sent } = harness()
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 132, rows: 43 })
    expect(sent.filter((m) => m.type === 'geometryApplied')).toEqual([])
  })
})
