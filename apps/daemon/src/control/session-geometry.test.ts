import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { harnessCompatEnv, sessionHandlers, sessionSize, wireBridge } from './session'
import { testSessions } from '../session/testing.js'

/**
 * THE ASK AND THE SIZE EVENT (POD-4723, design rev 3 rule 1).
 *
 * The daemon's `resize` handler is an ASK: it reaches the session's Terminal
 * once and moves nothing — no report, no held request. Only the host's own
 * statement of the kernel size (WELCOME, RESIZED), arriving as the size
 * event, is reported; and a bind carries the connection's size. So a refused
 * or unanswered ask can never be reported as applied, and an ask for a session
 * with no terminal is dropped: the next bind re-drives it.
 */

type Size = { cols: number; rows: number }

/** A host-shaped attachment: the test plays the host's WELCOME/RESIZED. */
function fakeHost(opts: { welcome?: Size; answer?: 'ack' | 'refuse' | 'never' } = {}): DurableAttachment & {
  asks: Array<[number, number]>
  state: (size: Size) => void
} {
  const asks: Array<[number, number]> = []
  let size: Size | undefined = opts.welcome
  const sizeCbs = new Set<(g: Size) => void>()
  const state = (g: Size): void => {
    size = g
    for (const cb of [...sizeCbs]) cb(g)
  }
  return {
    asks,
    state,
    pid: 1234,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols, rows) => {
      asks.push([cols, rows])
      if (opts.answer === 'refuse') return Promise.reject(new Error('podium-host: not the writer'))
      if (opts.answer === 'never') return new Promise<void>(() => {})
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

function daemonContext(): { ctx: DaemonContext; sent: DaemonMessage[] } {
  const sent: DaemonMessage[] = []
  // Only the surface wireBridge/resize touch — anything else reached for here
  // would throw rather than quietly pass.
  const ctx = {
    backend: 'host',
    settingsDir: join(tmpdir(), 'podium-session-geometry-test'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: { clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    send: (msg: DaemonMessage) => sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, sent }
}

const reports = (sent: DaemonMessage[]): Size[] =>
  sent.flatMap((m) => (m.type === 'geometryApplied' ? [{ ...m.geometry }] : []))
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the ask moves nothing; the size event reports', () => {
  it('drops an ask for a session with no terminal: nothing held, nothing reported', async () => {
    const { ctx, sent } = daemonContext()
    const sessionId = asSessionId('s1')

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })
    const host = fakeHost({ welcome: { cols: 80, rows: 24 } })
    wireBridge(ctx, sessionId, host, 'codex', 'podium-s1')
    await settle()

    // The terminal that arrives later is not moved by an ask it never saw…
    expect(host.asks).toEqual([])
    // …and the only report is the host's own statement of its WELCOME size.
    expect(reports(sent)).toEqual([{ cols: 80, rows: 24 }])
  })

  it('an ask reaches the terminal exactly once and reports nothing until the host answers', async () => {
    const { ctx, sent } = daemonContext()
    const sessionId = asSessionId('s1')
    const host = fakeHost({ welcome: { cols: 80, rows: 24 } })
    wireBridge(ctx, sessionId, host, 'claude-code', 'podium-s1')
    sent.length = 0

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()
    expect(host.asks).toEqual([[122, 39]])
    expect(reports(sent)).toEqual([])

    // The host's RESIZED is the size event: reported at the KERNEL's answer,
    // which need not be the ask (a clamp).
    host.state({ cols: 120, rows: 39 })
    expect(reports(sent)).toEqual([{ cols: 120, rows: 39 }])
    expect(sessionSize(ctx, sessionId)).toEqual({ cols: 120, rows: 39 })
  })

  it('sends no geometryApplied when the host refuses the ask', async () => {
    const { ctx, sent } = daemonContext()
    const sessionId = asSessionId('s1')
    const host = fakeHost({ welcome: { cols: 80, rows: 24 }, answer: 'refuse' })
    wireBridge(ctx, sessionId, host, 'claude-code', 'podium-s1')
    sent.length = 0

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()
    expect(reports(sent)).toEqual([])
    expect(sessionSize(ctx, sessionId)).toEqual({ cols: 80, rows: 24 })
  })

  it('sends no geometryApplied when the host never answers', async () => {
    const { ctx, sent } = daemonContext()
    const sessionId = asSessionId('s1')
    const host = fakeHost({ welcome: { cols: 80, rows: 24 }, answer: 'never' })
    wireBridge(ctx, sessionId, host, 'claude-code', 'podium-s1')
    sent.length = 0

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()
    expect(reports(sent)).toEqual([])
  })

  it('a backend that cannot read its size back reports nothing and binds bare', async () => {
    const { ctx, sent } = daemonContext()
    const sessionId = asSessionId('s1')
    const asks: Array<[number, number]> = []
    const sizeless: DurableAttachment = {
      pid: 1234,
      onFrame: () => () => {},
      onTitle: () => () => {},
      onExit: () => () => {},
      write: () => {},
      writeBytes: () => {},
      resize: (cols, rows) => {
        asks.push([cols, rows])
      },
      dispose: () => {},
    }
    wireBridge(ctx, sessionId, sizeless, 'claude-code', 'podium-s1')
    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()
    expect(asks).toEqual([[122, 39]])
    expect(reports(sent)).toEqual([])
    expect(sessionSize(ctx, sessionId)).toBeUndefined()
  })
})

describe('harness terminal compatibility env', () => {
  // Not a Draft Sync feature (POD-859 only needed it first): xterm.js does not
  // implement the kitty keyboard protocol codex pushes, so which keyboard path a
  // codex session runs on must not depend on an experiment flag (POD-628).
  it('disables codex keyboard enhancement for every codex session', () => {
    expect(harnessCompatEnv('codex')).toEqual({ CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1' })
  })

  it('leaves other harnesses untouched', () => {
    expect(harnessCompatEnv('claude-code')).toEqual({})
    expect(harnessCompatEnv('shell')).toEqual({})
  })
})
