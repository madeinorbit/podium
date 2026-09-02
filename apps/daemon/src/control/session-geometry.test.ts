import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { AgentSession } from '@podium/pty'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { harnessCompatEnv, sessionHandlers, wireBridge } from './session'

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

function fakeSession(): AgentSession & { resizes: Array<[number, number]> } {
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
    bridges: new Map<SessionId, AgentSession>(),
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    durableLabels: new Map<SessionId, string>(),
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
    expect(ctx.pendingResizes.has(sessionId)).toBe(false)
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
    expect(ctx.pendingResizes.has(sessionId)).toBe(false)
  })

  it('drops a held resize when the session is killed before it ever binds', () => {
    const ctx = daemonContext()
    const sessionId = asSessionId('s1')

    sessionHandlers.resize(ctx, { type: 'resize', sessionId, cols: 38, rows: 35 })
    sessionHandlers.kill(ctx, { type: 'kill', sessionId })

    expect(ctx.pendingResizes.has(sessionId)).toBe(false)
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
