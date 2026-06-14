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

/** Fake hub that captures the frame callback mountSession registers on attach. */
function fakeHub(): { hub: SocketHub; frame: (text: string) => void } {
  let onFrame: SessionCallbacks['onFrame']
  const connection = {
    sendResize: () => {},
    sendInput: () => {},
    requestControl: () => {},
    redraw: () => {},
    state: () => ({ role: 'detached', cols: 80, rows: 24, epoch: 0, connected: true }),
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      onFrame = cb.onFrame
      return connection
    },
    detach: () => {},
  } as unknown as SocketHub
  return { hub, frame: (text: string) => onFrame?.(text) }
}

describe('session-mount onFirstFrame', () => {
  it('fires once on the first non-empty frame, and never on empty replays', () => {
    withResizeObserver()
    const { hub, frame } = fakeHub()
    const onFirstFrame = vi.fn()
    const mounted = mountSession(document.createElement('div'), {
      hub,
      sessionId: 's1',
      onFirstFrame,
    })

    frame('') // empty replay of a not-yet-producing spawn — still "Starting…"
    expect(onFirstFrame).not.toHaveBeenCalled()

    frame('hello') // first real output
    expect(onFirstFrame).toHaveBeenCalledTimes(1)

    frame('more') // subsequent frames don't re-fire
    expect(onFirstFrame).toHaveBeenCalledTimes(1)

    mounted.dispose()
  })
})
