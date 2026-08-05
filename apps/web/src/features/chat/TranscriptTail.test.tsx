import type { ChatActivity } from '@podium/client-core/viewmodels'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptTail } from './TranscriptTail'

// THE TAIL (POD-376): one object, three weights. What this pins is which state
// the feed ends in, what figure that state is allowed to show, and that the two
// states which must not move (waiting, idle) carry no perpetual motion.

let host: HTMLDivElement
let root: Root

function mount(activity: ChatActivity | null, since?: string): void {
  act(() => {
    root.render(<TranscriptTail activity={activity} since={since} />)
  })
}

const tail = (): HTMLElement | null => host.querySelector('[data-testid="feed-tail"]')
const figure = (): string | undefined => host.querySelector('.feed-tail-figure')?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.useRealTimers()
})

/** An instant `ms` before the frozen clock. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

describe('TranscriptTail', () => {
  it('shows nothing when there is neither activity nor a last stop', () => {
    mount(null, undefined)
    expect(tail()).toBeNull()
  })

  it('counts a working turn on a live clock, in the live hue', () => {
    mount({ label: 'Working…', tone: 'working' }, ago(42_000))
    expect(tail()?.dataset.tail).toBe('working')
    expect(host.textContent).toContain('Working…')
    // A live timer is the one figure that earns second precision.
    expect(figure()).toBe('0:42')
    // …and it is the one state licensed to move.
    expect(host.querySelector('.spb')).not.toBeNull()
  })

  it('addresses the reader when the agent is waiting on them, and stays still', () => {
    mount({ label: 'needs answer', tone: 'attention' }, ago(130_000))
    expect(tail()?.dataset.tail).toBe('waiting')
    // The session-state phrase is rewritten for the person being asked.
    expect(host.textContent).toContain('Waiting for your answer')
    expect(figure()).toBe('2m')
    expect(host.querySelector('.spb')).toBeNull()
    // Not dimmed: a question waiting on the human must not recede.
    expect(tail()?.dataset.stale).toBeUndefined()
  })

  it('names the approval case as an approval', () => {
    mount({ label: 'needs permission', tone: 'attention' })
    expect(host.textContent).toContain('Waiting for your approval')
  })

  it('recedes when idle, and further once the session has been quiet', () => {
    mount(null, ago(17 * 60_000 + 39_000))
    expect(tail()?.dataset.tail).toBe('idle')
    // Minutes, not "17m 39s": past the first minute the seconds digit is noise,
    // and dropping it is what lets the row stop redrawing.
    expect(figure()).toBe('17m')
    expect(tail()?.dataset.stale).toBe('true')

    mount(null, ago(40_000))
    expect(figure()).toBe('40s')
    expect(tail()?.dataset.stale).toBeUndefined()
  })

  it('keeps the idle clock out of the live region', () => {
    // Nothing is changing, so nothing should be announced — an idle row that
    // re-announced on every tick would talk over everything else on the page.
    mount(null, ago(60_000))
    expect(tail()?.getAttribute('aria-live')).toBeNull()
    mount({ label: 'Working…', tone: 'working' }, ago(1000))
    expect(tail()?.getAttribute('aria-live')).toBe('polite')
  })
})
