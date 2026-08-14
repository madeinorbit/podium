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
const toggle = (): HTMLElement | null => host.querySelector('[data-testid="prompt-expand-toggle"]')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
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
