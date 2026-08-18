import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

// THE ENGINE'S MAXIMUM RUNS STALE, AND ARRIVAL MUST NOT DEPEND ON IT (POD-1160
// round 2, the recording of 2026-08-17).
//
// Release Safari has no scroll anchoring at all (`CSS.supports('overflow-anchor:
// none')` is false there — the whole POD-1160 attribute regime is engine-inert),
// but it scrolls overflow containers asynchronously against a CACHED maximum,
// and that cache is only refreshed by a layout pass that changes the scroller's
// scrollable overflow. Content that mounts while nothing forces such a pass —
// the waiting tail row on a quiet transcript — leaves the cached maximum short
// of the DOM's. Measured live in the operator's own Safari: the DOM said the
// bottom was 115px further down, `scrollTop = scrollHeight` moved 0px, and 96
// real wheel-down notches were clamped at the stale ceiling. (Every earlier
// measurement that "disproved" a stale clamp ran in Playwright's trunk WebKit,
// which has anchoring and no such clamp on synthetic wheels.)
//
// Against that ceiling the old contract deadlocks: re-pinning required arriving
// within 4px of the DOM bottom, which the clamp makes unreachable, so the pin
// could never re-engage and no writer was allowed to run — the feed froze ~115px
// short with the jump affordance on. This suite pins the three moves that break
// the deadlock:
//
//   - a bottom write that comes up short HEALS the geometry — a one-frame
//     genuine change to the scroller's scrollable overflow (1px of padding),
//     which forces the engine to recompute its maximum — and writes again
//     (verified in the operator's Safari: gap 115 → 0 on exactly this sequence);
//   - pushing down against a frozen offset IS arriving: wheel-down notches that
//     make no progress re-pin by intent, since the geometric arrival they are
//     being denied is exactly what they are asking for;
//   - an upward move that stays within the stale-clamp band never revokes the
//     engine's end anchor — a rubber-band retraction onto the stale maximum
//     reads identically to a scrollbar drag, and treating it as intent is what
//     kept un-doing the re-arm mid-gesture.
//
// jsdom lays nothing out, so the stale engine is simulated honestly: writes and
// reads clamp at an "engine maximum" short of scrollHeight, and only a read of
// offsetHeight while the scroller's own geometry has genuinely changed (the
// padding is set) refreshes it — a reflow that changes nothing heals nothing.

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult | null = null
let clock = 1000

/** The DOM's truth: scrollHeight 5000, clientHeight 500 — true bottom at 4500. */
const TRUE_MAX = 4500
/** What the engine will actually scroll to until its geometry is refreshed. */
let engineMax = 4385 // 115px short, as measured
let top = 0
/** Every offsetHeight read made while the scroller's geometry was genuinely
 *  changed (padding set) — the signature of a real invalidation. */
let heals = 0

const held = {
  scrollerRef: { current: null as HTMLDivElement | null },
  pinnedToBottom: { current: true },
  didInitialScroll: { current: true },
  prependAnchor: { current: null },
}

function Harness(): JSX.Element {
  api = useTranscriptScroll({
    scrollerRef: held.scrollerRef,
    active: true,
    blockCount: 3,
    renderStart: 0,
    stickyEnabled: false,
    moreAbove: false,
    loadOlder: () => {},
    pinnedToBottom: held.pinnedToBottom,
    didInitialScroll: held.didInitialScroll,
    prependAnchor: held.prependAnchor,
    rowsToRender: 0,
  })
  return <div data-scroller ref={held.scrollerRef} />
}

function scroller(): HTMLElement {
  return host.querySelector('[data-scroller]') as HTMLElement
}

/** A wheel notch, `ms` later on the clock. Wheel precedes any scroll effect —
 *  against the stale clamp there IS no scroll effect, which is the point. */
function wheel(deltaY: number, ms = 150): void {
  clock += ms
  act(() => {
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
  })
}

beforeEach(() => {
  clock = 1000
  engineMax = 4385
  top = engineMax
  heals = 0
  // Mount UNPINNED: a pinned mount starts the settle loop against the real
  // (un-stubbed) element, and with rAF inert its leftover frame budget makes
  // every later settle call renew-and-return instead of writing. The pin goes
  // on after the geometry stubs, which is also the honest order — the stale
  // state under test arose long after mount.
  held.pinnedToBottom.current = false
  held.scrollerRef.current = null

  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        ;(globalThis as { __ro?: () => void }).__ro = cb
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<Harness />)
  })

  const el = scroller()
  Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(engineMax, v))
    },
  })
  // The stale engine heals on a REAL invalidation only: a forced layout while
  // the scroller's scrollable overflow has genuinely changed.
  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    get: () => {
      if (el.style.paddingBottom !== '') {
        engineMax = TRUE_MAX
        heals++
      }
      return 500
    },
  })
  held.pinnedToBottom.current = true
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  api = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a bottom write that comes up short heals the geometry', () => {
  it('detects the clamp, invalidates for one frame, and lands the full write', () => {
    const el = scroller()
    const ro = (globalThis as { __ro?: () => void }).__ro
    act(() => ro?.())
    expect(heals).toBe(1)
    expect(el.scrollTop).toBe(TRUE_MAX)
    // ...and the invalidation was one FRAME, not a lasting style: the padding
    // is back to what the stylesheet says before anyone can see it.
    expect(el.style.paddingBottom).toBe('')
  })

  it('does not pay for an invalidation when the write already lands', () => {
    engineMax = TRUE_MAX
    const ro = (globalThis as { __ro?: () => void }).__ro
    act(() => ro?.())
    expect(heals).toBe(0)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('never writes at all for a reader who scrolled away', () => {
    held.pinnedToBottom.current = false
    top = 200
    const ro = (globalThis as { __ro?: () => void }).__ro
    act(() => ro?.())
    expect(heals).toBe(0)
    expect(scroller().scrollTop).toBe(200)
  })

  it('heals a jump to the bottom the same way', () => {
    held.pinnedToBottom.current = false
    top = 2000
    act(() => api?.jumpToBottom())
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })
})

describe('pushing down against a frozen offset is arriving', () => {
  it('re-pins a latched reader after two stuck notches, and lands the bottom', () => {
    wheel(-120) // the latch: the reader once asked to leave
    expect(held.pinnedToBottom.current).toBe(false)
    wheel(120) // first notch against the clamp: no progress yet provable
    expect(held.pinnedToBottom.current).toBe(false)
    wheel(120) // second notch, still frozen: this IS the arrival
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('re-pins an unpinned reader who never latched — the retraction dead state', () => {
    // The rubber band cleared the latch on its way past the bottom, then the
    // retraction landed on the stale maximum and the pin dropped on distance:
    // unpinned, unlatched, frozen. The operator's trace ends in exactly this.
    held.pinnedToBottom.current = false
    wheel(120)
    wheel(120)
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('does not mistake a moving reader for a stuck one', () => {
    held.pinnedToBottom.current = false
    top = 3000
    wheel(120)
    top = 3040 // the notch scrolled: that is following, not arriving
    wheel(120)
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('does not mistake async lag for the clamp', () => {
    // Two notches inside the same frame read the same offset because the
    // engine has not APPLIED the first yet, not because it refused it.
    held.pinnedToBottom.current = false
    top = 3000
    wheel(120)
    wheel(120, 16)
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('starts over when the reader changes their mind mid-count', () => {
    held.pinnedToBottom.current = false
    wheel(120)
    wheel(-120) // up: a fresh request to leave...
    wheel(120) // ...so this is the FIRST notch of a new approach, not the second
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('does not count notches an inner scroller is consuming', () => {
    // A wheel over a scrollable region inside the feed chains to the feed only
    // once the inner scroller is spent. Until then the feed's offset is frozen
    // for the OPPOSITE reason to the clamp: the notches are not addressed to it.
    held.pinnedToBottom.current = false
    const inner = document.createElement('div')
    scroller().appendChild(inner)
    Object.defineProperty(inner, 'scrollHeight', { value: 800, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 200, configurable: true })
    inner.scrollTop = 0
    inner.style.overflowY = 'auto'
    clock += 150
    act(() => {
      inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    })
    clock += 150
    act(() => {
      inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    })
    expect(held.pinnedToBottom.current).toBe(false)
  })
})

/**
 * AN UNINVITED UPWARD MOVE WHILE PINNED IS THE ENGINE'S (round 3, the trace of
 * 2026-08-18).
 *
 * Instrumented live: the reader sat at the true bottom, gap 0, for 400ms of
 * decaying momentum — zero app writes — and then ONE scroll event moved the
 * view 115px up. No wheel, no touch, no write: WebKit repositioning to its
 * stale maximum as the post-gesture settle. Under the old contract that snap
 * UNSEATED the pin (`pinned = near`, and near was false by then), so every
 * writer was forbidden and the feed rested short with the affordance on —
 * and a jump was snapped back out from under the re-pinned reader the same
 * way, which read as "the button does nothing".
 *
 * The contract this suite pins: the reader expressed no intent to leave — no
 * wheel-up, no touch, no key — so the pin SURVIVES the engine's move and the
 * response is a healed write back to the bottom, which also refreshes the
 * geometry the snap came from. A genuine drag is told apart by PERSISTENCE,
 * not size: a snap is one discrete event, a held scrollbar drag keeps
 * producing upward events, so a second uninvited move inside the concede
 * window means a human is pulling — concede, latch, let them go. Keyboard
 * scrolling raises real intent through its own listener, and the search jump
 * releases the pin deliberately before it navigates.
 */
/**
 * THE ENGINE REVERTING OUR OWN WRITE IS NOT A DRAG (round 4, the trace of
 * 2026-08-18 afternoon).
 *
 * This state is the stale maximum's second mode. In the morning's mode the
 * clamp was SYNCHRONOUS: a write read back short, `writeBottom` saw the
 * shortfall and healed. In this mode Safari accepts the write on the main
 * thread — the read-back says gap 0, so the heal never runs — and the
 * compositor reverts it 16ms later as one silent upward scroll event, to the
 * same stale offset every time. Round 3's fight-breaker then read the SECOND
 * revert, arriving inside the concede window, as a human dragging — and
 * surrendered to the engine. Traced live: two writes per Jump click, a
 * 16ms visit to the true bottom, and silence 213px short.
 *
 * The discriminator no gesture can fake: a revert lands moments after OUR
 * OWN write, on the SAME spot as the last one. A dragging hand progresses;
 * a stale maximum is a constant. So same-spot post-write reverts are fought
 * — with the geometry heal FORCED, because the synchronous read-back is the
 * thing this mode defeats — capped so a truly wedged engine parks the feed
 * instead of spinning, while progressing spots still concede as round 3
 * conceded.
 */
describe('the engine reverting our own write is not a drag', () => {
  /** This mode ACCEPTS writes — the stale clamp lives on the compositor, so
   *  the test lets `scrollTop` land and plays the engine's revert by hand. */
  function acceptWrites(): void {
    engineMax = TRUE_MAX
  }

  function pinAtBottom(): void {
    top = TRUE_MAX
    act(() => api?.onScroll())
  }

  /** The compositor's silent revert: no wheel, no write, one scroll event
   *  back to the stale offset. */
  function revertTo(staleTop: number, ms = 16): void {
    clock += ms
    top = staleTop
    act(() => api?.onScroll())
  }

  it('fights a same-spot revert of its own write instead of conceding', () => {
    acceptWrites()
    pinAtBottom()
    act(() => api?.jumpToBottom())
    expect(scroller().scrollTop).toBe(TRUE_MAX)
    revertTo(4385) // 16ms later: inside round 3's concede window, deliberately
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
    revertTo(4385, 50) // the second revert is what round 3 surrendered to
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('forces the geometry heal even though the write read back as landed', () => {
    acceptWrites()
    pinAtBottom()
    act(() => api?.jumpToBottom())
    expect(heals).toBe(0) // the blind spot: sync read-back said gap 0
    revertTo(4385)
    expect(heals).toBeGreaterThan(0)
  })

  it('parks instead of spinning when the engine never yields', () => {
    acceptWrites()
    pinAtBottom()
    act(() => api?.jumpToBottom())
    for (let i = 0; i < 12; i++) revertTo(4385, 30)
    // The cap: a wedged engine wins the position, but the feed PARKS — pill
    // on, latch set — rather than writing forever.
    expect(held.pinnedToBottom.current).toBe(false)
    expect(scroller().scrollTop).toBe(4385)
  })

  it('still concedes to a hand that PROGRESSES, write or no write', () => {
    acceptWrites()
    pinAtBottom()
    clock += 1000
    revertTo(4300, 0) // first uninvited move: healed once, as in round 3
    expect(held.pinnedToBottom.current).toBe(true)
    revertTo(4200, 50) // a different spot moments later: a hand, let go
    expect(held.pinnedToBottom.current).toBe(false)
    expect(scroller().scrollTop).toBe(4200)
  })
})

describe("an uninvited upward move while pinned is the engine's", () => {
  /** The production shape: engine rested past its own stale max, then snaps
   *  back to it. Prime the direction tracker at the resting spot. */
  function restAtBottomThenSnap(): void {
    top = TRUE_MAX
    act(() => api?.onScroll())
    top = engineMax // the engine's settle: no wheel, no write, one scroll event
    act(() => api?.onScroll())
  }

  it('keeps the pin and heals the view back to the bottom', () => {
    restAtBottomThenSnap()
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
    expect(heals).toBe(1)
  })

  it('survives however large the staleness is', () => {
    engineMax = 3714 // a 786px late row: the staleness is the row, not a band
    restAtBottomThenSnap()
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('concedes to a SECOND uninvited move inside the window — that is a drag', () => {
    restAtBottomThenSnap()
    clock += 100
    top = 4300 // still moving up 100ms later: a held thumb, not a settle
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(false)
    expect(scroller().scrollTop).toBe(4300)
    // ...and the concession latches like any leave: near the end is not back.
    top = 4460
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('heals a snap again once the window has passed', () => {
    restAtBottomThenSnap()
    clock += 1000
    top = engineMax
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(true)
    expect(scroller().scrollTop).toBe(TRUE_MAX)
  })

  it('lets a keyboard reader leave — keys are intent, not engine motion', () => {
    top = TRUE_MAX
    act(() => api?.onScroll())
    act(() => {
      scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    })
    expect(held.pinnedToBottom.current).toBe(false)
    top = 3600
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(false)
    expect(scroller().scrollTop).toBe(3600)
  })

  it('is released deliberately by the search jump before it navigates', () => {
    top = TRUE_MAX
    act(() => api?.onScroll())
    const block = document.createElement('div')
    block.setAttribute('data-block', '7')
    ;(block as HTMLElement & { scrollIntoView: () => void }).scrollIntoView = () => {}
    scroller().appendChild(block)
    act(() => api?.scrollToBlock(7))
    expect(held.pinnedToBottom.current).toBe(false)
    // The navigation's own upward motion is then the reader's, not healed.
    top = 2000
    act(() => api?.onScroll())
    expect(scroller().scrollTop).toBe(2000)
  })
})

