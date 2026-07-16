// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState, SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'
import { TerminalView } from './terminal-view'

// happy-dom has no ResizeObserver; DomViewportSource needs one to construct.
function withResizeObserver(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
}

/** Fake hub exposing the reset + state callbacks mountSession registers, and a
 *  controllable connection state (its epoch/connected drive the clear semantics). */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  let current: ConnectionState = {
    role: 'controller',
    cols: 80,
    rows: 24,
    epoch: 0,
    connected: true,
  } as ConnectionState
  const connection = {
    sendResize: () => {},
    sendInput: () => {},
    requestControl: () => {},
    redraw: () => {},
    state: () => current,
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    },
    detach: () => {},
  } as unknown as SocketHub
  return {
    hub,
    reset: () => cbs.onReset?.(),
    // Keep cols/rows at the mounted 80×24 so onState drives only the epoch/clear path,
    // never a view.resize.
    setState: (patch: Partial<ConnectionState>) => {
      current = { ...current, ...patch }
      cbs.onState?.(current as never)
    },
  }
}

// The (re)attach full-replay clear and the controller-takeover clear are distinct
// signals: a resuming reconnect must keep its screen (no flash on a network blip),
// while a genuine takeover / fresh replay wipes it. These guard that split.
describe('session-mount clear semantics', () => {
  it('clears the view on an in-session epoch bump (controller takeover)', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: 's1',
        active: false,
      })
      setState({ epoch: 0 }) // first state only seeds the epoch tracker — no clear
      clear.mockClear()
      setState({ epoch: 1 }) // epoch advanced while connected → takeover clear
      expect(clear).toHaveBeenCalledTimes(1)
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('clears on the server reset signal (a full replay is incoming)', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, reset } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: 's1',
        active: false,
      })
      clear.mockClear()
      reset()
      expect(clear).toHaveBeenCalledTimes(1)
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('does not clear on an epoch change while disconnected (only onReset owns the reattach clear)', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: 's1',
        active: false,
      })
      setState({ epoch: 0, connected: true }) // seed the tracker
      clear.mockClear()
      // A disconnect that also reports a new epoch must NOT clear — a resuming
      // reconnect keeps its screen; the reattach clear is onReset's job alone.
      setState({ epoch: 5, connected: false })
      expect(clear).not.toHaveBeenCalled()
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })
})

describe('session-mount E2E API handle', () => {
  it('retargets the opt-in E2E API to whichever warm pane becomes active', () => {
    withResizeObserver()
    const g = globalThis as unknown as { __podium?: unknown }
    const a = fakeHub()
    const b = fakeHub()
    const mountedA = mountSession(document.createElement('div'), {
      hub: a.hub,
      sessionId: 'a',
      test: true,
      active: true,
    })
    const apiA = g.__podium
    expect(apiA).toBeTruthy()

    // A second warm (hidden) pane mounts and claims the shared handle.
    const mountedB = mountSession(document.createElement('div'), {
      hub: b.hub,
      sessionId: 'b',
      test: true,
      active: false,
    })

    // Re-activating A must point the handle back at A's session…
    mountedA.setActive(false)
    mountedA.setActive(true)
    expect(g.__podium).toBe(apiA)

    // …and activating B retargets it to B (the pane a real click brought forward).
    mountedB.setActive(true)
    expect(g.__podium).not.toBe(apiA)

    mountedA.dispose()
    mountedB.dispose()
  })
})
