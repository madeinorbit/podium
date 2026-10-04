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
// a real browser would. 150×50 ≠ the 80×24 server grid, so the ask carries a real
// change rather than restating what the server already has.
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
function withSequencedAddon(
  grids: ReadonlyArray<{ cols: number; rows: number } | undefined>,
): void {
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

/** Hub stub that records the size statements and lets a test drive onState. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  let current = {
    role: 'controller' as 'controller' | 'spectator',
    cols: 80,
    rows: 24,
    epoch: 0,
    connected: true,
  }
  const calls = {
    resize: [] as Array<[number, number]>,
    claims: [] as Array<{ cols: number; rows: number } | undefined>,
    asks: [] as Array<{
      geometry: { cols: number; rows: number }
      visible: boolean
      mode: 'native' | 'chat'
      claimControl: boolean
    }>,
    input: [] as string[],
    requestControl: 0,
    leaseAcquire: 0,
    leaseRelease: 0,
  }
  const connection = {
    // THE ONE ASK (POD-3239 B4). Recorded in `asks` with its full shape, and
    // ALSO folded into `claims`/`resize` so the assertions those older cases
    // make still read the same events — a claiming ask is what `requestControl`
    // used to be, a plain one is what the old `resize` frame used to be.
    sendViewportRequest: (request: {
      geometry: { cols: number; rows: number }
      visible: boolean
      mode: 'native' | 'chat'
      claimControl: boolean
    }) => {
      calls.asks.push(request)
      if (request.claimControl) {
        calls.requestControl += 1
        calls.claims.push(request.geometry)
      } else {
        calls.resize.push([request.geometry.cols, request.geometry.rows])
      }
    },
    sendInput: (data: string) => calls.input.push(data),
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
    state: (cols: number, rows: number, role: 'controller' | 'spectator' = 'controller') => {
      current = { ...current, cols, rows, role }
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

/** Feed the same xterm input seam used by DOM mouse reports into mountSession. */
function emitTerminalInput(mounted: ReturnType<typeof mountSession>, data: string): void {
  const term = (
    mounted.view as unknown as {
      term: { input(data: string): void }
    }
  ).term
  term.input(data)
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
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    attached()
    vi.advanceTimersByTime(60) // First attach settled while hidden.
    mounted.setActive(true)
    // POD-3239 B4: ONE ask, sent immediately. The rAF ladder that used to sit
    // between the reveal and the claim is gone — nothing is waiting on this
    // measurement to render, so there is nothing to wait for.
    expect(calls.leaseAcquire).toBe(1)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    expect(calls.resize, 'the reveal claim carries geometry atomically').toEqual([])
    vi.advanceTimersByTime(16 * 3)
    expect(calls.requestControl, 'and it is not repeated by a later frame').toBe(1)
    mounted.setActive(false)
    expect(calls.leaseRelease).toBe(1)
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('REWRITTEN (POD-3239 B8): mouse motion is never withheld, because the buffer is never at the wrong grid', () => {
    // WHAT THIS USED TO PIN. A reveal withheld standalone SGR motion reports
    // until the server acknowledged the claimed geometry, because the buffer
    // might still be at a grid the pty had left and a motion report names a
    // CELL — so it would have named the wrong one.
    //
    // Under rule 2 that cannot happen: the buffer followed the server while the
    // pane was hidden and is at W when it is revealed. The fence's precondition
    // holds by construction, so the fence is only a delay, and it is gone.
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    attached()
    vi.advanceTimersByTime(60)
    mounted.setActive(true)

    const motion = '\u001b[<35;10;5M'
    emitTerminalInput(mounted, motion)
    expect(calls.input, 'motion goes through immediately on a reveal').toEqual([motion])

    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('keeps a server-grid spectator on the authoritative grid and only reports its viewport', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon() // phone container proposes 150×50
    const { hub, calls, role, state, attached } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      crop: 'scroll',
    })
    // POD-3239 B2: the buffer follows the SERVER, and the attach snapshot is
    // the first thing that has any authority over it. A mount that has not
    // attached has been told nothing, so nothing may move it — which is why
    // every state-driven case below has to attach first.
    attached()
    vi.advanceTimersByTime(100) // Includes the first measurable render at 16ms.

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
      crop: 'scroll',
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
      crop: 'scroll',
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

    // The server transfers control. POD-3239 B4: the claim ALREADY carried this
    // box, so there is nothing left to say. No second claim (that would bump the
    // controller epoch for a transfer we asked for), and no restatement either —
    // a non-claiming ask that repeats the last box is not sent.
    calls.resize.length = 0
    calls.claims.length = 0
    calls.asks.length = 0
    state(183, 55, 'controller')
    expect(calls.asks, 'nothing to re-state: the claim already carried it').toEqual([])
    mounted.dispose()
  })

  it('fits a server-grid client that the server made controller', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, role, state, attached } = fakeHub()
    role('spectator')
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      crop: 'scroll',
    })
    // POD-3239 B2: the buffer follows the SERVER, and the attach snapshot is
    // the first thing that has any authority over it. A mount that has not
    // attached has been told nothing, so nothing may move it — which is why
    // every state-driven case below has to attach first.
    attached()
    vi.advanceTimersByTime(100) // Includes the first measurable render at 16ms.

    state(80, 24, 'controller') // first/only attached client receives control

    // POD-3239 B4: the phone STATES its box; it does not claim. It already has
    // control — the server gave it — so claiming would be asking for something
    // it holds, and would bump the controller epoch to say so.
    expect(calls.requestControl).toBe(0)
    expect(calls.asks.at(-1)).toMatchObject({
      geometry: { cols: 150, rows: 50 },
      claimControl: false,
    })
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

    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // Active but hidden: no control claim, no resize.
    attached()
    vi.advanceTimersByTime(60) // Startup completed while the page was hidden.
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
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached()
    vi.advanceTimersByTime(60) // Startup completed while the page was hidden.
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
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached()
    vi.advanceTimersByTime(60) // Startup completed while the page was hidden.
    expect(calls.requestControl).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    window.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(1)
    expect(calls.claims.at(-1)).toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('removes the focus resume listener when disposed', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    const requestControlBeforeDispose = calls.requestControl
    mounted.dispose()
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(16 * 3)
    expect(calls.requestControl).toBe(requestControlBeforeDispose)
  })

  it('removes the pageshow resume listener when disposed', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    const requestControlBeforeDispose = calls.requestControl
    mounted.dispose()
    window.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(16 * 3)
    expect(calls.requestControl).toBe(requestControlBeforeDispose)
  })

  it('REWRITTEN (POD-3239 B4): two reveals in a row are two claims, and that is correct', () => {
    // WHAT THIS USED TO PIN: a generation guard that CANCELLED the first
    // reveal's pending rAF ladder when a second resume superseded it, so the two
    // together produced one claim. There is no pending anything now — a reveal
    // measures once and sends — so the guard has nothing to cancel.
    //
    // Two claims is the honest answer: a reveal and a window focus are two
    // separate statements that this pane is the foreground one, and rule 4 says
    // the claim is the point even when the size has not moved. The server treats
    // the second as a claim at a size it already holds, which costs no resize.
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    attached()
    vi.advanceTimersByTime(60) // First attach settled while hidden.
    mounted.setActive(true)
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(16 * 2)
    expect(calls.requestControl).toBe(2)
    expect(calls.claims).toEqual([
      { cols: 150, rows: 50 },
      { cols: 150, rows: 50 },
    ])
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('REWRITTEN (POD-3239 B2/B3): the buffer follows the server’s grid, and there is nothing left to fence', () => {
    // WHAT THESE THREE TESTS USED TO PIN. `reclaims the fitted grid after a
    // stale server state overwrites it`, `lets a non-pending server resize
    // supersede a stale claim` and `honors a pending requested grid before
    // applying a stale server state` were all arbitration between two claimants
    // to this buffer: a grid the client had applied from its OWN measurement,
    // and the grid the server said. Rule 2 leaves one claimant. The client
    // measures to decide whether to ASK, and the buffer only ever moves to what
    // the server reports. And since POD-3190 rev 3 there is no ordering rule
    // on top: one ordered socket, so the latest state is the server's word.
    withResizeObserver()
    const observer = withCapturingResizeObserver()
    withFakeTimedRaf()
    withFittableAddon() // the box measures 150×50
    const { hub, calls, state, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached()
    observer.fire()
    vi.advanceTimersByTime(100) // Includes the first measurable render at 16ms.

    // The box wants 150×50 and the client ASKED for it…
    expect(calls.asks.at(-1)).toMatchObject({
      geometry: { cols: 150, rows: 50 },
      claimControl: true,
    })
    // …and did NOT apply it. The buffer is still at the server's grid.
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 80,
      rows: 24,
    })

    // The server applies it and says so. NOW the buffer moves.
    state(150, 50, 'controller')
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 150,
      rows: 50,
    })

    // A LATER authoritative grid wins outright — no claim to weigh it against.
    state(100, 30, 'controller')
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 100,
      rows: 30,
    })

    state(70, 20, 'controller')
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 70,
      rows: 20,
    })

    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('REWRITTEN (POD-3239 B4): the reveal reads the box ONCE, and a settling layout corrects it through the debounced observer', () => {
    // WHAT THIS USED TO PIN: a settle streak that required several consecutive
    // agreeing measurements before a reveal was allowed to claim. It existed
    // because the measurement came from `FitAddon.proposeDimensions()`, which
    // can return a CACHED proposal from the previous renderer metrics while a
    // tab is being foregrounded — a plausible, wrong number.
    //
    // `proposeFitIn` reads the outer box and the renderer's independent cell
    // metrics, without dividing a possibly stale screen by a newer grid.
    // A box that is genuinely still
    // MOVING (an animated pane) is handled where it belongs: the observer, whose
    // 60 ms debounce collapses the burst into one ask.
    withResizeObserver()
    const observer = withCapturingResizeObserver()
    withFakeTimedRaf()
    const proposal = withResizableAddon()
    proposal.set(120, 40)
    const { hub, calls, state, attached } = fakeHub()
    const el = fittableHost()
    const rect = { width: 1200, height: 640 }
    el.getBoundingClientRect = () => ({ ...rect }) as DOMRect
    const mounted = mountSession(el, {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    attached()
    vi.advanceTimersByTime(60) // Warm reveal policy, after startup.
    state(80, 24)

    mounted.setActive(true)
    // ONE claim, at the box as it reads right now.
    expect(calls.claims).toEqual([{ cols: 120, rows: 40 }])

    // The pane finishes animating. The observer fires repeatedly; the debounce
    // collapses the burst into one statement.
    proposal.set(150, 50)
    rect.height = 800
    observer.fire()
    observer.fire()
    vi.advanceTimersByTime(60)
    expect(calls.resize, 'one corrected ask, not one per observer event').toEqual([[150, 50]])
    // A content-box event caused by the terminal's own scrollbar is not a
    // change to the measured box, so it cannot start another resize cycle.
    observer.fire()
    vi.advanceTimersByTime(60)
    expect(calls.resize, 'an unchanged viewport stays quiet').toEqual([[150, 50]])
    // A real box change still states its grid even if it fits the same cells;
    // the mount has no cache of requests and reconnect/reveal claims are intact.
    rect.width = 1201
    observer.fire()
    vi.advanceTimersByTime(60)
    expect(calls.resize, 'a real box event restates the grid').toEqual([
      [150, 50],
      [150, 50],
    ])

    // The BUFFER never moved: it is at the server's grid throughout.
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 80,
      rows: 24,
    })
    mounted.dispose()
    vi.advanceTimersByTime(1)
  })

  it('re-fits and re-asserts size on reconnect (server-reload quarter-size fix)', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon() // fit → 150×50
    const { hub, calls, attached, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached() // first attach
    vi.advanceTimersByTime(100) // Includes the first measurable render at 16ms.
    calls.resize.length = 0
    const rcBefore = calls.requestControl
    // Server reload: the rebuilt session resets to 80×24. On reconnect the 'attached'
    // message emits onState FIRST (serverGrid := 80×24, view shrinks) then fires
    // onAttached — so a re-fit here sees the mismatch and re-asserts the real size.
    state(80, 24)
    attached() // RECONNECT re-attach — must ask again, not stay quarter-size
    // POD-3239 B4: a reconnect is a CLAIM carrying this client's box, in one
    // message. A restarted server reset who was driving as well as the grid, so
    // the two facts travel together rather than as a resize plus a claim.
    expect(calls.requestControl, 're-claims control on reconnect').toBeGreaterThan(rcBefore)
    expect(calls.claims.at(-1), 'and states the real box').toEqual({ cols: 150, rows: 50 })
    mounted.dispose()
  })

  it('forces a full repaint on resize (black-screen fix)', () => {
    withResizeObserver()
    withFittableAddon()
    const repaint = vi.spyOn(TerminalView.prototype, 'forceRepaint')
    protoPatchRestorers.push(() => repaint.mockRestore())
    const { hub, state, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    // POD-3239 B2: the buffer follows the SERVER, and the attach snapshot is
    // the first thing that has any authority over it. A mount that has not
    // attached has been told nothing, so nothing may move it — which is why
    // every state-driven case below has to attach first.
    attached()
    // (The REVEAL's repaint is `repaintRecover`, pinned by the two reveal cases
    // below. A fresh mount has no freed canvas to recover.)
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
    const { hub, calls, state, attached } = fakeHub()
    // Mount INACTIVE (hidden), then bring the term + server grid to the size fit() will
    // propose, so the reveal fit is a no-op — the case where a same-size resize can't repaint
    // the canvas that display:none freed, so we must repaint the renderer in place.
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    // POD-3239 B2: the buffer follows the SERVER, and the attach snapshot is
    // the first thing that has any authority over it. A mount that has not
    // attached has been told nothing, so nothing may move it — which is why
    // every state-driven case below has to attach first.
    attached()
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
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached()
    // REWRITTEN FOR POD-3239 B4. The three-tier rAF-then-timeout ladder is gone.
    // The case it covered is real and still covered, by the event that actually
    // marks the transition: the box has a size but xterm has not rendered, so
    // there is no cell to measure and NO ResizeObserver event will follow —
    // nothing about the box changed. xterm's first render is what makes it
    // measurable, and that is what asks.
    vi.advanceTimersByTime(16 * 12)
    expect(calls.resize).toEqual([])
    addon.setMeasurable(true)
    mounted.view.forceRepaint() // xterm renders
    vi.advanceTimersByTime(16)
    expect(calls.resize.at(-1), 'the first render asks once it can measure').toEqual([150, 50])
    mounted.dispose()
    vi.advanceTimersByTime(1) // run the deferred terminal dispose under fake timers
  })

  it('re-fits from a ResizeObserver event after every retry backstop expired (#29 hidden→visible)', () => {
    const ro = withCapturingResizeObserver()
    withFakeTimedRaf()
    const addon = withToggleableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
    })
    attached()
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

  it('REWRITTEN (POD-3239 B3): a reveal ALWAYS recovers the canvas, whatever the box turns out to be', async () => {
    // The old rule was conditional: a reveal whose fit CHANGED the grid got its
    // repaint free, from xterm's own resize, and only an unchanged one needed
    // `repaintRecover`. That rule died with the local resize — a reveal no
    // longer changes the grid at all, so making the repaint depend on whether it
    // did would mean never repainting. The canvas the browser freed comes back
    // blank whatever the size is, so it is recovered unconditionally and FIRST,
    // before any measurement has been taken.
    withResizeObserver()
    withFittableAddon() // the box measures 150×50, ≠ the 80×24 the panel mounts at
    const recover = vi.spyOn(TerminalView.prototype, 'repaintRecover')
    protoPatchRestorers.push(() => recover.mockRestore())
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
    })
    attached()
    await new Promise((resolve) => setTimeout(resolve, 70))
    recover.mockClear()
    mounted.setActive(true)
    // Recovered synchronously, before the layout has even been measured.
    expect(recover, 'a revealed pane repaints its freed canvas').toHaveBeenCalled()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.claims.at(-1), 'reveal claims the measured box').toEqual({
      cols: 150,
      rows: 50,
    })
    // …and the buffer stayed at the server's grid throughout.
    expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
      cols: 80,
      rows: 24,
    })
    mounted.dispose()
  })
})

/**
 * THE THREE TRIGGERS, AND NOTHING ELSE (POD-3190 rev 3, POD-4772).
 *
 * The browser states its grid when the measured grid may have changed, on a
 * reveal and on an attach. It keeps no record of its asks and compares
 * nothing. Startup triggers coalesce through the first attached layout; after
 * that, every trigger sends and no other event does.
 */
describe('mountSession size triggers', () => {
  it('settles the first attach box before stating a viewport or claiming it', () => {
    const observer = withCapturingResizeObserver()
    withFakeTimedRaf()
    const proposal = withResizableAddon()
    proposal.set(106, 31)
    const { hub, calls, state, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      initialGeometry: { cols: 106, rows: 33 },
    })
    try {
      state(106, 33)
      attached()
      // The attach snapshot paints at W immediately; readiness can still change
      // the box in the next layout commit. Mount and attach must not resize it.
      expect({ cols: mounted.view.cols(), rows: mounted.view.rows() }).toEqual({
        cols: 106,
        rows: 33,
      })
      expect(calls.asks, 'no transient 106x31 statement').toEqual([])
      vi.advanceTimersByTime(35)
      proposal.set(106, 33)
      observer.fire()
      vi.advanceTimersByTime(59)
      expect(calls.asks).toEqual([])
      vi.advanceTimersByTime(1)
      expect(calls.asks).toEqual([
        { geometry: { cols: 106, rows: 33 }, visible: true, mode: 'native', claimControl: true },
      ])
    } finally {
      mounted.dispose()
      vi.advanceTimersByTime(1)
    }
  })

  it('keeps automatic startup measurements quiet until the attach arrives', () => {
    const observer = withCapturingResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
    })
    try {
      observer.fire()
      mounted.setAppearance({ fontSize: 18 })
      window.dispatchEvent(new Event('focus'))
      vi.advanceTimersByTime(500)
      expect(calls.asks).toEqual([])
      attached()
      vi.advanceTimersByTime(60)
      expect(calls.asks).toHaveLength(1)
      expect(calls.asks[0]).toMatchObject({
        geometry: { cols: 150, rows: 50 },
        claimControl: true,
      })
    } finally {
      mounted.dispose()
    }
  })

  it('rechecks visibility when the first viewport statement is due', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
    })
    try {
      attached()
      mounted.setActive(false)
      vi.advanceTimersByTime(60)
      expect(calls.asks, 'a queued startup claim cannot resize a hidden panel').toEqual([])
      mounted.setActive(true)
      expect(calls.asks).toHaveLength(1)
      expect(calls.asks[0]?.claimControl).toBe(true)
    } finally {
      mounted.dispose()
    }
  })

  it('cancels the first viewport statement on disposal', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
    })
    attached()
    mounted.dispose()
    vi.advanceTimersByTime(100)
    expect(calls.asks).toEqual([])
  })

  it('honours explicit takeover immediately during the startup quiet window', () => {
    withResizeObserver()
    withFakeTimedRaf()
    const proposal = withResizableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      crop: 'scroll',
    })
    try {
      attached()
      proposal.set(90, 70)
      mounted.takeControl()
      expect(calls.asks).toEqual([
        { geometry: { cols: 90, rows: 70 }, visible: true, mode: 'native', claimControl: true },
      ])
      vi.advanceTimersByTime(100)
      expect(calls.asks, 'no delayed automatic claim after the explicit takeover').toHaveLength(1)
    } finally {
      mounted.dispose()
    }
  })

  it('does not let continuous output postpone a measurable startup viewport', () => {
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    let render: (() => void) | undefined
    const onRender = vi.spyOn(TerminalView.prototype, 'onRender').mockImplementation((cb) => {
      render = cb
      return () => {}
    })
    protoPatchRestorers.push(() => onRender.mockRestore())
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
    })
    try {
      attached()
      render?.() // First measurable render starts the quiet window once.
      for (let i = 0; i < 4; i += 1) {
        vi.advanceTimersByTime(16)
        render?.()
      }
      expect(calls.asks).toHaveLength(1)
    } finally {
      mounted.dispose()
    }
  })

  it('every attach states the box, with the first deferred until layout settles', () => {
    // The first attach must still state the box after settling. On the
    // phone's native bridge the mount's ask can land before the native socket
    // connection exists and be dropped; the attach is what repairs it.
    withResizeObserver()
    withFakeTimedRaf()
    withFittableAddon()
    const { hub, calls, attached } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      crop: 'scroll',
    })
    try {
      calls.asks.length = 0
      attached()
      expect(calls.asks).toEqual([])
      vi.advanceTimersByTime(100) // Includes the first measurable render at 16ms.
      expect(calls.asks).toEqual([
        { geometry: { cols: 150, rows: 50 }, visible: true, mode: 'native', claimControl: false },
      ])
      calls.asks.length = 0
      attached() // A warm reconnect has no ready-state layout change.
      expect(calls.asks).toHaveLength(1)
    } finally {
      mounted.dispose()
    }
  })

  it('a role change asks nothing: the server already holds this box', () => {
    // The role-change trigger is deleted. A spectator's statement is recorded
    // by the server whoever sent it, and a controller change reconciles
    // against that record.
    withResizeObserver()
    withFakeTimedRaf()
    const proposal = withResizableAddon()
    const { hub, calls, attached, state } = fakeHub()
    const mounted = mountSession(fittableHost(), {
      hub,
      sessionId: asSessionId('s1'),
      active: true,
      crop: 'scroll',
    })
    try {
      attached()
      vi.advanceTimersByTime(100)
      state(80, 24, 'spectator')
      calls.asks.length = 0
      // A box that measures differently now, with no box event to say so — the
      // role change is the only thing that could state it, and it must not.
      proposal.set(120, 40)
      state(80, 24, 'controller')
      state(80, 24, 'spectator')
      expect(calls.asks).toEqual([])
    } finally {
      mounted.dispose()
    }
  })
})
