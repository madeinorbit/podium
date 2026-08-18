import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

// WHICH BRIEF THE SHELF CARRIES (POD-993 round 2).
//
// The scroll pass that used to write `transform`, `visibility` and `data-stuck`
// onto prompt rows now only answers one question: which operator brief has
// scrolled off the top edge. This suite pins that answer down, because it is the
// one piece of the shelf that depends on geometry and so cannot be seen in a
// component test.
//
// jsdom lays nothing out, so each row is given a rect explicitly — which is also
// the only honest way to test a scroll position.

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult | null = null
let renders = 0

/** Place a row's bottom edge at `bottom` px in viewport coordinates. */
function place(el: HTMLElement, bottom: number): void {
  el.getBoundingClientRect = () =>
    ({ top: bottom - 40, bottom, left: 0, right: 100, width: 100, height: 40 }) as DOMRect
}

function scroller(): HTMLElement {
  return host.querySelector('[data-scroller]') as HTMLElement
}

function Harness({ stickyEnabled }: { stickyEnabled: boolean }): JSX.Element {
  renders++
  const refs = useRefs()
  api = useTranscriptScroll({
    scrollerRef: refs.scrollerRef,
    active: true,
    blockCount: 3,
    renderStart: 0,
    stickyEnabled,
    moreAbove: false,
    loadOlder: () => {},
    pinnedToBottom: refs.pinnedToBottom,
    didInitialScroll: refs.didInitialScroll,
    prependAnchor: refs.prependAnchor,
    rowsToRender: 0,
  })
  return (
    <div data-scroller ref={refs.scrollerRef}>
      <div data-operator-prompt="true" data-pinnable="true" data-block="1" data-testid="p1">
        <div className="transcript-you-body">
          <p>the first brief</p>
        </div>
        <time className="chat-clk">14:02</time>
      </div>
      <div data-operator-prompt="true" data-pinnable="true" data-block="4" data-testid="p2">
        <div className="transcript-you-body">
          <p>the second brief</p>
        </div>
        <time className="chat-clk">14:12</time>
      </div>
    </div>
  )
}

// Kept out of the component body so the refs survive re-renders.
const held = {
  scrollerRef: { current: null as HTMLDivElement | null },
  pinnedToBottom: { current: true },
  didInitialScroll: { current: true },
  prependAnchor: { current: null },
}
function useRefs(): typeof held {
  return held
}

function mount(stickyEnabled = true): void {
  act(() => {
    root.render(<Harness stickyEnabled={stickyEnabled} />)
  })
}

function sync(): void {
  act(() => {
    api?.syncStickyPromptPositions()
  })
}

beforeEach(() => {
  renders = 0
  held.scrollerRef.current = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  api = null
})

describe('the brief the shelf carries', () => {
  it('carries nothing while every brief is still on screen', () => {
    mount()
    place(scroller(), 800)
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 300)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 500)
    sync()
    expect(api?.pinnedBrief).toBeNull()
  })

  it('carries the LAST brief that has fully left the top edge, with its own words', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    // Both are above the edge; the shelf takes the later one, because that is
    // the brief everything currently on screen is answering.
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 20)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 60)
    sync()
    expect(api?.pinnedBrief?.key).toBe('4')
    expect(api?.pinnedBrief?.html).toContain('the second brief')
    expect(api?.pinnedBrief?.time).toBe('14:12')
  })

  it('hands back to the earlier brief when the reader scrolls up past the later one', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 20)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 60)
    sync()
    expect(api?.pinnedBrief?.key).toBe('4')
    // The second brief scrolls back into view; the first is still gone.
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 400)
    sync()
    expect(api?.pinnedBrief?.key).toBe('1')
    expect(api?.pinnedBrief?.html).toContain('the first brief')
    // Now both are back.
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 300)
    sync()
    expect(api?.pinnedBrief).toBeNull()
  })

  // THE LOOP THAT BLANKED THE APP (React #185). `querySelector` misses give
  // `undefined` while the ref holds `null`, so an un-normalised comparison fell
  // through the early return and set state on every pass — from a layout effect,
  // a ResizeObserver and every scroll frame. The no-brief case is the COMMON one,
  // which is why it took the whole interface down rather than an edge of it.
  it('is a genuine no-op when nothing has scrolled off the top', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 300)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 500)
    sync()
    expect(api?.pinnedBrief).toBeNull()
    // RENDERS, not the value. `setPinnedBrief(null)` against an already-null
    // state is a value React bails out of, so asserting the value cannot see
    // this bug at all — what it costs is a render per pass, and the pass runs
    // from a layout effect, so a render per pass is a loop.
    const before = renders
    for (let i = 0; i < 5; i++) sync()
    expect(renders).toBe(before)
  })

  /**
   * TAKING THE SHELF AND GIVING IT BACK ARE NOT THE SAME LINE (round 8).
   *
   * With one threshold, a brief resting a pixel from it is pinned on one pass
   * and released on the next — and the shelf is not a class on a row, it is a
   * subtree that mounts, replays its entry animation and unmounts. The feed
   * supplies the jitter for free: a streaming answer re-snaps the bottom on
   * every mutation and a fractional scroll offset rounds either way, so the
   * reader gets a shelf and its "Show full" flashing on and off at frame rate.
   */
  it('does not hand the shelf back for a pixel of jitter at the edge', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    const p1 = host.querySelector('[data-testid="p1"]') as HTMLElement
    const p2 = host.querySelector('[data-testid="p2"]') as HTMLElement
    place(p1, 20)
    place(p2, 105)
    sync()
    expect(api?.pinnedBrief?.key).toBe('4')

    // A pixel back the other way — under one threshold this is "on screen
    // again" and the shelf leaves. It is still, to the reader, a brief with its
    // bottom edge on the top of the column.
    const before = renders
    place(p2, 107)
    sync()
    expect(api?.pinnedBrief?.key).toBe('4')
    // …and not a render, either: the pass is a genuine no-op inside the band.
    expect(renders).toBe(before)

    // Properly back in the column, and the shelf hands over as it always did.
    place(p2, 130)
    sync()
    expect(api?.pinnedBrief?.key).toBe('1')
  })

  /**
   * THE SHELF CARRIES THE READER'S WORDS, NOT THEIR ATTACHMENTS (POD-1290).
   *
   * The brief's html was the whole row body, verbatim — including the
   * attachment strip with its live lazy-loading <img> thumbnails. Inside the
   * shelf's three-line overflow clamp a lazy image is content whose measured
   * size changes ON ITS OWN, which is the one thing the answer-independent
   * measurement in PinnedBrief cannot defend against: instrumented live, the
   * content number flapped, `data-clipped` flipped every ~100ms, and the
   * shelf breathed 56px<->65px forever. The strip's collapsed remnant also
   * sat invisibly under a one-line brief, 8px of dead height that pushed the
   * words off the shelf's centre. The words are the brief; the images are one
   * scroll away in the row itself.
   */
  it('lifts only the markdown, never the attachment strip', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    const p1 = host.querySelector('[data-testid="p1"]') as HTMLElement
    const body = p1.querySelector('.transcript-you-body') as HTMLElement
    body.innerHTML =
      '<div class="chat-md"><p>[Image #1]why does 1222 show a 2</p></div>' +
      '<div class="mt-1.5 flex"><button type="button"><img alt="shot.png" loading="lazy" src="/files/asset?x"></button></div>'
    place(p1, 20)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 400)
    sync()
    expect(api?.pinnedBrief?.html).toContain('why does 1222 show a 2')
    expect(api?.pinnedBrief?.html).not.toContain('<img')
    expect(api?.pinnedBrief?.html).not.toContain('chat-md')
  })

  it('carries nothing at all when the preference is off', () => {
    mount(false)
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    place(host.querySelector('[data-testid="p1"]') as HTMLElement, 20)
    place(host.querySelector('[data-testid="p2"]') as HTMLElement, 60)
    sync()
    expect(api?.pinnedBrief).toBeNull()
  })

  it('leaves the rows themselves untouched — no transform, no visibility, no data-stuck', () => {
    mount()
    scroller().getBoundingClientRect = () => ({ top: 100, bottom: 800 }) as DOMRect
    const p1 = host.querySelector('[data-testid="p1"]') as HTMLElement
    const p2 = host.querySelector('[data-testid="p2"]') as HTMLElement
    place(p1, 20)
    place(p2, 60)
    sync()
    for (const el of [p1, p2]) {
      expect(el.style.transform).toBe('')
      expect(el.style.visibility).toBe('')
      expect(el.dataset.stuck).toBeUndefined()
    }
  })
})

/**
 * THE TAIL MOUNTS BETWEEN ROW COMMITS (POD-993 round 6).
 *
 * Reported as: the chat does not open at the bottom, "jump to bottom" returns
 * to that same short position, and scrolling down to the real end is undone a
 * few seconds later. The operator's own diagnosis was right — there is content
 * below the last message ("Churned for 4m 0s", then "Waiting on your decision")
 * that the snap was not counting.
 *
 * Not because it sits outside the scroller: it is a direct child. Because the
 * resize observation is built from `el.children` AS OF a rowsToRender commit,
 * and the tail mounts on ACTIVITY commits, which change no row. An element that
 * arrives later is one this observer was never asked to watch, so it grows the
 * document below the fold with no callback, no scroll event and no blockCount
 * change — and the feed is left parked exactly one tail above the end, with the
 * gap under the 80px "near" threshold, so the system agrees it is at the bottom
 * and never offers the jump.
 */
describe('content that arrives after the rows', () => {
  /** jsdom lays nothing out, so the scroller is given a content height. */
  function stubHeights(el: HTMLElement, content: number): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: content })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
  }

  /** MutationObserver delivers on a microtask. */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('re-pins when an element mounts into the scroller between row commits', async () => {
    mount()
    const el = scroller()
    held.pinnedToBottom.current = true
    stubHeights(el, 1000)
    el.scrollTop = 600 // the bottom of a 1000px document in a 400px viewport

    // The tail arrives on an activity commit: taller document, no row change.
    const tail = document.createElement('div')
    stubHeights(el, 1050)
    el.appendChild(tail)
    await settle()

    expect(el.scrollTop).toBe(1050)
  })

  it('leaves a reader who scrolled up exactly where they were', async () => {
    mount()
    const el = scroller()
    // The pin is what gates this, and a reader who scrolled up has dropped it.
    held.pinnedToBottom.current = false
    stubHeights(el, 1000)
    el.scrollTop = 200

    stubHeights(el, 1050)
    el.appendChild(document.createElement('div'))
    await settle()

    expect(el.scrollTop).toBe(200)
  })

  it('leaves the engine\'s own clamp alone when that element goes away again', async () => {
    mount()
    const el = scroller()
    held.pinnedToBottom.current = true
    const tail = document.createElement('div')
    stubHeights(el, 1050)
    el.appendChild(tail)
    await settle()
    expect(el.scrollTop).toBe(1050)

    // On unmount the ENGINE clamps the offset to the new maximum itself
    // (jsdom does not, so the clamp is played by hand). Round 5: the app
    // writes nothing on top of it — a reader at the bottom is not written to,
    // because in the Safari 26.4 wedge our own re-assertion was the jump.
    stubHeights(el, 1000)
    tail.remove()
    el.scrollTop = 600
    await settle()

    expect(el.scrollTop).toBe(600)
  })
})

/**
 * LEAVING THE BOTTOM IS AN INTENT, NOT A DISTANCE (POD-993 round 9).
 *
 * `onScroll` re-pins within 80px of the end. With a bottom-writer beside it — a
 * streaming answer resizing rows many times a second — escaping needs one
 * inter-frame move bigger than that band, in a single step. A wheel notch is not
 * that, and WebKit scrolls a notch as an animation, so a reader can push
 * repeatedly and never get away: measured against a bottom-writer, twelve
 * ordinary upward notches moved the view 0px.
 *
 * Two halves. The wheel drops the pin before any of it reaches a scroll offset,
 * and the drop LATCHES — being nearly back is not consent to be taken back, so
 * only arriving at the end re-pins.
 */
describe('the pin lets go on intent', () => {
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }
  /** jsdom lays nothing out; the scroller is given a geometry. */
  function geometry(el: HTMLElement, scrollHeight: number, clientHeight = 400): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  }
  const wheel = (el: HTMLElement, deltaY: number): void => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }))
  }

  it('drops the pin on an upward wheel, before the scroll offset says anything', async () => {
    mount()
    const el = scroller()
    geometry(el, 1000)
    held.pinnedToBottom.current = true
    wheel(el, -120)
    await settle()
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('keeps the pin when the wheel goes DOWN — that is following, not leaving', async () => {
    mount()
    const el = scroller()
    geometry(el, 1000)
    held.pinnedToBottom.current = true
    wheel(el, 120)
    await settle()
    expect(held.pinnedToBottom.current).toBe(true)
  })

  it('does not re-pin merely for being NEAR the end again', async () => {
    mount()
    const el = scroller()
    geometry(el, 1000)
    held.pinnedToBottom.current = true
    wheel(el, -120)
    await settle()
    // 30px from the end: inside the 80px band that used to re-pin, and the whole
    // of the trap. The reader asked to leave and has not arrived back.
    el.scrollTop = 570
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('re-pins on arriving at the end', async () => {
    mount()
    const el = scroller()
    geometry(el, 1000)
    held.pinnedToBottom.current = true
    wheel(el, -120)
    await settle()
    el.scrollTop = 600
    act(() => api?.onScroll())
    expect(held.pinnedToBottom.current).toBe(true)
  })

  it('an explicit jump clears the latch outright', async () => {
    mount()
    const el = scroller()
    geometry(el, 1000)
    wheel(el, -120)
    await settle()
    act(() => api?.jumpToBottom())
    expect(held.pinnedToBottom.current).toBe(true)
  })
})
