// @vitest-environment happy-dom

import type { SessionCallbacks, SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { FitAddon } from '@xterm/addon-fit'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Like withFittableAddon, but the proposed grid MOVES: a phone that rotates (or
 *  opens its keyboard) between one report and the next. */
function withResizableAddon(): { set: (cols: number, rows: number) => void } {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  let grid = { cols: 150, rows: 50 }
  proto.proposeDimensions = () => grid
  protoPatchRestorers.push(() => {
    proto.proposeDimensions = original
  })
  return {
    set: (cols: number, rows: number) => {
      grid = { cols, rows }
    },
  }
}
/** Return a valid-but-stale grid for a few measurements, then the settled grid. */
function withSequencedAddon(grids: ReadonlyArray<{ cols: number; rows: number } | undefined>): void {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  let index = 0
  proto.proposeDimensions = () => grids[Math.min(index++, grids.length - 1)]
  protoPatchRestorers.push(() => {
    proto.proposeDimensions = original
  })
}

/** Like withFittableAddon, but measurability is toggled by the test — undefined
 *  until `measurable = true`, then 150×50 (a pane hidden / mid-layout, revealed later). */
function withToggleableAddon(): { setMeasurable: (m: boolean) => void } {
  const proto = FitAddon.prototype as unknown as { proposeDimensions: () => unknown }
  const original = proto.proposeDimensions
  let measurable = false
  proto.proposeDimensions = () => (measurable ? { cols: 150, rows: 50 } : undefined)
  protoPatchRestorers.push(() => {
    proto.proposeDimensions = original
  })
  return {
    setMeasurable: (m: boolean) => {
      measurable = m
    },
  }
}

/** ResizeObserver stub that lets the test fire the observer callbacks — the
 *  container-size-changed signal a real browser emits on display:none → visible. */
function withCapturingResizeObserver(): { fire: () => void } {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const original = g.ResizeObserver
  const cbs: Array<() => void> = []
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      cbs.push(cb)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  protoPatchRestorers.push(() => {
    g.ResizeObserver = original
  })
  return {
    fire: () => {
      for (const cb of cbs) cb()
    },
  }
}

/** Drive requestAnimationFrame off setTimeout so vitest fake timers control the
 *  fit-retry schedule deterministically. */
function withFakeTimedRaf(): void {
  vi.useFakeTimers()
  const g = globalThis as unknown as {
    requestAnimationFrame: typeof requestAnimationFrame
    cancelAnimationFrame: typeof cancelAnimationFrame
  }
  const origRaf = g.requestAnimationFrame
  const origCaf = g.cancelAnimationFrame
  g.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 16)) as unknown as typeof requestAnimationFrame
  g.cancelAnimationFrame = ((id: number) =>
    clearTimeout(
      id as unknown as Parameters<typeof clearTimeout>[0],
    )) as typeof cancelAnimationFrame
  protoPatchRestorers.push(() => {
    g.requestAnimationFrame = origRaf
    g.cancelAnimationFrame = origCaf
    vi.useRealTimers()
  })
}

/** Hub stub that records resize/redraw/requestControl and lets a test drive onState. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  let current = {
    role: 'controller' as 'controller' | 'spectator',
    cols: 80,
    rows: 24,
    requestedGeometry: null as { cols: number; rows: number } | null,
    epoch: 0,
    connected: true,
  }
  const calls = {
    resize: [] as Array<[number, number]>,
    claims: [] as Array<{ cols: number; rows: number } | undefined>,
    input: [] as string[],
    redraw: 0,
    requestControl: 0,
    leaseAcquire: 0,
    leaseRelease: 0,
  }
  const connection = {
    sendResize: (c: number, r: number) => {
      calls.resize.push([c, r])
    },
    reportViewport: (c: number, r: number) => {
      calls.resize.push([c, r])
    },
    sendInput: (data: string) => calls.input.push(data),
    requestControl: (geometry?: { cols: number; rows: number }) => {
      calls.requestControl += 1
      calls.claims.push(geometry)
    },
    redraw: () => {
      calls.redraw += 1
    },
    state: () => current,
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    },
    registerRenderedSession: () => {
      calls.leaseAcquire += 1
      return () => {
        calls.leaseRelease += 1
      }
    },
    detach: () => {},
  } as unknown as SocketHub
  return {
    hub,
    calls,
    state: (
      cols: number,
      rows: number,
      role: 'controller' | 'spectator' = 'controller',
      requestedGeometry: { cols: number; rows: number } | null = null,
    ) => {
      current = { ...current, cols, rows, role, requestedGeometry }
      cbs.onState?.(current as never)
    },
    role: (role: 'controller' | 'spectator') => {
      current = { ...current, role }
    },
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
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    expect(calls.requestControl).toBe(0)
    expect(calls.resize).toEqual([])
    expect(calls.leaseAcquire).toBe(0)
    mounted.setActive(false) // still inactive: still nothing
    expect(calls.resize).toEqual([])
    mounted.dispose()
  })

  it('claims control with fitted geometry when it becomes active', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    mounted.setActive(true)
    expect(calls.claims).toEqual([])
    vi.advanceTimersByTime(16)
    expect(calls.claims).toEqual([])
    vi.advanceTimersByTime(16 * 2)
    expect(calls.leaseAcquire).toBe(1)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    expect(calls.resize, 'the reveal claim carries geometry atomically').toEqual([])
    mounted.setActive(false)
    expect(calls.leaseRelease).toBe(1)
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('keeps a server-grid spectator on the authoritative grid and only reports its viewport', () => {
    withResizeObserver()
    withFittableAddon() // phone container proposes 150×50
    const { hub, calls, role, state } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      gridMode: 'server-grid',
    })

    state(183, 55, 'spectator') // desktop-owned PTY geometry

    expect(calls.requestControl, 'looking from a phone must not preempt the desktop').toBe(0)
    expect(calls.resize.at(-1), 'server still records the phone takeover viewport').toEqual([
      150, 50,
    ])
    expect(
      { cols: mounted.view.cols(), rows: mounted.view.rows() },
      'xterm itself stays at the server grid instead of reflowing to the phone grid',
    ).toEqual({ cols: 183, rows: 55 })
    mounted.dispose()
  })

  it('takes control before the first byte from a server-grid spectator', () => {
    withResizeObserver()
    withFittableAddon()
    const { hub, calls, role, state } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      gridMode: 'server-grid',
    })
    state(183, 55, 'spectator')

    mounted.sendInput('x')

    expect(calls.requestControl).toBe(1)
    expect(calls.input).toEqual(['x'])
    mounted.dispose()
  })

  /**
   * READING A WIDE TUI ON A PHONE WITHOUT TYPING INTO IT (POD-724).
   *
   * The implicit takeover above is the only one there was: to be sized for your
   * own screen you had to send a byte into a running agent's session. The mobile
   * header now offers the takeover as an action, and this is the contract behind
   * it — the SAME atomic claim, no keystroke, and the PTY ends up on this
   * client's grid rather than on whatever the desk was driving.
   */
  it('takes control explicitly, carrying this client viewport, and refits when the server transfers', () => {
    withResizeObserver()
    const proposed = withResizableAddon() // phone container proposes 150×50
    const { hub, calls, role, state } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      gridMode: 'server-grid',
    })
    state(183, 55, 'spectator') // desktop-owned PTY geometry

    // The phone rotates. The ResizeObserver report is DEBOUNCED, so at this
    // instant the server still has the portrait viewport on record — a takeover
    // that trusted it would hand the PTY the wrong size.
    proposed.set(90, 70)
    calls.resize.length = 0
    calls.claims.length = 0

    mounted.takeControl()

    expect(calls.requestControl).toBe(1)
    expect(calls.input, 'nothing is typed into the agent to earn a readable size').toEqual([])
    expect(calls.claims.at(-1), 'the viewport is carried on the control claim').toEqual({
      cols: 90,
      rows: 70,
    })

    // The server transfers control: the role change is what re-fits the PTY to
    // THIS client, which is the whole point of the action.
    calls.resize.length = 0
    calls.claims.length = 0
    state(183, 55, 'controller')
    expect(calls.claims.at(-1)).toEqual({ cols: 90, rows: 70 })
    mounted.dispose()
  })

  it('fits a server-grid client that the server made controller', () => {
    withResizeObserver()
    withFittableAddon()
    const { hub, calls, role, state } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      gridMode: 'server-grid',
    })

    state(80, 24, 'controller') // first/only attached client receives control

    expect(calls.requestControl, 'already-controller phone reconciles atomically').toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    // Local xterm stays on the server grid until geometry acks — optimistic
    // phone-grid resize would reflow attach-replay frames into shredded TUI
    // fragments (mobile Grok/Claude). Crop-and-pan holds until the PTY moves.
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 80,
      rows: 24,
    })

    state(150, 50, 'controller') // server applied the phone viewport
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 150,
      rows: 50,
    })
    mounted.dispose()
  })

  it('stays silent while the page is hidden, then resizes on visibilitychange', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    // Hide the page before mounting: active tab, but the page is not visible, so the
    // eligibility gate must keep the terminal silent. Restored in afterEach.
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    protoPatchRestorers.push(() => {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      else
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })

    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // Active but hidden: no control claim, no resize.
    expect(calls.requestControl).toBe(0)
    expect(calls.resize).toEqual([])

    // Page becomes visible → the visibilitychange listener should make it eligible.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    expect(calls.resize).toEqual([])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('re-fits when focus returns without a visibilitychange event', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    protoPatchRestorers.push(() => {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      else
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    expect(calls.requestControl).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('re-fits when pageshow returns without focus or visibilitychange', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    protoPatchRestorers.push(() => {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      else
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    expect(calls.requestControl).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    window.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('cancels stale reveal callbacks when a newer page resume supersedes them', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    mounted.setActive(true)
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims).toEqual([{ cols: 150, rows: 50 }])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('reclaims the fitted grid after a stale server state overwrites it', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    state(80, 24)
    mounted.setActive(true)
    vi.advanceTimersByTime(16 * 2)
    expect(calls.claims).toEqual([{ cols: 150, rows: 50 }])

    // The server's delayed 80×24 echo arrives after the correct claim. It must
    // not reflow the view back to the stale grid; the client must re-assert the
    // applied fitted grid instead.
    state(80, 24)
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 150,
      rows: 50,
    })
    vi.advanceTimersByTime(16)
    expect(calls.claims).toEqual([
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
    ])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('applies a server grid when the local view no longer matches the assertion', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    state(80, 24)
    mounted.setActive(true)
    vi.advanceTimersByTime(16 * 3)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })

    mounted.view.resize(80, 24)
    state(70, 20)
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 70,
      rows: 20,
    })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })


  it('honors a pending requested grid before applying a stale server state', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })

    // The ordinary fit has applied the local 150×50 grid, but this path has not
    // made a reveal assertion. The transport's pending request is the only fence
    // available when the stale 80×24 state arrives.
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 150,
      rows: 50,
    })
    state(80, 24, 'controller', { cols: 150, rows: 50 })

    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 150,
      rows: 50,
    })
    vi.advanceTimersByTime(16)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('resets the reveal settle streak after an invalid measurement', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withSequencedAddon([
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
      undefined,
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
    ])
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    mounted.setActive(true)
    vi.advanceTimersByTime(16 * 4)
    expect(calls.claims).toEqual([])
    vi.advanceTimersByTime(16)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('settles a valid stale fit before claiming foreground geometry', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withSequencedAddon([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
      { cols: 150, rows: 50 },
    ])
    const { hub, calls, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    state(80, 24)
    mounted.setActive(true)
    expect(calls.claims).toEqual([])
    vi.advanceTimersByTime(16 * 5)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    expect(calls.resize).toEqual([])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('re-fits and re-asserts size on reconnect (server-reload quarter-size fix)', () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50
    const { hub, calls, attached, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
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
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // Mounting active reveals the panel → becomeEligible → forceRepaint.
    expect(repaint, 'repaint on reveal').toHaveBeenCalled()
    repaint.mockClear()
    // A server-driven geometry change resizes the view → forceRepaint.
    state(100, 30)
    expect(repaint, 'repaint on resize').toHaveBeenCalled()
    mounted.dispose()
  })

  it('repaints in place on reveal when the grid is unchanged (freed canvas)', async () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50
    const recover = vi.spyOn(TerminalView.prototype, 'repaintRecover')
    protoPatchRestorers.push(() => recover.mockRestore())
    const { hub, calls, state } = fakeHub()
    // Mount INACTIVE (hidden), then bring the term + server grid to the size fit() will
    // propose, so the reveal fit is a no-op — the case where a same-size resize can't repaint
    // the canvas that display:none freed, so we must repaint the renderer in place.
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    state(150, 50) // term + serverGrid now match what fit() proposes
    recover.mockClear()
    calls.resize.length = 0
    mounted.setActive(true) // reveal: grid unchanged → repaint the live renderer in place
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 0))
    expect(recover, 'unchanged-grid reveal repaints in place').toHaveBeenCalled()
    expect(calls.resize, 'no PTY resize when the grid is unchanged').toEqual([])
    mounted.dispose()
  })

  it('re-fits when the pane becomes measurable after the rAF retry window (#29 stale tiny grid)', () => {
    withResizeObserver()
    withFakeTimedRaf()
    const addon = withToggleableAddon() // unmeasurable at mount: hidden / mid-layout
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // Exhaust the 10-frame rAF window while the pane is still unmeasurable — the
    // old scheduler gave up here permanently.
    vi.advanceTimersByTime(16 * 12)
    expect(calls.resize).toEqual([])
    // Layout settles only AFTER the rAF window (heavy workspace remount, font
    // load). The container's own size never changed, so no ResizeObserver event
    // fires — only the slow-timeout backstop can pick this up.
    addon.setMeasurable(true)
    vi.advanceTimersByTime(250)
    expect(calls.resize.at(-1), 'slow-layout backstop re-fits and resizes the PTY').toEqual([
      150, 50,
    ])
    mounted.dispose()
    vi.advanceTimersByTime(1) // run the deferred terminal dispose under fake timers
  })

  it('re-fits from a ResizeObserver event after every retry backstop expired (#29 hidden→visible)', () => {
    const ro = withCapturingResizeObserver()
    withFakeTimedRaf()
    const addon = withToggleableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // Let the whole retry schedule (rAF window + slow timeouts) run dry while hidden.
    vi.advanceTimersByTime(16 * 12 + 250 + 500 + 1000 + 50)
    expect(calls.resize).toEqual([])
    // The pane is revealed: it lays out (measurable) and the container size change
    // fires the ResizeObserver — the debounced backstop must schedule a fresh fit,
    // not find a dead scheduler.
    addon.setMeasurable(true)
    ro.fire()
    vi.advanceTimersByTime(100) // > the 60ms debounce
    expect(calls.resize.at(-1), 'reveal via ResizeObserver re-fits and resizes the PTY').toEqual([
      150, 50,
    ])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('skips in-place recovery on reveal when the fit changes the grid (resize repaints)', async () => {
    withResizeObserver()
    withFittableAddon() // fit → 150×50, ≠ the 80×24 the panel mounts at
    const recover = vi.spyOn(TerminalView.prototype, 'repaintRecover')
    protoPatchRestorers.push(() => recover.mockRestore())
    const { hub, calls } = fakeHub()
    // Mount INACTIVE at the 80×24 default; revealing fits to 150×50 — a real size change, so
    // xterm's resize recomputes geometry and repaints the whole grid, recovering the freed
    // canvas without extra recovery (the same path a browser-window resize takes).
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    recover.mockClear()
    mounted.setActive(true) // reveal: grid changes → resize, no extra recovery
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.claims.at(-1), 'reveal claims the fitted PTY geometry').toEqual({
      cols: 150,
      rows: 50,
    })
    expect(calls.resize).toEqual([])
    expect(recover, 'changed-grid reveal needs no extra recovery').not.toHaveBeenCalled()
    mounted.dispose()
  })
})
