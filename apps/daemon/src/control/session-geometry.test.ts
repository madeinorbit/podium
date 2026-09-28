import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { DurableAttachment } from '@podium/process/screen'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { harnessCompatEnv, sessionHandlers, wireBridge } from './session'
import { testSessions } from '../session/testing.js'

/**
 * A resize that arrives while its session's spawn is still in flight (POD-628).
 *
 * The server publishes the session row the moment it dispatches `spawn`, but the
 * daemon only has a bridge to resize once fork+exec (and, on a durable backend,
 * the abduco handshake) has completed. A browser fitting its pane inside that
 * window used to have its resize dropped on the floor — leaving the PTY at the
 * 80x24 spawn default while server and browser both moved to the fitted grid, so
 * every Codex repaint wrapped against the wrong width.
 */

function fakeSession(): DurableAttachment & { resizes: Array<[number, number]> } {
  const resizes: Array<[number, number]> = []
  return {
    resizes,
    pid: 1234,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols, rows) => {
      resizes.push([cols, rows])
    },
    redraw: () => {},
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {},
  }
}

function daemonContext(): DaemonContext {
  // Only the surface wireBridge/resize touch — anything else reached for here
  // would throw rather than quietly pass.
  return {
    backend: 'none',
    settingsDir: join(tmpdir(), 'podium-session-geometry-test'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: { clearSession: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: () => {},
  } as unknown as DaemonContext
}

describe('pre-bridge resize', () => {
  it('holds a resize with no bridge and applies it when the bridge arrives', () => {
    const ctx = daemonContext()
    const sessionId = asSessionId('s1')

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })
    const session = fakeSession()
    const geometry = wireBridge(ctx, sessionId, session, 'codex', 'podium-s1', {
      cols: 80,
      rows: 24,
    })

    expect(session.resizes).toEqual([[38, 35]])
    // The bind that follows must report the size the PTY is ACTUALLY at, or the
    // server is told 80x24 and its own heal-on-bind has nothing to correct.
    expect(geometry).toEqual({ cols: 38, rows: 35 })
    expect((ctx.sessions.get(sessionId)?.pendingResize !== undefined)).toBe(false)
  })

  it('keeps only the last pre-bridge resize — a session with no screen has no reflow to replay', () => {
    const ctx = daemonContext()
    const sessionId = asSessionId('s1')

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 100, rows: 40 })
    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })
    const session = fakeSession()
    wireBridge(ctx, sessionId, session, 'codex', 'podium-s1', { cols: 80, rows: 24 })

    expect(session.resizes).toEqual([[38, 35]])
  })

  it('sends a resize straight through once the bridge exists (nothing queued)', () => {
    const ctx = daemonContext()
    const sessionId = asSessionId('s1')
    const session = fakeSession()

    const geometry = wireBridge(ctx, sessionId, session, 'codex', 'podium-s1', {
      cols: 80,
      rows: 24,
    })
    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })

    expect(geometry).toEqual({ cols: 80, rows: 24 })
    expect(session.resizes).toEqual([[38, 35]])
    expect((ctx.sessions.get(sessionId)?.pendingResize !== undefined)).toBe(false)
  })

  it('drops a held resize when the session is killed before it ever binds', () => {
    const ctx = daemonContext()
    const sessionId = asSessionId('s1')

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })
    sessionHandlers.kill(ctx, { type: 'kill', sessionId })

    expect((ctx.sessions.get(sessionId)?.pendingResize !== undefined)).toBe(false)
  })
})

/**
 * THE BRIDGE ARM REPORTS WHAT THE PTY ACKNOWLEDGED (POD-4723). A podium-host
 * answers every resize with the kernel's size; until that answer arrives there
 * is nothing to report, and an answer that never comes — or comes back refused
 * — must never become a `geometryApplied`.
 */
describe('acknowledged bridge resize', () => {
  function ackingSession(
    answer: (cols: number, rows: number) => Promise<{ cols: number; rows: number } | undefined>,
  ): DurableAttachment & { resizes: Array<[number, number]> } {
    const base = fakeSession()
    return {
      ...base,
      resizes: base.resizes,
      resizeAcknowledged: (cols: number, rows: number) => {
        base.resizes.push([cols, rows])
        return answer(cols, rows)
      },
    }
  }
  function reportingContext(): { ctx: DaemonContext; reports: Array<{ cols: number; rows: number }> } {
    const reports: Array<{ cols: number; rows: number }> = []
    const ctx = daemonContext()
    ctx.send = ((msg: { type: string; geometry?: { cols: number; rows: number } }) => {
      if (msg.type === 'geometryApplied' && msg.geometry) reports.push({ ...msg.geometry })
    }) as DaemonContext['send']
    return { ctx, reports }
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('sends no geometryApplied while the host has not answered, nor ever if it never does', async () => {
    const { ctx, reports } = reportingContext()
    const sessionId = asSessionId('s1')
    const session = ackingSession(() => new Promise(() => {}))
    wireBridge(ctx, sessionId, session, 'claude-code', 'podium-s1', undefined)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()

    expect(session.resizes).toEqual([[122, 39]])
    expect(reports).toEqual([])
  })

  it('sends no geometryApplied when the host refuses, and holds the ask', async () => {
    const { ctx, reports } = reportingContext()
    const sessionId = asSessionId('s1')
    const session = ackingSession(async () => undefined)
    wireBridge(ctx, sessionId, session, 'claude-code', 'podium-s1', undefined)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()

    expect(reports).toEqual([])
    expect(ctx.sessions.get(sessionId)?.pendingResize).toEqual({ cols: 122, rows: 39 })
  })

  it('reports the size the host acknowledged, not the one asked', async () => {
    const { ctx, reports } = reportingContext()
    const sessionId = asSessionId('s1')
    // A kernel that clamps: what it took is what gets reported.
    const session = ackingSession(async (cols, rows) => ({ cols: Math.min(cols, 100), rows }))
    wireBridge(ctx, sessionId, session, 'claude-code', 'podium-s1', undefined)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    expect(reports).toEqual([])
    await settle()

    expect(reports).toEqual([{ cols: 100, rows: 39 }])
    expect(ctx.sessions.get(sessionId)?.terminal?.applied).toEqual({ cols: 100, rows: 39 })
  })

  it('an acknowledged resize clears an earlier refused hold', async () => {
    const { ctx, reports } = reportingContext()
    const sessionId = asSessionId('s1')
    let refuse = true
    const session = ackingSession(async (cols, rows) => (refuse ? undefined : { cols, rows }))
    wireBridge(ctx, sessionId, session, 'claude-code', 'podium-s1', undefined)

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 39 })
    await settle()
    refuse = false
    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 122, rows: 38 })
    await settle()

    expect(reports).toEqual([{ cols: 122, rows: 38 }])
    expect(ctx.sessions.get(sessionId)?.pendingResize).toBeUndefined()
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
