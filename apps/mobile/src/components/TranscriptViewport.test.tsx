import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createRef, type ReactElement, type Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptViewport } from './TranscriptViewport'
import type { TranscriptViewportHandle } from './TranscriptViewport.types'

let viewportHeight = 400
let heights = new Map<string, number>()
let observers: Array<{ notify: () => void; targets: Set<Element> }> = []
const keys = Array.from({ length: 12 }, (_, index) => `row-${index}`)
const rect = (top: number, height: number) =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON() {},
  }) as DOMRect

beforeEach(() => {
  viewportHeight = 400
  heights = new Map()
  observers = []
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
      unobserve(element: Element) {
        this.targets.delete(element)
      }
      disconnect() {
        this.targets.clear()
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'transcript-scroller' ? viewportHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'transcript-scroller'
      ? [...this.querySelectorAll<HTMLElement>('[data-row-key]')].reduce(
          (sum, row) =>
            sum +
            (row.dataset.rowKey === 'transcript:footer'
              ? 40
              : (heights.get(row.dataset.rowKey!) ?? 100)),
          0,
        )
      : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.testid === 'transcript-scroller') return rect(0, viewportHeight)
    const scroller = this.closest<HTMLElement>('[data-testid="transcript-scroller"]')
    if (!scroller) return rect(0, 0)
    let offset = -scroller.scrollTop
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-row-key]')) {
      const height =
        row.dataset.rowKey === 'transcript:footer' ? 40 : (heights.get(row.dataset.rowKey!) ?? 100)
      if (row === this) return rect(offset, height)
      offset += height
    }
    return rect(0, 0)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (
    this: HTMLElement,
    options?: number | ScrollToOptions,
  ) {
    if (typeof options === 'object') {
      this.scrollTop = Math.max(
        0,
        Math.min(this.scrollHeight - this.clientHeight, options.top ?? this.scrollTop),
      )
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function content(
  data = keys,
  options: {
    loadingOlder?: boolean
    onFollowChange?: (following: boolean) => void
    onLoadOlder?: () => void
    viewportRef?: Ref<TranscriptViewportHandle>
  } = {},
): ReactElement {
  return (
    <TranscriptViewport
      identity="one"
      ref={options.viewportRef}
      data={data}
      keyExtractor={(key) => key}
      renderItem={({ item }) => <span>{item}</span>}
      ListFooterComponent={<span>Working</span>}
      moreAbove
      loadingOlder={options.loadingOlder}
      onFollowChange={options.onFollowChange}
      onLoadOlder={options.onLoadOlder}
    />
  )
}
function read(scroller: HTMLElement, top: number): void {
  fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop })
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

function resized(): void {
  act(() => {
    for (const observer of observers) if (observer.targets.size) observer.notify()
  })
}

describe('phone web viewport', () => {
  it('bounds mounted rows and observed elements during a marathon live feed', () => {
    const initial = Array.from({ length: 3_000 }, (_, index) => `row-${index}`)
    const { container, getByTestId, rerender } = render(content(initial))
    resized()
    const scroller = getByTestId('transcript-scroller')
    expect(container.querySelectorAll('[data-block]')).toHaveLength(81)
    expect(container.querySelector('[data-block="2920"]')).not.toBeNull()
    for (let count = 4_000; count <= 10_000; count += 1_000) {
      rerender(content(Array.from({ length: count }, (_, index) => `row-${index}`)))
      resized()
      expect(container.querySelectorAll('[data-block]')).toHaveLength(81)
      expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight)
      expect(
        new Set(observers.flatMap((observer) => [...observer.targets])).size,
      ).toBeLessThanOrEqual(83)
    }
  })
  it('reveals held history before requesting older disk pages, without replacing the reader', () => {
    const older = vi.fn()
    const data = Array.from({ length: 160 }, (_, index) => `row-${index}`)
    const { container, getByTestId } = render(content(data, { onLoadOlder: older }))
    resized()
    const scroller = getByTestId('transcript-scroller')
    const row = container.querySelector('[data-row-key="row-80"]')
    act(() => read(scroller, 80))
    resized()
    expect(container.querySelector('[data-row-key="row-80"]')).toBe(row)
    expect(container.querySelector('[data-row-key="row-0"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-block]')).toHaveLength(161)
    expect(older).not.toHaveBeenCalled()
    act(() => read(scroller, 80))
    expect(older).toHaveBeenCalledOnce()
  })
  it('reveals an unmounted search target and trims again when the reader returns to newest', () => {
    const viewportRef = createRef<TranscriptViewportHandle>()
    const data = Array.from({ length: 500 }, (_, index) => `row-${index}`)
    const { container, getByTestId } = render(content(data, { viewportRef }))
    resized()
    act(() => viewportRef.current?.scrollToIndex({ index: 20, animated: false }))
    resized()
    expect(
      container.querySelector('[data-row-key="row-20"]')?.getBoundingClientRect().top,
    ).toBeCloseTo(0)
    const scroller = getByTestId('transcript-scroller')
    expect(container.querySelectorAll('[data-block]').length).toBeGreaterThan(81)
    act(() => viewportRef.current?.pinToNewest())
    resized()
    expect(container.querySelectorAll('[data-block]')).toHaveLength(81)
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight)
  })
  it('retains the latest reader position through loading and actual prepend commits', () => {
    const mode = vi.fn()
    const { getByTestId, container, rerender } = render(content(keys, { onFollowChange: mode }))
    resized()
    const scroller = getByTestId('transcript-scroller')
    expect(scroller.scrollTop).toBe(840)
    act(() => read(scroller, 80))
    rerender(content(keys, { loadingOlder: true, onFollowChange: mode }))
    resized()
    act(() => read(scroller, 320))
    const row = container.querySelector('[data-row-key="row-3"]')!
    rerender(content(['older-one', 'older-two', ...keys], { onFollowChange: mode }))
    resized()
    expect(scroller.scrollTop).toBe(520)
    expect(row.getBoundingClientRect().top).toBe(-20)
    expect(container.querySelector('[data-row-key="row-3"]')).toBe(row)
    expect(mode).toHaveBeenLastCalledWith(false)
  })
  it('does not trim or replace a loaded message when live rows arrive', () => {
    const { container, getByTestId, rerender } = render(content())
    resized()
    const scroller = getByTestId('transcript-scroller')
    act(() => read(scroller, 320))
    const row = container.querySelector('[data-row-key="row-3"]')!
    rerender(content([...keys, ...Array.from({ length: 400 }, (_, index) => `new-${index}`)]))
    resized()
    expect(scroller.scrollTop).toBe(320)
    expect(container.querySelector('[data-row-key="row-3"]')).toBe(row)
    expect(container.querySelectorAll('[data-block]')).toHaveLength(413)
  })
})
