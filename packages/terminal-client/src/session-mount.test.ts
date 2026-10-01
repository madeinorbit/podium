// @vitest-environment happy-dom

import type { ConnectionState, SessionCallbacks, SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import type { Terminal } from '@xterm/xterm'
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

/** Fake hub exposing the legacy reset and authoritative state callbacks. */
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
    frame: (data: string) => cbs.onFrame?.(new TextEncoder().encode(data)),
    // Keep cols/rows at the mounted 80×24 so onState drives only the epoch/clear path,
    // never a view.resize.
    setState: (patch: Partial<ConnectionState>) => {
      current = { ...current, ...patch }
      cbs.onState?.(current as never)
    },
  }
}

// Pictures reset the screen in their own bytes. Only an older server's explicit
// reset callback clears outside that stream; a takeover must leave it readable.
describe('session-mount clear semantics', () => {
  it.each(['normal', 'alternate'] as const)(
    'preserves an idle %s frame and cursor through a server regrid',
    async (buffer) => {
      withResizeObserver()
      const { hub, setState, attached, frame } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false, // Hidden viewers must preserve the same authoritative picture.
        initialGeometry: { cols: 106, rows: 33 },
      })
      try {
        setState({ cols: 106, rows: 33 })
        attached()
        // A snapshot restores the program's cursor on the middle row. No output
        // follows: geometry alone cannot assume a SIGWINCH repaint will arrive.
        frame(
          `${buffer === 'alternate' ? '\x1b[?1049h' : ''}\x1b[H` +
            'top row\r\nmiddle row\r\nbottom row\x1b[2;5H',
        )
        const term = (mounted.view as unknown as { term: Terminal }).term
        await new Promise<void>((resolve) => term.write('', resolve))
        const rows = () => mounted.view.screenText().split('\n').slice(0, 3)
        expect(rows()).toEqual(['top row', 'middle row', 'bottom row'])

        setState({ rows: 31 })
        setState({ rows: 33 })

        expect(rows()).toEqual(['top row', 'middle row', 'bottom row'])
        expect(term.buffer.active.cursorY).toBe(1)
        expect(term.buffer.active.cursorX).toBe(4)
      } finally {
        mounted.dispose()
      }
    },
  )

  it('keeps the view on an in-session epoch bump (controller takeover)', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false,
      })
      setState({ epoch: 0 })
      clear.mockClear()
      setState({ epoch: 1 })
      expect(clear).not.toHaveBeenCalled()
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('clears on an older server’s explicit reset signal', () => {
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

  it('keeps the view across disconnect and a new epoch on reconnect', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false,
      })
      setState({ epoch: 0, connected: true })
      clear.mockClear()
      setState({ epoch: 5, connected: false })
      setState({ epoch: 5, connected: true })
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
