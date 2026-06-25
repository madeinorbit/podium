// @vitest-environment happy-dom
import { FitAddon } from '@xterm/addon-fit'
import { describe, expect, it } from 'vitest'
import type { SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'

function withResizeObserver(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
}

// happy-dom has no real renderer, so FitAddon.proposeDimensions() can't measure a
// cell grid from clientWidth/Height alone (it returns undefined — see
// terminal-view.fit.test.ts). Patch it to a fixed non-default grid so a fittableHost
// yields a genuine fitted size synchronously, exercising the resize path the same way
// a real browser would. 150×50 ≠ the 80×24 server/default grid, so decideResizeAction
// produces a real 'resize' (not just a 'redraw').
function withFittableAddon(): void {
  ;(FitAddon.prototype as unknown as { proposeDimensions: () => unknown }).proposeDimensions =
    () => ({ cols: 150, rows: 50 })
}

/** Hub stub that records resize/redraw/requestControl and lets a test drive onState. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  const calls = { resize: [] as Array<[number, number]>, redraw: 0, requestControl: 0 }
  const connection = {
    sendResize: (c: number, r: number) => calls.resize.push([c, r]),
    sendInput: () => {},
    requestControl: () => {
      calls.requestControl += 1
    },
    redraw: () => {},
    state: () => ({ role: 'controller', cols: 80, rows: 24, epoch: 0, connected: true }),
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
    calls,
    state: (cols: number, rows: number) =>
      cbs.onState?.({ role: 'controller', cols, rows, epoch: 0, connected: true } as never),
  }
}

/** A host element that reports a real size so fit() can measure a grid. */
function fittableHost(): HTMLDivElement {
  const el = document.createElement('div')
  // xterm reads clientWidth/Height via getComputedStyle; happy-dom returns 0 by
  // default, so stub the measurement the FitAddon relies on.
  Object.defineProperty(el, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true })
  return el
}

describe('mountSession eligibility-gated sizing', () => {
  it('does not resize or claim control when mounted inactive (hidden tab)', () => {
    withResizeObserver()
    withFittableAddon() // even with a measurable container, a hidden tab stays silent
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    expect(calls.requestControl).toBe(0)
    expect(calls.resize).toEqual([])
    mounted.setActive(false) // still inactive: still nothing
    expect(calls.resize).toEqual([])
    mounted.dispose()
  })

  it('claims control and resizes when it becomes active and is measurable', () => {
    withResizeObserver()
    withFittableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    mounted.setActive(true)
    expect(calls.requestControl).toBe(1)
    expect(calls.resize.length).toBeGreaterThanOrEqual(1)
    expect(calls.resize.at(-1)?.[0]).toBeGreaterThan(2) // a real fitted width, not the 80 default-only path
    mounted.dispose()
  })
})
