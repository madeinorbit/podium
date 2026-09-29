// @vitest-environment happy-dom

import type { ConnectionState, SessionCallbacks, SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
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
    controllerId: null,
    cols: 80,
    rows: 24,
    epoch: 0,
    connected: true,
  } as ConnectionState
  const connection = {
    sendInput: () => {},
    // POD-3239 B4: the one ask. Inert here — these suites are about frames,
    // readiness and the colour-scheme report, not about sizing.
    sendViewportRequest: () => {},
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
    attached: () => cbs.onAttached?.(),
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
        sessionId: asSessionId('s1'),
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
        sessionId: asSessionId('s1'),
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
        sessionId: asSessionId('s1'),
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

  it('after the attach, the xterm takes EVERY server grid in arrival order — no revision fence (POD-3190 rev 3)', () => {
    // The mount used to drop a state whose `geometryRevision` was lower than
    // one it had seen. The streams are ordered and a reconnect's attach is a
    // full statement, so nothing is stale: an older peer's leftover revision
    // field must not freeze the view.
    withResizeObserver()
    const host = document.createElement('div')
    const onState = vi.fn()
    const { hub, setState, attached } = fakeHub()
    const mounted = mountSession(host, {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
      onState,
    })
    attached()
    setState({ geometryRevision: 2, cols: 100, rows: 30 } as Partial<ConnectionState>)
    onState.mockClear()

    setState({
      geometryRevision: 1,
      cols: 90,
      rows: 28,
      role: 'spectator',
      epoch: 3,
    } as Partial<ConnectionState>)

    expect(mounted.view.cols()).toBe(90)
    expect(mounted.view.rows()).toBe(28)
    expect(host.dataset.role).toBe('spectator')
    expect(host.dataset.epoch).toBe('3')
    expect(onState).toHaveBeenCalled()
    mounted.dispose()
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
      sessionId: asSessionId('a'),
      test: true,
      active: true,
    })
    const apiA = g.__podium
    expect(apiA).toBeTruthy()

    // A second warm (hidden) pane mounts and claims the shared handle.
    const mountedB = mountSession(document.createElement('div'), {
      hub: b.hub,
      sessionId: asSessionId('b'),
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
