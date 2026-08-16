import type { MouseEvent as ReactMouseEvent } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PinnedBrief } from './PinnedBrief'
import type { PinnedBrief as PinnedBriefState } from './use-transcript-scroll'

// THE SHELF (POD-993 round 2). The brief that scrolled off the top, drawn OVER
// the feed rather than pinned inside it. What this file holds: it is absent
// unless there is something to hold, it opens and closes in place, and a
// DIFFERENT brief taking the shelf resets it — the reader asked to see that one
// in full, not every one that follows it.

let host: HTMLDivElement
let root: Root

const brief = (key: string, html: string, time = '14:12'): PinnedBriefState => ({
  key,
  html,
  time,
})

function render(
  state: PinnedBriefState | null,
  scroller: { current: HTMLDivElement | null } | null = null,
  onBodyClick: (e: ReactMouseEvent) => void = () => {},
): void {
  act(() => {
    root.render(
      <PinnedBrief
        brief={state}
        scrollerRef={scroller ?? { current: null }}
        onBodyClick={onBodyClick}
      />,
    )
  })
}

const shelf = (): HTMLElement | null => host.querySelector('.brief-shelf')
const toggleEl = (): HTMLElement | null =>
  host.querySelector('[data-testid="prompt-expand-toggle"]')
/** THE CONTROL RESERVES ITS BOX EVEN WHEN IT HAS NOTHING TO OFFER (round 7).
 *  Rendering it conditionally narrowed and widened the text beside it, so a
 *  brief on the three-line boundary flickered between cut and not-cut forever.
 *  "Not offered" is now `data-idle`, not absent — the space is always held. */
const toggle = (): HTMLElement | null => {
  const el = toggleEl()
  return el && el.dataset.idle !== 'true' ? el : null
}

/** jsdom lays nothing out, so the shelf's own overflow measurement always reads
 *  zero and its control would never appear. `clipped` decides whether the brief
 *  is actually cut, so the suite stands in for the one measurement it depends
 *  on — see `useLayoutEffect` in PinnedBrief. */
let clipped = true
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
)

beforeEach(() => {
  clipped = true
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('brief-shelf-text') && clipped ? 999 : 0
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  if (scrollHeightDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

describe('the pinned brief', () => {
  it('draws nothing while the brief the reader is under is still on screen', () => {
    render(null)
    expect(host.querySelector('[data-testid="pinned-brief"]')).toBeNull()
  })

  it('carries the brief’s own words and clock, clamped', () => {
    render(brief('7', '<p>tighten the sticky prompt</p>'))
    expect(host.querySelector('[data-testid="pinned-brief"]')).not.toBeNull()
    expect(host.textContent).toContain('tighten the sticky prompt')
    expect(host.querySelector('.brief-shelf-time')?.textContent).toBe('14:12')
    // Clamped is the resting state; the control says what it will do, not what
    // state it is in.
    expect(shelf()?.dataset.open).toBeUndefined()
    expect(toggle()?.textContent).toBe('Show full')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and closes in place', () => {
    render(brief('7', '<p>a long brief</p>'))
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(shelf()?.dataset.open).toBe('true')
    expect(toggle()?.textContent).toBe('Show less')
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(shelf()?.dataset.open).toBeUndefined()
  })

  it('resets to clamped when a different brief takes the shelf', () => {
    render(brief('7', '<p>the first brief</p>'))
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(shelf()?.dataset.open).toBe('true')
    render(brief('9', '<p>the next brief</p>'))
    expect(host.textContent).toContain('the next brief')
    expect(shelf()?.dataset.open).toBeUndefined()
    // …and coming back to the one that was open does not restore it open: the
    // gesture belonged to the moment, not to the message.
    render(brief('7', '<p>the first brief</p>'))
    expect(shelf()?.dataset.open).toBeUndefined()
  })

  // THREE LINES, THEN THE CONTROL (round 3). It clamped at two and offered "Show
  // full" on every brief, including the ones with nothing hidden — chrome for a
  // problem the reader did not have, plus a faded last line under nothing.
  it('offers no control, and no fade, for a brief that fits', () => {
    clipped = false
    render(brief('7', '<p>two words</p>'))
    expect(host.querySelector('[data-testid="pinned-brief"]')).not.toBeNull()
    expect(toggle()).toBeNull()
    expect(shelf()?.dataset.clipped).toBeUndefined()
  })

  it('marks a brief that IS cut, so only that one fades', () => {
    render(brief('7', '<p>a brief that runs well past three lines</p>'))
    expect(shelf()?.dataset.clipped).toBe('true')
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Open, nothing is cut any more, so the fade goes with the clamp.
    expect(shelf()?.dataset.clipped).toBeUndefined()
  })

  /**
   * THE MEASUREMENT FOLLOWS THE BRIEF (round 5). It ran once on mount, so the
   * height measured for the FIRST brief stayed in force for every brief after
   * it: scroll from a short prompt to a long one and the shelf clamped it with
   * no "Show full" anywhere, which is how "the truncate and read-more are
   * missing" was reported. Nothing resized — only the contents changed — so the
   * ResizeObserver could not cover it either.
   */
  it('re-measures when the shelf changes hands', () => {
    clipped = false
    render(brief('7', '<p>two words</p>'))
    expect(toggle()).toBeNull()

    clipped = true
    render(brief('9', '<p>a brief that runs well past three lines</p>'))
    expect(toggle()?.textContent).toBe('Show full')
    expect(shelf()?.dataset.clipped).toBe('true')

    // …and back the other way, so a short brief after a long one is not left
    // wearing the previous one's control.
    clipped = false
    render(brief('11', '<p>short again</p>'))
    expect(toggle()).toBeNull()
  })

  /**
   * THE SHUT HEIGHT IS THE STYLESHEET'S (round 8). It was written inline on
   * every render from a JS constant of 69px — three lines of 23px — which the
   * stylesheet could not see: `html[data-density="compact"]` sets the brief in
   * 13/21 and outranks the shelf's own rule, so compact density clamped a 21px
   * setting at 69 and showed three lines plus a sliver of a fourth. The clamp is
   * now `calc(var(--brief-lines) * 1lh)` in `.brief-shelf-text`, and nothing is
   * written here at all until the reader opens it.
   */
  it('leaves the clamp to CSS, and writes only the height it opens to', () => {
    render(brief('7', '<p>a brief that runs well past three lines</p>'))
    const text = (): HTMLElement => host.querySelector('.brief-shelf-text') as HTMLElement
    expect(text().style.maxHeight).toBe('')
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Open: the measured content height (999 in this suite), capped at 320 so a
    // pasted spec cannot cover the column it is drawn over. A transition needs
    // two real numbers, so this is a length and never a keyword.
    expect(text().style.maxHeight).toBe('320px')
    // …and closing gives the number back rather than animating to a second one.
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(text().style.maxHeight).toBe('')
  })

  /**
   * THE MEASUREMENT DOES NOT MOVE WHEN THE ANSWER DOES (round 8) — the flicker
   * this round was reported for. `scrollHeight` is the content whether the shelf
   * is open, shut, or mid-transition, and the clamp is computed from the line
   * box rather than read off the box's height, so neither number can be changed
   * by the fade and the control that depend on them. Opening a brief must
   * therefore not change what the shelf believes about it.
   */
  it('reads the same brief the same way open and shut', () => {
    render(brief('7', '<p>a brief that runs well past three lines</p>'))
    expect(shelf()?.dataset.clipped).toBe('true')
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Open, the fade is gone because nothing is cut any more — not because the
    // shelf has forgotten that the brief is long.
    expect(shelf()?.dataset.clipped).toBeUndefined()
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(shelf()?.dataset.clipped).toBe('true')
    expect(toggle()?.textContent).toBe('Show full')
  })

  it('omits the clock rather than inventing one', () => {
    render(brief('7', '<p>no timestamp on this row</p>', ''))
    expect(host.querySelector('.brief-shelf-time')).toBeNull()
    expect(toggle()).not.toBeNull()
  })
})

// The shelf is a SIBLING of the scroller, not a child, so both of these are
// things the browser would do for free inside the column and does not do for an
// overlay drawn beside it.
describe('the shelf over a feed it is not inside', () => {
  it('hands the wheel back to the scroller while clamped', () => {
    const scroller = document.createElement('div')
    scroller.scrollTop = 0
    render(brief('7', '<p>a brief</p>'), { current: scroller })
    const shelf = host.querySelector('.brief-shelf') as HTMLElement
    act(() => {
      shelf.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    })
    expect(scroller.scrollTop).toBe(120)
  })

  it('delegates clicks, so the brief’s own refs are not dead in the shelf', () => {
    const clicked: string[] = []
    render(brief('7', '<p>see <a class="ref-link" data-ref="POD-86">POD-86</a></p>'), null, (e) => {
      clicked.push((e.target as HTMLElement).getAttribute('data-ref') ?? '')
    })
    const chip = host.querySelector('a.ref-link') as HTMLElement
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).toEqual(['POD-86'])
  })
})
