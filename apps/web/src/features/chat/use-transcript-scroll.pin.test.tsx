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
