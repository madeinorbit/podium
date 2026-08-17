import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

// THE ARRIVAL OWNS THE SCROLL WHILE IT RUNS (POD-1158).
//
// An arriving row animates its own height, which makes the bottom a moving
// number for as long as it runs. The ResizeObserver over every row and the
// MutationObserver beside it both write `scrollTop = scrollHeight` on every
// callback, and both fire on every frame of that growth — so without a claim,
// a landing message has three writers and the sticky-prompt geometry pass runs
// per frame per prompt on top of them.
//
// What this suite pins is the CONTRACT, which is the part that would rot
// silently: while a claim is held the observers write nothing; a reader who has
// scrolled away is never claimed for; and overlapping arrivals extend one claim
// rather than the first one's end cancelling the second.
//
// jsdom lays nothing out and runs no rAF by default, so both are driven
// explicitly. That is not a weaker test than a real browser would give — the
// question here is who writes and when, not what the pixels do.

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult | null = null

/** Every `scrollTop` write the hook makes, in order. */
let writes: number[] = []
let frames: FrameRequestCallback[] = []
let clock = 1000

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
    stickyEnabled: true,
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

/** Run the rAF callbacks queued so far, advancing the clock one frame. */
function tick(ms = 16): void {
  const due = frames
  frames = []
  clock += ms
  act(() => {
    for (const cb of due) cb(clock)
  })
}

/** What the two observers do on every callback, which is the thing the claim
 *  has to suppress. Both call sites are identical by design, so exercising the
 *  ResizeObserver path exercises the contract for both. */
function observerCallback(): void {
  const ro = (globalThis as { __ro?: () => void }).__ro
  act(() => ro?.())
}

beforeEach(() => {
  writes = []
  frames = []
  clock = 1000
  held.pinnedToBottom.current = true
  held.scrollerRef.current = null

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  // Capture the hook's ResizeObserver callback so a "frame of growth" can be
  // delivered on demand, and record every write the hook makes.
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
    get: () => writes[writes.length - 1] ?? 0,
    set: (v: number) => {
      writes.push(v)
    },
  })
  // Mounting runs the initial-load settle, which owns a rAF loop of its own for
  // ten frames. Let it finish before any of this measures anything, or its
  // writes and its queued frames are counted as the arrival's.
  for (let i = 0; i < 24 && frames.length > 0; i++) tick()
  writes = []
  frames = []
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

describe('the arrival claims the scroll', () => {
  it('stands the observers down for the length of the claim', () => {
    act(() => api?.claimScrollForArrival(260))
    // The claim's own first write lands synchronously; clear it so what is
    // being counted is only what the observer would have added.
    writes = []
    observerCallback()
    observerCallback()
    expect(writes).toEqual([])
  })

  it('writes the bottom itself, once per frame, while it holds', () => {
    act(() => api?.claimScrollForArrival(260))
    expect(writes).toEqual([5000])
    tick()
    expect(writes).toEqual([5000, 5000])
    tick()
    expect(writes).toEqual([5000, 5000, 5000])
  })

  it('lets the observers write again once the claim expires', () => {
    act(() => api?.claimScrollForArrival(20))
    writes = []
    tick(40) // past the deadline: the loop sees it is over and stops
    writes = []
    observerCallback()
    expect(writes).toEqual([5000])
  })

  it('does not claim at all for a reader who has scrolled away', () => {
    held.pinnedToBottom.current = false
    act(() => api?.claimScrollForArrival(260))
    expect(writes).toEqual([])
    expect(frames).toHaveLength(0)
  })

  it('drops the claim the moment the reader takes the scroll back', () => {
    act(() => api?.claimScrollForArrival(260))
    writes = []
    held.pinnedToBottom.current = false
    tick()
    expect(writes).toEqual([])
    // ...and having released it, the loop is not left running.
    tick()
    expect(frames).toHaveLength(0)
  })

  it('extends one claim rather than starting a second loop', () => {
    act(() => api?.claimScrollForArrival(260))
    writes = []
    // A second row lands mid-flight. One rAF loop must still be in play, or
    // every overlapping arrival doubles the writes per frame.
    act(() => api?.claimScrollForArrival(260))
    expect(writes).toEqual([])
    tick()
    expect(writes).toEqual([5000])
  })
})
