import { asSessionId } from '@podium/model'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

let host: HTMLDivElement
let root: Root
let api: UseTranscriptScrollResult
let loadOlder = vi.fn()
let viewport = 400
let tail = 40
let heights = new Map<string, number>()
let observers: Array<{ notify: () => void; targets: Set<Element> }> = []
const held = Array.from({ length: 12 }, (_, index) => `row-${index}`)

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 500,
    width: 500,
    height,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect
}

function Harness({
  keys = held,
  moreAbove = false,
  loadingOlder = false,
  active = true,
  sessionId = 'session-1',
  onFollowChange,
  aliases,
}: {
  keys?: string[]
  moreAbove?: boolean
  loadingOlder?: boolean
  active?: boolean
  sessionId?: string
  onFollowChange?: (following: boolean) => void
  aliases?: Record<string, string[]>
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  api = useTranscriptScroll({
    sessionId: asSessionId(sessionId),
    scrollerRef,
    active,
    blockCount: keys.length,
    renderStart: 0,
    stickyEnabled: false,
    moreAbove,
    loadingOlder,
    loadOlder,
    rowsToRender: keys,
    onFollowChange,
  })
  return (
    <div
      data-scroller
      ref={api.setScrollerRef}
      onScroll={api.onScroll}
      onPointerUp={api.onPointerUp}
    >
      <div ref={api.setContentRef}>
        {keys.map((key, index) => (
          <div
            key={key}
            data-row-key={key}
            data-row-aliases={aliases?.[key] ? JSON.stringify(aliases[key]) : undefined}
            data-block={index}
          >
            {key}
          </div>
        ))}
      </div>
    </div>
  )
}

const scroller = (): HTMLDivElement => host.firstElementChild as HTMLDivElement
const row = (key: string): HTMLElement => host.querySelector(`[data-row-key="${key}"]`)!
const top = (key: string): number => row(key).getBoundingClientRect().top

function scrollTo(offset: number): void {
  act(() => {
    scroller().dispatchEvent(
      new WheelEvent('wheel', { deltaY: offset - scroller().scrollTop, bubbles: true }),
    )
    scroller().scrollTop = offset
    scroller().dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

function resize(): void {
  act(() => {
    for (const observer of observers) if (observer.targets.size > 0) observer.notify()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  viewport = 400
  tail = 40
  heights = new Map()
  observers = []
  loadOlder = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>()
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          targets: this.targets,
          notify: () => callback([], this as unknown as ResizeObserver),
        })
      }
      observe(element: Element) {
        this.targets.add(element)
      }
      disconnect() {
        this.targets.clear()
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-scroller') ? viewport : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-scroller')
      ? [...this.querySelectorAll<HTMLElement>('[data-block]')].reduce(
          (sum, el) => sum + (heights.get(el.dataset.rowKey!) ?? 100),
          tail,
        )
      : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-scroller')) return rect(0, viewport)
    const parent = this.closest<HTMLElement>('[data-scroller]')
    if (!parent) return rect(0, 0)
    let offset = -parent.scrollTop
    for (const element of parent.querySelectorAll<HTMLElement>('[data-block]')) {
      const height = heights.get(element.dataset.rowKey!) ?? 100
      if (element === this) return rect(offset, height)
      offset += height
    }
    return rect(0, 0)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('transcript scrolling', () => {
  it('does not request history from a browser clamp after a page becomes short', () => {
    act(() => root.render(<Harness moreAbove />))
    scrollTo(320)
    expect(loadOlder).not.toHaveBeenCalled()
    act(() => {
      // Model the browser clamping the offset before ResizeObserver/event delivery.
      scroller().scrollTop = 0
      root.render(<Harness keys={held.slice(0, 2)} moreAbove />)
    })
    act(() => scroller().dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(loadOlder).not.toHaveBeenCalled()
    expect(api.atBottom).toBe(false)
    act(() => scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })
  it.each(['wheel', 'touch', 'keyboard'])(
    'requests history from %s input at the top even when the loaded page cannot scroll',
    (input) => {
      const keys = held.slice(0, 2)
      const moveUp = () => {
        if (input === 'wheel') {
          scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
        } else if (input === 'keyboard') {
          scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
        } else {
          scroller().dispatchEvent(
            Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientY: 100 }] }),
          )
          scroller().dispatchEvent(
            Object.assign(new Event('touchmove', { bubbles: true }), { touches: [{ clientY: 160 }] }),
          )
        }
      }
      act(() => root.render(<Harness keys={keys} moreAbove />))
      expect(scroller().scrollHeight).toBeLessThan(viewport)
      expect(loadOlder).not.toHaveBeenCalled()
      act(moveUp)
      expect(loadOlder).toHaveBeenCalledTimes(1)
      expect(api.atBottom).toBe(false)
      // No scroll event is dispatched: a browser cannot move this short page.
      act(() => root.render(<Harness keys={keys} moreAbove loadingOlder />))
      act(moveUp)
      expect(loadOlder).toHaveBeenCalledTimes(1)
    },
  )
  it('does not accumulate small fractional reflows into a visible drift', () => {
    act(() => root.render(<Harness />))
    scrollTo(320)
    for (let index = 1; index <= 30; index++) {
      heights.set('row-0', 100 + index * 0.4)
      resize()
    }
    expect(top('row-3')).toBeCloseTo(-20)
  })
  it('finds the retained item when prepending merges it into a differently keyed tool row', () => {
    act(() => root.render(<Harness />))
    scrollTo(80)
    act(() =>
      root.render(
        <Harness
          keys={['older-a', 'older-b', 'regrouped', ...held.slice(1)]}
          aliases={{ regrouped: ['older-tool', 'row-0'] }}
        />,
      ),
    )
    expect(scroller().scrollTop).toBe(280)
    expect(top('regrouped')).toBe(-80)
    expect(api.atBottom).toBe(false)
  })

  it('keeps reading intent when a host replaces its follow callback', () => {
    const first = vi.fn()
    const latest = vi.fn()
    act(() => root.render(<Harness onFollowChange={first} />))
    scrollTo(320)
    act(() => root.render(<Harness onFollowChange={latest} />))
    tail += 200
    resize()
    expect(api.atBottom).toBe(false)
    expect(scroller().scrollTop).toBe(320)
    act(() => api.jumpToBottom())
    expect(latest).toHaveBeenLastCalledWith(true)
  })

  it('opens at the tail and follows content and viewport resizing', () => {
    act(() => root.render(<Harness />))
    expect(scroller().scrollTop).toBe(840)
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(940)
    viewport -= 150
    resize()
    expect(scroller().scrollTop).toBe(1090)
    expect(api.atBottom).toBe(true)
    expect(scroller().style.overflowAnchor).toBe('none')
  })

  it('releases on the first wheel input, even before its scroll event or a live resize', () => {
    act(() => root.render(<Harness />))
    act(() => scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })))
    expect(api.atBottom).toBe(false)
    tail += 200
    resize()
    expect(scroller().scrollTop).toBe(840)
  })

  it('releases on an upward touch drag before streaming can steal it', () => {
    act(() => root.render(<Harness />))
    act(() => {
      scroller().dispatchEvent(
        Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientY: 100 }] }),
      )
      scroller().dispatchEvent(
        Object.assign(new Event('touchmove', { bubbles: true }), { touches: [{ clientY: 160 }] }),
      )
    })
    tail += 200
    resize()
    expect(api.atBottom).toBe(false)
    expect(scroller().scrollTop).toBe(840)
  })

  it('keeps its anchor through loading-only commits until the actual older rows mount', () => {
    act(() => root.render(<Harness moreAbove />))
    scrollTo(80)
    const retained = row('row-0')
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(top('row-0')).toBe(-80)
    act(() => root.render(<Harness moreAbove loadingOlder />))
    act(() => root.render(<Harness moreAbove keys={[...held]} />))
    tail += 250
    act(() => root.render(<Harness keys={['older-a', 'older-b', ...held]} />))
    expect(row('row-0')).toBe(retained)
    expect(top('row-0')).toBe(-80)
    expect(scroller().scrollTop).toBe(280)
    expect(api.atBottom).toBe(false)
    act(() => scroller().dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('preserves the newer reading position when the reader moves during a page request', () => {
    act(() => root.render(<Harness moreAbove />))
    scrollTo(80)
    act(() => root.render(<Harness moreAbove loadingOlder />))
    scrollTo(320)
    act(() => root.render(<Harness keys={['older-a', 'older-b', ...held]} />))
    expect(scroller().scrollTop).toBe(520)
    expect(top('row-3')).toBe(-20)
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('also preserves movement whose compositor scroll event has not arrived yet', () => {
    act(() => root.render(<Harness moreAbove />))
    scrollTo(80)
    scroller().scrollTop = 320
    act(() => root.render(<Harness keys={['older-a', 'older-b', ...held]} />))
    expect(scroller().scrollTop).toBe(520)
    expect(top('row-3')).toBe(-20)
  })

  it('compensates only reflow above the reader, independently of tail growth', () => {
    act(() => root.render(<Harness />))
    scrollTo(320)
    heights.set('row-0', 175)
    tail += 900
    resize()
    expect(scroller().scrollTop).toBe(395)
    expect(top('row-3')).toBe(-20)
    expect(api.atBottom).toBe(false)
  })

  it('does not resume follow merely because shrinking content comes near the reader', () => {
    act(() => root.render(<Harness />))
    scrollTo(820)
    tail = 20
    resize()
    expect(api.atBottom).toBe(false)
    tail += 200
    resize()
    expect(scroller().scrollTop).toBe(820)
  })

  it('resumes only when the reader scrolls to the actual tail, not a 70px band', () => {
    act(() => root.render(<Harness />))
    scrollTo(400)
    scrollTo(810)
    expect(api.atBottom).toBe(false)
    scrollTo(840)
    expect(api.atBottom).toBe(true)
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(940)
  })

  it('does not consume reader movement when a resize callback precedes its scroll event', () => {
    act(() => root.render(<Harness />))
    scrollTo(320)
    act(() => scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 520, bubbles: true })))
    scroller().scrollTop = 840
    resize()
    act(() => scroller().dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(api.atBottom).toBe(true)
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(940)
  })

  it('jump and send follow later growth but allow an immediate escape', () => {
    act(() => root.render(<Harness />))
    scrollTo(200)
    act(() => api.jumpToBottom())
    expect(scroller().scrollTop).toBe(840)
    scrollTo(700)
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(700)
    act(() => api.pinToBottom())
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(1040)
  })

  it('keeps a hidden reader in place on activation and resets on conversation switch', () => {
    act(() => root.render(<Harness />))
    scrollTo(320)
    act(() => root.render(<Harness active={false} />))
    tail += 200
    act(() => root.render(<Harness />))
    expect(scroller().scrollTop).toBe(320)
    expect(api.atBottom).toBe(false)
    act(() => root.render(<Harness sessionId="session-2" />))
    expect(scroller().scrollTop).toBe(1040)
    expect(api.atBottom).toBe(true)
  })

  it('routes minimap and shelf navigation through the same reading state', () => {
    act(() => root.render(<Harness />))
    act(() => api.scrollToOffset(320))
    tail += 100
    resize()
    expect(scroller().scrollTop).toBe(320)
    act(() => api.scrollBy(-100))
    expect(scroller().scrollTop).toBe(220)
    expect(api.atBottom).toBe(false)
  })

  it('pauses following for a transcript selection without replacing its text', () => {
    act(() => root.render(<Harness />))
    const text = row('row-8').firstChild!
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()!
    act(() => {
      selection.removeAllRanges()
      selection.addRange(range)
      api.onPointerUp()
    })
    expect(selection.isCollapsed).toBe(false)
    expect(selection.rangeCount).toBe(1)
    expect(scroller().contains(selection.getRangeAt(0).commonAncestorContainer)).toBe(true)
    tail += 100
    resize()
    expect(api.atBottom).toBe(false)
    expect(scroller().scrollTop).toBe(840)
    expect(row('row-8').firstChild).toBe(text)
  })
})
