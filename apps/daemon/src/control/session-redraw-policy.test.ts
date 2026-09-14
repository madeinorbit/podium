/**
 * MODE-AWARE REDRAW — daemon half (POD-3918 P1b).
 *
 * The headed path (`clientTerminals.redraw` returning true) used to return
 * before the replay branch below it, so it never followed any policy at all.
 * Both paths now execute the same decision: alternate screens never replay
 * stale bytes, a different viewer size is applied BEFORE the repaint, and a
 * same-size alternate reopens from the headless model serialisation.
 */

import { asSessionId } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'
import { trackSessionOutput, trackSessionSize } from '../session-screens'

const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')
const ENTER_ALT = '\x1b[?1049h'
const MODEL_SIZE = { cols: 80, rows: 24 }
const VIEWER_SIZE = { cols: 40, rows: 24 }

function world(opts: { headed: boolean }): {
  ctx: DaemonContext
  bridge: { resize: ReturnType<typeof vi.fn>; redraw: ReturnType<typeof vi.fn>; replay: ReturnType<typeof vi.fn> }
  clientTerminals: {
    resize: ReturnType<typeof vi.fn>
    redraw: ReturnType<typeof vi.fn>
  }
  enqueued: Uint8Array[]
} {
  const enqueued: Uint8Array[] = []
  const bridge = {
    resize: vi.fn(() => {}),
    redraw: vi.fn(() => {}),
    replay: vi.fn(async () => {}),
  }
  const clientTerminals = {
    resize: vi.fn(() => true),
    redraw: vi.fn(() => true),
  }
  const ctx = {
    bridges: new Map([[SESSION, bridge]]),
    pendingResizes: new Map(),
    send: vi.fn(),
    outputScheduler: {
      enqueue: (id: unknown, data: Uint8Array) => enqueued.push(data),
      flushNow: vi.fn(),
      remove: vi.fn(),
      setPriority: vi.fn(),
    },
    observers: {},
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    ...(opts.headed ? { clientTerminals } : {}),
  } as unknown as DaemonContext
  return { ctx, bridge, clientTerminals, enqueued }
}

function seedAlt(ctx: DaemonContext): void {
  trackSessionSize(ctx, SESSION, MODEL_SIZE.cols, MODEL_SIZE.rows)
  trackSessionOutput(ctx, SESSION, Buffer.from(ENTER_ALT, 'latin1'))
  trackSessionOutput(ctx, SESSION, Buffer.from('\x1b[HAgent TUI frame', 'latin1'))
}

function seedNormal(ctx: DaemonContext): void {
  trackSessionSize(ctx, SESSION, MODEL_SIZE.cols, MODEL_SIZE.rows)
  trackSessionOutput(ctx, SESSION, Buffer.from('shell line\r\n', 'latin1'))
}

const textOf = (enqueued: Uint8Array[]): string =>
  Buffer.concat(enqueued.map((b) => Buffer.from(b))).toString('latin1')

describe('mode-aware redraw (bridge path)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('alternate at the SAME size reconstitutes from the model, then goes live', () => {
    const { ctx, bridge, enqueued } = world({ headed: false })
    seedAlt(ctx)
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(bridge.replay).not.toHaveBeenCalled()
    expect(bridge.resize).not.toHaveBeenCalled()
    expect(textOf(enqueued)).toContain('Agent TUI frame')
    // The snapshot is the first frame; the nudge keeps the live producer flowing.
    expect(bridge.redraw).toHaveBeenCalledTimes(1)
  })

  it('alternate at a DIFFERENT viewer size applies the size BEFORE repainting', () => {
    const { ctx, bridge, enqueued } = world({ headed: false })
    seedAlt(ctx)
    ctx.pendingResizes.set(SESSION, { ...VIEWER_SIZE })
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(bridge.replay).not.toHaveBeenCalled()
    expect(bridge.resize).toHaveBeenCalledWith(VIEWER_SIZE.cols, VIEWER_SIZE.rows)
    expect(bridge.redraw).toHaveBeenCalledTimes(1)
    expect(bridge.resize.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.redraw.mock.invocationCallOrder[0]!,
    )
    // The stale-size model is only a placeholder until the repaint lands.
    expect(textOf(enqueued)).toContain('Agent TUI frame')
  })

  it('normal + replay debt still replays the host ring tail (restart-approximate)', () => {
    const { ctx, bridge } = world({ headed: false })
    seedNormal(ctx)
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(bridge.replay).toHaveBeenCalledWith(256 * 1024)
  })

  it('normal with no debt just repaints', () => {
    const { ctx, bridge } = world({ headed: false })
    seedNormal(ctx)
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION })
    expect(bridge.replay).not.toHaveBeenCalled()
    expect(bridge.redraw).toHaveBeenCalledTimes(1)
  })
})

describe('mode-aware redraw (headed path follows the same policy: audit item 6)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('headed alternate at a DIFFERENT viewer size resizes through the client terminal BEFORE redrawing', () => {
    const { ctx, clientTerminals, enqueued } = world({ headed: true })
    seedAlt(ctx)
    ctx.pendingResizes.set(SESSION, { ...VIEWER_SIZE })
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(clientTerminals.resize).toHaveBeenCalledWith(
      SESSION,
      VIEWER_SIZE.cols,
      VIEWER_SIZE.rows,
    )
    expect(clientTerminals.redraw).toHaveBeenCalledTimes(1)
    expect(clientTerminals.resize.mock.invocationCallOrder[0]).toBeLessThan(
      clientTerminals.redraw.mock.invocationCallOrder[0]!,
    )
    expect(textOf(enqueued)).toContain('Agent TUI frame')
  })

  it('headed alternate at the SAME size reconstitutes without touching the program size', () => {
    const { ctx, clientTerminals, enqueued } = world({ headed: true })
    seedAlt(ctx)
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(clientTerminals.resize).not.toHaveBeenCalled()
    expect(textOf(enqueued)).toContain('Agent TUI frame')
    // Same decision as the bridge path: snapshot first, then the live nudge.
    expect(clientTerminals.redraw).toHaveBeenCalledTimes(1)
  })
})
