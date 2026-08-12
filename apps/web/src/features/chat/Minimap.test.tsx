import type { TranscriptItem } from '@podium/model'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, type ChatRow, pairToolResults } from './chat'
import { Minimap } from './Minimap'

// THE MAP AGAINST A LIST THAT SHRANK.
//
// Ticks are DOM measurements held in state and written from a rAF-deferred
// effect, so they are always a frame behind the `rows` prop that names what each
// tick IS. When a commit makes `rows` SHORTER — summary verbosity filters rows
// out, a second batchable tool call folds two rows into one — the map renders
// the new short list against the old long tick set. Every tick past the end then
// names a row that is not there, and the band lookup used to walk straight into
// it (`rowBand(rows[i] as ChatRow)`), crashing the whole interface with
// "undefined is not an object (evaluating 'e.kind')". The cast is what let it
// compile. What follows pins the frame in between.

let host: HTMLDivElement
let root: Root
let scroller: HTMLDivElement
let frames: FrameRequestCallback[] = []

const say = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'assistant', text }) as TranscriptItem

const rowsFor = (count: number): ChatRow[] =>
  buildChatRows(pairToolResults(Array.from({ length: count }, (_, i) => say(`i${i}`, `line ${i}`))))

/** A scroller carrying `count` measurable [data-block] children, since the map
 *  reads real geometry and happy-dom reports zero for all of it. */
function buildScroller(count: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: count * 100, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect
  for (let i = 0; i < count; i++) {
    const block = document.createElement('div')
    block.setAttribute('data-block', String(i))
    Object.defineProperty(block, 'offsetHeight', { value: 100, configurable: true })
    block.getBoundingClientRect = () => ({ top: i * 100, height: 100 }) as DOMRect
    el.append(block)
  }
  document.body.append(el)
  return el
}

function render(rows: ChatRow[]): void {
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
  ref.current = scroller
  act(() => {
    root.render(<Minimap rows={rows} scrollerRef={ref} />)
  })
}

/** Run the frames the map asked for — i.e. let it measure. Withholding this is
 *  how the test holds the map one frame behind its rows. */
function flushFrames(): void {
  act(() => {
    const queued = frames
    frames = []
    for (const cb of queued) cb(0)
  })
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  scroller = buildScroller(5)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  scroller.remove()
  vi.unstubAllGlobals()
})

describe('Minimap', () => {
  it('draws one tick per measured row', () => {
    render(rowsFor(5))
    flushFrames()
    expect(host.querySelectorAll('.minimap-tick')).toHaveLength(5)
  })

  it('survives the frame where rows shrink under already-measured ticks', () => {
    render(rowsFor(5))
    flushFrames()
    expect(host.querySelectorAll('.minimap-tick')).toHaveLength(5)

    // The shrinking commit, with the measure frame WITHHELD: five ticks in
    // state, two rows to name them with. Rendering this at all is the bug.
    expect(() => render(rowsFor(2))).not.toThrow()

    // And the three ticks with nothing behind them are gone rather than drawn
    // in some fallback colour — a tick that names no row is not a band.
    expect(host.querySelectorAll('.minimap-tick')).toHaveLength(2)
  })

  it('keeps the flyout off a band whose row no longer exists', () => {
    render(rowsFor(5))
    flushFrames()
    render(rowsFor(2))
    expect(host.querySelector('.minimap-flyout')).toBeNull()
  })
})
