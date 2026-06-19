// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'

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

/** Fake hub that exposes the attach + frame callbacks mountSession registers. */
function fakeHub(): {
  hub: SocketHub
  attached: () => void
  frame: (text: string) => void
} {
  let cbs: SessionCallbacks = {}
  const connection = {
    sendResize: () => {},
    sendInput: () => {},
    requestControl: () => {},
    redraw: () => {},
    state: () => ({ role: 'detached', cols: 80, rows: 24, epoch: 0, connected: true }),
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    },
    detach: () => {},
  } as unknown as SocketHub
  return { hub, attached: () => cbs.onAttached?.(), frame: (text: string) => cbs.onFrame?.(text) }
}

describe('session-mount onReady', () => {
  it('fires once when the session attaches, before any output frame', () => {
    withResizeObserver()
    const { hub, attached } = fakeHub()
    const onReady = vi.fn()
    const mounted = mountSession(document.createElement('div'), { hub, sessionId: 's1', onReady })

    expect(onReady).not.toHaveBeenCalled()
    attached() // server confirms the PTY is bound — usable even with an empty buffer
    expect(onReady).toHaveBeenCalledTimes(1)
    attached() // re-attach (reconnect) does not re-fire
    expect(onReady).toHaveBeenCalledTimes(1)

    mounted.dispose()
  })

  it('still fires on a non-empty frame even if onAttached was missed', () => {
    withResizeObserver()
    const { hub, frame } = fakeHub()
    const onReady = vi.fn()
    const mounted = mountSession(document.createElement('div'), { hub, sessionId: 's1', onReady })

    frame('') // empty replay is not "ready"
    expect(onReady).not.toHaveBeenCalled()
    frame('hello')
    expect(onReady).toHaveBeenCalledTimes(1)

    mounted.dispose()
  })

  it('fires via the timeout backstop when the session never attaches or emits', () => {
    vi.useFakeTimers()
    try {
      withResizeObserver()
      const { hub } = fakeHub()
      const onReady = vi.fn()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: 's1',
        onReady,
        readyTimeoutMs: 2000,
      })

      expect(onReady).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(onReady).toHaveBeenCalledTimes(1)

      mounted.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-fire: a real attach cancels the timeout backstop', () => {
    vi.useFakeTimers()
    try {
      withResizeObserver()
      const { hub, attached } = fakeHub()
      const onReady = vi.fn()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: 's1',
        onReady,
        readyTimeoutMs: 2000,
      })

      attached()
      vi.advanceTimersByTime(5000)
      expect(onReady).toHaveBeenCalledTimes(1)

      mounted.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
