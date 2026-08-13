// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Profiler, type JSX, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ISSUE_VIRTUAL_MAX_ITEMS, useBoundedVirtualList } from './use-bounded-virtual-list'

const KEYS = Array.from({ length: 674 }, (_, index) => `issue-${index}`)

function WindowHarness({
  keys = KEYS,
  focusKey = null,
}: {
  keys?: string[]
  focusKey?: string | null
}): JSX.Element {
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null)
  const scrollRef = { current: scroll }
  const virtual = useBoundedVirtualList({
    keys,
    scrollRef,
    estimateSize: 40,
    pinnedKeys: [focusKey],
  })
  return (
    <div ref={setScroll} data-testid="scroll">
      <div style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => (
          <div
            key={item.key}
            ref={virtual.measureRef(item.key)}
            data-testid="row"
            data-index={item.index}
            data-start={item.start}
          >
            {item.key}
          </div>
        ))}
      </div>
    </div>
  )
}

function sizeViewport(node: HTMLElement, height: number): void {
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: height })
}

function NestedWindowHarness(): JSX.Element {
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const virtual = useBoundedVirtualList({
    keys: KEYS,
    scrollRef: { current: scroll },
    containerRef: { current: container },
    estimateSize: 40,
  })
  return (
    <div ref={setScroll} data-testid="nested-scroll">
      <div ref={setContainer} data-testid="nested-container" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => (
          <div key={item.key} data-testid="nested-row" data-index={item.index}>
            {item.key}
          </div>
        ))}
      </div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function flushViewport(): void {
  act(() => {
    vi.runOnlyPendingTimers()
  })
}

describe('bounded variable-height issue window', () => {
  it('keeps the 674-row DOM bounded after deep scrolling', () => {
    vi.useFakeTimers()
    const view = render(<WindowHarness />)
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 320)
    scroll.scrollTop = 20_000
    fireEvent.scroll(scroll)
    flushViewport()

    const rows = view.getAllByTestId('row')
    expect(rows.length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
    expect(Number(rows[0]?.dataset.index)).toBeGreaterThan(400)
    expect(Number(rows.at(-1)?.dataset.index)).toBeLessThan(674)
  })

  it('pins and scrolls a far keyboard focus without mounting its prefix', () => {
    vi.useFakeTimers()
    const view = render(<WindowHarness />)
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 320)
    view.rerender(<WindowHarness focusKey="issue-600" />)
    flushViewport()

    expect(view.getByText('issue-600')).toBeTruthy()
    expect(scroll.scrollTop).toBeGreaterThan(20_000)
    expect(view.getAllByTestId('row').length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS + 1)
  })

  it('keeps the visible anchor fixed when a row is inserted above it', () => {
    vi.useFakeTimers()
    const view = render(<WindowHarness />)
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 320)
    scroll.scrollTop = 800
    fireEvent.scroll(scroll)
    flushViewport()

    view.rerender(<WindowHarness keys={['inserted', ...KEYS]} />)
    flushViewport()
    expect(scroll.scrollTop).toBe(840)
    expect(view.getAllByTestId('row').length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
  })

  it('measures variable row heights into later item offsets', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const height = this.textContent === 'issue-0' ? 80 : 40
      return { top: 0, bottom: height, height } as DOMRect
    })
    const view = render(<WindowHarness keys={KEYS.slice(0, 3)} />)

    expect(view.getByText('issue-1').getAttribute('data-start')).toBe('80')
    expect(view.getAllByTestId('row')).toHaveLength(3)
  })

  it('coalesces repeated scroll events into one viewport publication per frame', () => {
    vi.useFakeTimers()
    let commits = 0
    const view = render(
      <Profiler id="virtual" onRender={() => void (commits += 1)}>
        <WindowHarness />
      </Profiler>,
    )
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 320)
    flushViewport()
    const before = commits
    scroll.scrollTop = 20_000
    fireEvent.scroll(scroll)
    fireEvent.scroll(scroll)
    fireEvent.scroll(scroll)
    expect(commits).toBe(before)
    flushViewport()
    expect(commits).toBe(before + 1)
  })

  it('uses the nested container offset once when calculating deep scroll', () => {
    vi.useFakeTimers()
    const view = render(<NestedWindowHarness />)
    const scroll = view.getByTestId('nested-scroll')
    const container = view.getByTestId('nested-container')
    sizeViewport(scroll, 320)
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: -240 } as DOMRect)
    scroll.scrollTop = 20_000
    fireEvent.scroll(scroll)
    flushViewport()
    const first = Number(view.getAllByTestId('nested-row')[0]?.getAttribute('data-index'))
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(20)
  })
})
