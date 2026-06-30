// @vitest-environment happy-dom
import { FitAddon } from '@xterm/addon-fit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'
import { TerminalView } from './terminal-view'

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
//
// The patch mutates a shared prototype, so each patcher is registered for teardown and
// restored in afterEach — the real zero-size→undefined behaviour must be back in place
// once a test completes (fragile otherwise under a shared pool or a future test in this
// file that needs the genuine behaviour).
const protoPatchRestorers: Array<() => void> = []
afterEach(() => {
  while (protoPatchRestorers.length) protoPatchRestorers.pop()?.()
})

function withFittableAddon(): void {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  proto.proposeDimensions = () => ({ cols: 150, rows: 50 })
  protoPatchRestorers.push(() => {
    proto.proposeDimensions = original
  })
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
    attached: () => cbs.onAttached?.(),
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

  it('stays silent while the page is hidden, then resizes on visibilitychange', () => {
    withResizeObserver()
    withFittableAddon()
    // Hide the page before mounting: active tab, but the page is not visible, so the
    // eligibility gate must keep the terminal silent. Restored in afterEach.
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    protoPatchRestorers.push(() => {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      else Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })

    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: true })
    // Active but hidden: no control claim, no resize.
    expect(calls.requestControl).toBe(0)
    expect(calls.resize).toEqual([])

    // Page becomes visible → the visibilitychange listener should make it eligible.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(calls.requestControl).toBe(1)
    expect(calls.resize.length).toBeGreaterThanOrEqual(1)
    mounted.dispose()
  })

  it('re-fits and re-asserts size on reconnect (server-reload quarter-size fix)', () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50
    const { hub, calls, attached, state } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: true })
    attached() // first attach
    calls.resize.length = 0
    const rcBefore = calls.requestControl
    // Server reload: the rebuilt session resets to 80×24. On reconnect the 'attached'
    // message emits onState FIRST (serverGrid := 80×24, view shrinks) then fires
    // onAttached — so a re-fit here sees the mismatch and re-asserts the real size.
    state(80, 24)
    attached() // RECONNECT re-attach — must re-fit, not stay quarter-size
    expect(calls.resize.at(-1), 'reconnect re-asserts the real fitted size').toEqual([150, 50])
    expect(calls.requestControl, 're-claims control on reconnect').toBeGreaterThan(rcBefore)
    mounted.dispose()
  })

  it('forces a full repaint on reveal and on resize (black-screen fix)', () => {
    withResizeObserver()
    withFittableAddon()
    const repaint = vi.spyOn(TerminalView.prototype, 'forceRepaint')
    protoPatchRestorers.push(() => repaint.mockRestore())
    const { hub, state } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: true })
    // Mounting active reveals the panel → becomeEligible → forceRepaint.
    expect(repaint, 'repaint on reveal').toHaveBeenCalled()
    repaint.mockClear()
    // A server-driven geometry change resizes the view → forceRepaint.
    state(100, 30)
    expect(repaint, 'repaint on resize').toHaveBeenCalled()
    mounted.dispose()
  })

  it('recreates the WebGL renderer on reveal when the grid is unchanged (freed canvas)', async () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50
    const reload = vi.spyOn(TerminalView.prototype, 'reloadWebgl')
    protoPatchRestorers.push(() => reload.mockRestore())
    const { hub, calls, state } = fakeHub()
    // Mount INACTIVE (hidden), then bring the term + server grid to the size fit() will
    // propose, so the reveal fit is a no-op — the case where a same-size resize can't repaint
    // the canvas that display:none freed, so we must recreate the renderer instead.
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    state(150, 50) // term + serverGrid now match what fit() proposes
    reload.mockClear()
    calls.resize.length = 0
    mounted.setActive(true) // reveal: grid unchanged → recreate the GL renderer
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 0))
    expect(reload, 'unchanged-grid reveal recreates the GL renderer').toHaveBeenCalled()
    expect(calls.resize, 'no PTY resize when the grid is unchanged').toEqual([])
    mounted.dispose()
  })

  it('skips the GL recreate on reveal when the fit changes the grid (resize repaints)', async () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50, ≠ the 80×24 the panel mounts at
    const reload = vi.spyOn(TerminalView.prototype, 'reloadWebgl')
    protoPatchRestorers.push(() => reload.mockRestore())
    const { hub, calls } = fakeHub()
    // Mount INACTIVE at the 80×24 default; revealing fits to 150×50 — a real size change, so
    // xterm's resize recomputes geometry and repaints the whole grid, recovering the freed
    // canvas without a recreate (the same path a browser-window resize takes).
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    reload.mockClear()
    mounted.setActive(true) // reveal: grid changes → resize, no recreate
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.resize.at(-1), 'reveal resizes the PTY to the fitted grid').toEqual([150, 50])
    expect(reload, 'changed-grid reveal does NOT recreate the GL renderer').not.toHaveBeenCalled()
    mounted.dispose()
  })
})
