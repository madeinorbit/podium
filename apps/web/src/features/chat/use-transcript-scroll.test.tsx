import { asSessionId } from '@podium/model'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

const scrollToBottom = vi.fn(() => true)
const stopScroll = vi.fn()

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => {
    const scrollRef = Object.assign(vi.fn(), { current: null })
    const contentRef = Object.assign(vi.fn(), { current: null })
    return {
      scrollRef,
      contentRef,
      scrollToBottom,
      stopScroll,
      isAtBottom: true,
    }
  },
}))

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult | null = null
let loadOlder = vi.fn()

function Harness({
  moreAbove = false,
  blockCount = 1,
}: {
  moreAbove?: boolean
  blockCount?: number
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  api = useTranscriptScroll({
    sessionId: asSessionId('session-1'),
    scrollerRef,
    active: true,
    blockCount,
    renderStart: 0,
    stickyEnabled: false,
    moreAbove,
    loadOlder,
    rowsToRender: Array.from({ length: blockCount }, (_, index) => `row-${index}`),
  })
  return (
    <div ref={api.setScrollerRef} onScroll={api.onScroll} onPointerUp={api.onPointerUp}>
      <div ref={api.setContentRef}>
        <div data-block="0">row</div>
      </div>
    </div>
  )
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api = null
  loadOlder = vi.fn()
  scrollToBottom.mockClear()
  stopScroll.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('transcript scroll integration', () => {
  it('gives jump and send the same stale-scroll settle window', () => {
    act(() => root.render(<Harness />))
    act(() => api?.jumpToBottom())
    act(() => api?.pinToBottom())
    expect(scrollToBottom.mock.calls.slice(-2)).toEqual([
      [{ animation: 'instant', ignoreEscapes: true, duration: 350 }],
      [{ animation: 'instant', ignoreEscapes: true, duration: 350 }],
    ])
  })

  it('loads older history only near the normal top edge', () => {
    act(() => root.render(<Harness moreAbove />))
    const scroller = host.firstElementChild as HTMLDivElement
    scroller.scrollTop = 200
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(loadOlder).not.toHaveBeenCalled()
    scroller.scrollTop = 80
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('does not restore a stale history anchor after the reader scrolls away', () => {
    act(() => root.render(<Harness moreAbove />))
    const scroller = host.firstElementChild as HTMLDivElement
    const row = host.querySelector('[data-block]') as HTMLDivElement
    let rowTop = 10
    scroller.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        left: 0,
        right: 500,
        width: 500,
        height: 500,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect
    row.getBoundingClientRect = () =>
      ({
        top: rowTop,
        bottom: rowTop + 20,
        left: 0,
        right: 500,
        width: 500,
        height: 20,
        x: 0,
        y: rowTop,
        toJSON() {},
      }) as DOMRect

    scroller.scrollTop = 80
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(loadOlder).toHaveBeenCalledTimes(1)

    scroller.scrollTop = 200
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    rowTop = 110
    act(() => root.render(<Harness moreAbove blockCount={2} />))
    expect(scroller.scrollTop).toBe(200)
  })

  it('pauses follow when the reader has selected transcript text', () => {
    act(() => root.render(<Harness />))
    const text = host.querySelector('[data-block]')?.firstChild
    expect(text).toBeDefined()
    const range = document.createRange()
    range.selectNodeContents(text!)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => api?.onPointerUp())
    expect(stopScroll).toHaveBeenCalledTimes(1)
  })
})
