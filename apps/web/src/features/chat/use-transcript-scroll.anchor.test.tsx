import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

// THE ENGINE'S ANCHOR FOLLOWS THE PIN (POD-1160).
//
// An anchoring WebKit (trunk today; release Safari has no scroll anchoring
// yet, so there the attribute is inert) reverts whatever moves its chosen
// anchor — the pin's writes and the reader's wheel alike — so the stylesheet
// admits only the feed's last child as an anchor candidate, and only while
// the scroller carries `data-anchor-end`. This suite pins WHO toggles that
// attribute and when, which is the part that would rot silently:
//
//   - wheel-up or touch intent revokes it with the pin (leaving it granted is
//     the measured trap where an anchoring WebKit allows 0px of escape);
//   - downward movement re-grants it BEFORE arrival (in an anchoring engine
//     the grant is what refreshes the stale maximum; in release Safari the
//     heal in `writeBottom` owns that instead);
//   - upward movement revokes it only when it is legibly the READER's — travel
//     clearly past the stale-clamp band, outside any wheel-down gesture. A
//     rubber band settling onto a stale maximum, or a clamp after the tail
//     unmounts, is ENGINE motion, and reading it as intent revoked the re-arm
//     mid-gesture, every gesture (round 2);
//   - a deliberate request for the bottom (jump, send) grants it.
//
// jsdom lays nothing out; scroll positions are driven by hand and the question
// is only what the attribute does in response.

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult | null = null
let top = 0

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
  return <div data-scroller data-anchor-end="" ref={held.scrollerRef} />
}

function scroller(): HTMLElement {
  return host.querySelector('[data-scroller]') as HTMLElement
}

function granted(): boolean {
  return scroller().hasAttribute('data-anchor-end')
}

/** The reader is AT `next` and the scroller says so — drive the app's handler. */
function scrolledTo(next: number): void {
  top = next
  act(() => api?.onScroll())
}

function wheelUp(): void {
  act(() => {
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
  })
}

beforeEach(() => {
  top = 4500 // the bottom: scrollHeight 5000, clientHeight 500
  held.pinnedToBottom.current = true
  held.scrollerRef.current = null
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal(
    'ResizeObserver',
    class {
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
      top = Math.max(0, Math.min(4500, v))
    },
  })
  // Prime the direction tracker at the bottom.
  scrolledTo(4500)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  api = null
  vi.unstubAllGlobals()
})

describe('the end anchor follows intent', () => {
  it('starts granted and survives ordinary pinned traffic', () => {
    expect(granted()).toBe(true)
    scrolledTo(4500)
    expect(granted()).toBe(true)
  })

  it('is revoked by wheel-up intent, with the pin', () => {
    wheelUp()
    expect(granted()).toBe(false)
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('is revoked by touch intent', () => {
    act(() => {
      scroller().dispatchEvent(new Event('touchstart', { bubbles: true }))
    })
    expect(granted()).toBe(false)
  })

  it('stays revoked while the released reader moves up', () => {
    wheelUp()
    scrolledTo(3000)
    scrolledTo(2500)
    expect(granted()).toBe(false)
  })

  it('re-arms on downward movement, before arrival', () => {
    wheelUp()
    scrolledTo(3000)
    scrolledTo(3100)
    expect(granted()).toBe(true)
    // ...and being below the re-pin band, the reader is still not pinned.
    expect(held.pinnedToBottom.current).toBe(false)
  })

  it('is revoked by a scrollbar drag up, which raises no wheel intent', () => {
    scrolledTo(4300) // up 200px: past the 80px band, the pin drops on distance
    expect(held.pinnedToBottom.current).toBe(false)
    expect(granted()).toBe(false)
  })

  // THE RETRACTION IS NOT A DRAG (POD-1160 round 2). In release Safari the
  // rubber band settles UPWARD onto a stale engine maximum ~100-160px short of
  // the DOM bottom, and that settle raises no wheel intent either — so reading
  // it as a drag revoked the re-arm the reader's own wheel-down had just made,
  // mid-gesture, every gesture. An upward move that stays inside the
  // stale-clamp band keeps the grant; only travel clearly past it revokes.
  it('keeps the grant through a retraction inside the stale-clamp band', () => {
    wheelUp()
    scrolledTo(3000)
    scrolledTo(4400) // the reader wheels back down: re-armed
    expect(granted()).toBe(true)
    scrolledTo(4385) // the rubber band settles up onto the stale maximum
    expect(held.pinnedToBottom.current).toBe(false)
    expect(granted()).toBe(true)
  })

  it('keeps the grant when the upward move follows a wheel-down within its gesture', () => {
    act(() => {
      scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    })
    scrolledTo(3000) // a big clamp inside the same gesture raises no fresh intent
    expect(held.pinnedToBottom.current).toBe(false)
    expect(granted()).toBe(true)
  })

  it('survives an upward CLAMP while pinned — the tail-unmount case', () => {
    // Content below the fold unmounts: the engine clamps the offset up a few
    // px, the gap stays inside the band, the pin holds — so must the grant.
    scrolledTo(4461)
    expect(held.pinnedToBottom.current).toBe(true)
    expect(granted()).toBe(true)
  })

  it('is granted back by a jump to the bottom', () => {
    wheelUp()
    scrolledTo(3000)
    expect(granted()).toBe(false)
    act(() => api?.jumpToBottom())
    expect(granted()).toBe(true)
  })

  it('is granted back by a send', () => {
    wheelUp()
    scrolledTo(3000)
    act(() => api?.pinToBottom())
    expect(granted()).toBe(true)
  })
})
