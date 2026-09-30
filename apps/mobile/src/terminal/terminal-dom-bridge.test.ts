import type { SessionCallbacks } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { mountSession } from '@podium/terminal-client/session-mount'
import { TerminalView } from '@podium/terminal-client/terminal-view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalBridge,
  encodeFrameBytes,
  initialBridgeState,
  type TerminalDomActions,
} from './terminal-dom-bridge'

/**
 * The webview side of the native terminal's transport seam: just enough
 * hub/connection for `mountSession` to run unchanged, with every mutation
 * forwarded to the native actions and every native push fanned into the
 * mount's callbacks. Pure logic — the pinned behaviors are the ones a live
 * defect would surface as a blank or lying terminal:
 *
 *   - attach/detach latching (the native attach frame is one-shot, POD-1613)
 *   - the state MIRROR: `connection.state()` must answer synchronously with
 *     the last state the native connection published
 *   - forwarding fidelity for input and the one size statement — driven by the
 *     REAL mount, because the seam impersonates exactly what the mount calls.
 */

const SESSION = asSessionId('sess-bridge')

function actionsHarness() {
  const actions = {
    onAttachTerminal: vi.fn(async () => {}),
    onDetachTerminal: vi.fn(async () => {}),
    onSendInput: vi.fn(async () => {}),
    onViewportRequest: vi.fn(async () => {}),
  } satisfies TerminalDomActions
  return { actions, box: { current: actions as TerminalDomActions } }
}

let harness: ReturnType<typeof actionsHarness>

beforeEach(() => {
  harness = actionsHarness()
})

describe('createTerminalBridge', () => {
  it('requests the native attach exactly once per attach cycle, and detaches symmetrically', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    bridge.hub.attach(SESSION, {})
    // A re-mount that attaches while attached only swaps callbacks — the real
    // hub behaves the same way for a live connection, and a second native
    // attach would be a no-op frame at best and a callback fork at worst.
    bridge.hub.attach(SESSION, {})
    expect(harness.actions.onAttachTerminal).toHaveBeenCalledTimes(1)

    bridge.hub.detach(SESSION)
    bridge.hub.detach(SESSION)
    expect(harness.actions.onDetachTerminal).toHaveBeenCalledTimes(1)

    // The next mount is a fresh cycle.
    bridge.hub.attach(SESSION, {})
    expect(harness.actions.onAttachTerminal).toHaveBeenCalledTimes(2)
  })

  it('answers state() from the mirror: default posture first, then whatever native last pushed', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})
    // The pre-attach posture a fresh SessionConnection reports: disconnected
    // spectator, outputSeen optimistic (silence must never be accused early).
    expect(conn.state()).toEqual(initialBridgeState(SESSION))
    expect(conn.state()).not.toHaveProperty('lastSeq')

    const next = {
      ...initialBridgeState(SESSION),
      connected: true,
      clientId: 'c1',
      controllerId: 'c2',
      cols: 103,
      rows: 28,
      epoch: 3,
    }
    const seen: unknown[] = []
    bridge.hub.attach(SESSION, { onState: (s) => seen.push(s) })
    bridge.push.state(next)
    expect(conn.state()).toEqual(next)
    expect(seen).toEqual([next])
  })

  it('fans native pushes into the CURRENT callbacks, and none after detach', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const cb = {
      onFrame: vi.fn(),
      onReset: vi.fn(),
      onAttached: vi.fn(),
    } satisfies SessionCallbacks
    bridge.hub.attach(SESSION, cb)

    bridge.push.frame(encodeFrameBytes(new TextEncoder().encode('hello')))
    bridge.push.reset()
    bridge.push.attached()
    expect(cb.onFrame).toHaveBeenCalledWith(new TextEncoder().encode('hello'))
    expect(cb.onReset).toHaveBeenCalledTimes(1)
    expect(cb.onAttached).toHaveBeenCalledTimes(1)

    bridge.hub.detach(SESSION)
    bridge.push.frame(encodeFrameBytes(new TextEncoder().encode('late')))
    expect(cb.onFrame).toHaveBeenCalledTimes(1)
  })

  it('carries PTY bytes across the seam exactly, text or not', () => {
    // The guard on the encoding choice. A terminal stream is not text: these
    // bytes are a NUL, a lone UTF-8 continuation byte and a 0xff — none of
    // which survive a decode/encode round trip through a string. If the seam
    // ever goes back to carrying text, this is what breaks.
    const bridge = createTerminalBridge(SESSION, harness.box)
    const seen: Uint8Array[] = []
    bridge.hub.attach(SESSION, { onFrame: (bytes) => seen.push(bytes) })

    const raw = new Uint8Array([0x00, 0x80, 0xff, 0x1b, 0x5b, 0x41])
    bridge.push.frame(encodeFrameBytes(raw))
    expect(seen).toEqual([raw])
  })

  it('forwards every connection mutation to the native actions', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})

    conn.sendInput('ls\r')
    expect(harness.actions.onSendInput).toHaveBeenCalledWith('ls\r')
    const statement = {
      geometry: { cols: 62, rows: 36 },
      visible: true,
      mode: 'native' as const,
      claimControl: true,
    }
    conn.sendViewportRequest(statement)
    expect(harness.actions.onViewportRequest).toHaveBeenCalledWith(statement)
  })

  it('reads actions through the box, so a re-marshal never strands the mount on stale proxies', () => {
    const bridge = createTerminalBridge(SESSION, harness.box)
    const conn = bridge.hub.attach(SESSION, {})
    const replacement = actionsHarness()
    harness.box.current = replacement.box.current
    conn.sendInput('x')
    expect(harness.actions.onSendInput).not.toHaveBeenCalled()
    expect(replacement.actions.onSendInput).toHaveBeenCalledWith('x')
  })
})

/**
 * THE SEAM UNDER THE REAL MOUNT (POD-3190 rev 3, traced by POD-4772).
 *
 * The mount speaks about size through `sendViewportRequest` alone. The bridge
 * used to impersonate `sendResize`/`reportViewport`/`requestControl`/`redraw`
 * instead — methods the mount stopped calling — so on the native app every
 * size statement, and the header's take-control, threw a TypeError inside the
 * webview and never reached the server. These run the shipped `mountSession`
 * over the bridge, so a method the mount needs and the seam lacks fails here.
 */
describe('mountSession over the bridge', () => {
  const restorers: Array<() => void> = []
  afterEach(() => {
    while (restorers.length) restorers.pop()?.()
  })
  function withResizeObserver(): void {
    const g = globalThis as { ResizeObserver?: unknown }
    if (g.ResizeObserver) return
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    restorers.push(() => {
      delete g.ResizeObserver
    })
  }

  it('keeps the screen on takeover and carries the legacy reset separately from picture bytes', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    const write = vi.spyOn(TerminalView.prototype, 'write')
    const bridge = createTerminalBridge(SESSION, harness.box)
    const mounted = mountSession(document.createElement('div'), {
      hub: bridge.hub,
      sessionId: SESSION,
      active: false,
    })
    try {
      const state = { ...initialBridgeState(SESSION), connected: true, cols: 80, rows: 24 }
      bridge.push.state(state)
      bridge.push.attached()
      clear.mockClear()
      bridge.push.state({ ...state, epoch: 1 })
      const picture = new TextEncoder().encode('\x1bcpicture')
      bridge.push.frame(encodeFrameBytes(picture))
      expect(clear).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledWith(picture)
      bridge.push.reset()
      expect(clear).toHaveBeenCalledTimes(1)
    } finally {
      mounted.dispose()
      clear.mockRestore()
      write.mockRestore()
    }
  })

  it("the header's takeover reaches native as ONE claiming size statement", () => {
    withResizeObserver()
    const bridge = createTerminalBridge(SESSION, harness.box)
    const mounted = mountSession(document.createElement('div'), {
      hub: bridge.hub,
      sessionId: SESSION,
      crop: 'scroll',
      initialGeometry: { cols: 62, rows: 36 },
      focusOnMount: false,
    })
    try {
      mounted.takeControl()
      expect(harness.actions.onViewportRequest).toHaveBeenCalledWith({
        geometry: { cols: 62, rows: 36 },
        visible: true,
        mode: 'native',
        claimControl: true,
      })
    } finally {
      mounted.dispose()
    }
  })

  it("the webview's xterm moves only on the server's grid, and only after the attach", () => {
    withResizeObserver()
    const bridge = createTerminalBridge(SESSION, harness.box)
    const mounted = mountSession(document.createElement('div'), {
      hub: bridge.hub,
      sessionId: SESSION,
      crop: 'scroll',
      initialGeometry: { cols: 62, rows: 36 },
      focusOnMount: false,
    })
    const grid = () => ({ cols: mounted.view.cols(), rows: mounted.view.rows() })
    const serverState = (cols: number, rows: number) => ({
      ...initialBridgeState(SESSION),
      connected: true,
      clientId: 'phone',
      controllerId: 'desk',
      cols,
      rows,
    })
    try {
      // Before the attach nothing has authority over the buffer — not even a
      // mirrored state that carries a grid.
      bridge.push.state(serverState(90, 30))
      expect(grid()).toEqual({ cols: 62, rows: 36 })

      bridge.push.attached()
      expect(grid(), 'the attach snapshot is the first word').toEqual({ cols: 90, rows: 30 })

      bridge.push.state(serverState(100, 32))
      expect(grid()).toEqual({ cols: 100, rows: 32 })
    } finally {
      mounted.dispose()
    }
  })
})
