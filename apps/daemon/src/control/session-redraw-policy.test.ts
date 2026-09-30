/**
 * OLD-SERVER MODE-AWARE REDRAW — daemon half (POD-3918 P1b, rewritten by POD-4723).
 *
 * A redraw repaints the VIEWER and never the program (design rev 3,
 * "Repaint"): alternate screens reopen from the headless model, a normal
 * screen with replay debt replays the host ring, and neither path resizes or
 * signals the child. The one exception is the user's own redraw button
 * (`hard`), which reaches the program as a single Ctrl-L. The headed pty and
 * a native client TUI take the same path: both are the session's one Terminal.
 */

import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachTestTerminal, testSessions } from '../session/testing.js'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'
import { sessionScreenFor, trackSessionOutput, trackSessionSize } from '../session-screens'

const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')
const ENTER_ALT = '\x1b[?1049h'
const MODEL_SIZE = { cols: 80, rows: 24 }

function world(opts: { headed: boolean }): {
  ctx: DaemonContext
  bridge: {
    resize: ReturnType<typeof vi.fn>
    writeBytes: ReturnType<typeof vi.fn>
    replay: ReturnType<typeof vi.fn>
  }
  enqueued: Uint8Array[]
} {
  const enqueued: Uint8Array[] = []
  const bridge = {
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: vi.fn(() => {}),
    writeBytes: vi.fn(() => {}),
    resize: vi.fn(() => {}),
    replay: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
  } as unknown as DurableAttachment & {
    resize: ReturnType<typeof vi.fn>
    writeBytes: ReturnType<typeof vi.fn>
    replay: ReturnType<typeof vi.fn>
  }
  const ctx = {
    sessions: testSessions(),
    picturesAccepted: () => false,
    send: vi.fn(),
    outputScheduler: {
      enqueue: (id: unknown, data: Uint8Array) => enqueued.push(data),
      flushNow: vi.fn(),
      remove: vi.fn(),
      setPriority: vi.fn(),
    },
    observers: {},
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
  } as unknown as DaemonContext
  attachTestTerminal(ctx, SESSION, bridge, opts.headed ? 'client' : 'headed')
  return { ctx, bridge, enqueued }
}

async function seedAlt(ctx: DaemonContext): Promise<void> {
  trackSessionSize(ctx, SESSION, MODEL_SIZE.cols, MODEL_SIZE.rows)
  trackSessionOutput(ctx, SESSION, Buffer.from(ENTER_ALT, 'latin1'))
  trackSessionOutput(ctx, SESSION, Buffer.from('\x1b[HAgent TUI frame', 'latin1'))
  // The headless emulator parses writes asynchronously; production control
  // frames always arrive on a later tick than the PTY output they follow, so
  // yield the same way here before snapshotting.
  await sessionScreenFor(ctx, SESSION)?.screen?.flush()
}

async function seedNormal(ctx: DaemonContext): Promise<void> {
  trackSessionSize(ctx, SESSION, MODEL_SIZE.cols, MODEL_SIZE.rows)
  trackSessionOutput(ctx, SESSION, Buffer.from('shell line\r\n', 'latin1'))
  await sessionScreenFor(ctx, SESSION)?.screen?.flush()
}

const textOf = (enqueued: Uint8Array[]): string =>
  Buffer.concat(enqueued.map((b) => Buffer.from(b))).toString('latin1')

describe.each([
  ['a headed pty', false],
  ['a native client TUI', true],
])('a redraw on %s never touches the program', (_name, headed) => {
  let w: ReturnType<typeof world>

  beforeEach(() => {
    w = world({ headed })
  })

  const untouched = (): void => {
    expect(w.bridge.resize).not.toHaveBeenCalled()
    expect(w.bridge.writeBytes).not.toHaveBeenCalled()
  }

  it('alternate reconstitutes from the model and goes live', async () => {
    await seedAlt(w.ctx)
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(textOf(w.enqueued)).toContain('Agent TUI frame')
    expect(w.bridge.replay).not.toHaveBeenCalled()
    untouched()
  })

  it('normal + replay debt replays the host ring tail (restart-approximate)', async () => {
    await seedNormal(w.ctx)
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, replayRequired: true })
    expect(w.bridge.replay).toHaveBeenCalledTimes(1)
    untouched()
  })

  it('normal with no debt sends nothing at all', async () => {
    await seedNormal(w.ctx)
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION })
    expect(w.enqueued).toEqual([])
    expect(w.bridge.replay).not.toHaveBeenCalled()
    untouched()
  })

  it('the user\'s hard redraw reaches the program as exactly one Ctrl-L, and never resizes it', async () => {
    await seedNormal(w.ctx)
    sessionHandlers.redraw(w.ctx, { type: 'redraw', sessionId: SESSION, hard: true })
    expect(w.bridge.writeBytes).toHaveBeenCalledTimes(1)
    expect(Array.from(w.bridge.writeBytes.mock.calls[0]?.[0] as Uint8Array)).toEqual([0x0c])
    expect(w.bridge.resize).not.toHaveBeenCalled()
  })
})
