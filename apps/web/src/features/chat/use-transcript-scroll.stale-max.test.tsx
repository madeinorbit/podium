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
