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

const ask = (id: string, text: string): TranscriptItem =>
  ({ id, role: 'user', text }) as TranscriptItem

const rowsOf = (items: TranscriptItem[]): ChatRow[] => buildChatRows(pairToolResults(items))

const rowsFor = (count: number): ChatRow[] =>
  rowsOf(Array.from({ length: count }, (_, i) => say(`i${i}`, `line ${i}`)))

/** A scroller carrying one measurable [data-block] child per given index, since
 *  the map reads real geometry and happy-dom reports zero for all of it. The
 *  indices are ABSOLUTE row indices, which is not the same as DOM position once a
 *  sticky continuation from above the window is mounted at the top. */
function buildScroller(indices: number[]): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', { value: indices.length * 100, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  el.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect
  indices.forEach((index, pos) => {
    const block = document.createElement('div')
    block.setAttribute('data-block', String(index))
    Object.defineProperty(block, 'offsetHeight', { value: 100, configurable: true })
    block.getBoundingClientRect = () => ({ top: pos * 100, height: 100 }) as DOMRect
    el.append(block)
  })
  document.body.append(el)
  return el
}

const upTo = (count: number): number[] => Array.from({ length: count }, (_, i) => i)

function render(
  rows: ChatRow[],
  opts: { baseIndex?: number; isOperatorPromptRow?: (row: ChatRow) => boolean } = {},
): void {
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
  ref.current = scroller
  act(() => {
    root.render(
      <Minimap
        rows={rows}
        scrollerRef={ref}
        baseIndex={opts.baseIndex ?? 0}
        isOperatorPromptRow={opts.isOperatorPromptRow ?? (() => true)}
      />,
    )
  })
}

/** Each tick as `kind@top%`, in the order they PAINT — later wins the overlap. */
const painted = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('.minimap-tick')].map((el) => {
    const kind = [...el.classList]
      .find((c) => c.startsWith('minimap-tick--') && c !== 'minimap-tick--hover')
      ?.slice('minimap-tick--'.length)
    return `${kind ?? '?'}@${el.style.top}`
  })

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
  scroller = buildScroller(upTo(5))
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

  // THE STICKY CONTINUATION IS NOT ROW ZERO.
  //
  // Past RENDER_WINDOW rows the feed also mounts the nearest operator prompt from
  // ABOVE the window, as a one-row sticky continuation carrying its own absolute
  // [data-block]. The map used to infer its window base from the SMALLEST
  // measured index, which is that continuation's — so every offset was rebased by
  // the wrong amount and the bands stopped describing the rows under them. With
  // the prompt far above the window almost nothing matched at all and the map went
  // blank; with it just above, every band was off by one row, which is how a
  // prompt band came to be painted where the work after it actually sits.
  it('measures the window against its own base, not the sticky continuation', () => {
    // Prompt at absolute row 2 mounted above a window that starts at row 10.
    scroller = buildScroller([2, 10, 11, 12, 13])
    const rows = rowsOf([
      ask('u10', 'reclaim the header'),
      say('a11', 'narration'),
      say('a12', 'more narration'),
      say('a13', 'still narrating'),
    ])
    render(rows, { baseIndex: 10, isOperatorPromptRow: (r) => r === rows[0] })
    flushFrames()

    // Four windowed rows, four bands — the continuation is a REPEAT of a row
    // above the window and gets no band of its own.
    expect(host.querySelectorAll('.minimap-tick')).toHaveLength(4)
    // Row 10 is the prompt, and it sits where row 10 was measured: the second of
    // five mounted blocks, i.e. 20% down the scroll range.
    const you = host.querySelector<HTMLElement>('.minimap-tick--you')
    expect(you?.style.top).toBe('20%')
  })

  // A LANDMARK IS NOT ALLOWED TO BE PAINTED OVER.
  //
  // Ticks are absolutely positioned siblings with no z-index, so the later one
  // wins wherever two overlap — and they DO overlap, because a band shorter than
  // the minimum is drawn at the minimum. A typed prompt is the shortest row in a
  // long transcript and the run of work under it is the longest, so drawing in row
  // order meant the work band repainted all but a sliver of the prompt the reader
  // was scrubbing for. The field paints first; the landmarks paint over it.
  it('paints prompt and answer bands over the field around them', () => {
    scroller = buildScroller(upTo(3))
    const rows = rowsOf([
      ask('u0', 'reclaim the header'),
      say('a1', 'narration'),
      say('a2', 'narration'),
    ])
    render(rows, { isOperatorPromptRow: (r) => r === rows[0] })
    flushFrames()

    expect(painted()).toEqual(['agent@33.33333333333333%', 'agent@66.66666666666666%', 'you@0%'])
  })

  // MAIL IS NOT A PROMPT.
  //
  // Delivered messages — agent mail, superagent traffic, machine context seeds —
  // reach the harness as `role: 'user'` turns, and the map painted every one of
  // them in the full-width issue hue reserved for something the human typed. On a
  // session with any traffic at all that is most of the "You" bands on the column,
  // which is the other half of "the map doesn't show my messages": they were shown,
  // among a dozen bands that looked exactly like them.
  it('spends the You band only on rows the human typed', () => {
    scroller = buildScroller(upTo(3))
    const rows = rowsOf([
      ask('u0', 'reclaim the header'),
      ask('m1', 'From: podium · 2 notes'),
      say('a2', 'narration'),
    ])
    render(rows, { isOperatorPromptRow: (r) => r === rows[0] })
    flushFrames()

    expect(host.querySelectorAll('.minimap-tick--you')).toHaveLength(1)
    expect(host.querySelector<HTMLElement>('.minimap-tick--you')?.style.top).toBe('0%')
  })
})
