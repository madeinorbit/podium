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

function Harness({ moreAbove = false }: { moreAbove?: boolean }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  api = useTranscriptScroll({
    sessionId: asSessionId('session-1'),
    scrollerRef,
    active: true,
    blockCount: 1,
    renderStart: 0,
    stickyEnabled: false,
    moreAbove,
    loadOlder,
    rowsToRender: ['row-1'],
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
