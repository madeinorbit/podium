// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Profiler, type JSX, useRef, useState } from 'react'
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

function NestedWindowHarness({ keys = KEYS }: { keys?: string[] }): JSX.Element {
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const virtual = useBoundedVirtualList({
    keys,
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

/** Stable refs, as WorklistWindow passes them: no render re-subscribes. */
function SectionedWindowHarness({ late = false }: { late?: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const virtual = useBoundedVirtualList({ keys: KEYS, scrollRef, containerRef, estimateSize: 40 })
  return (
    <div ref={scrollRef} data-testid="sectioned-scroll">
      {late ? <div data-testid="late-section" /> : null}
      <div data-testid="preceding-section" />
      <div>
        <div ref={containerRef} data-testid="sectioned-container">
          {virtual.items.map((item) => (
            <div key={item.key} data-testid="sectioned-row">
              {item.key}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Delivers resize entries only for elements a hook actually observes. */
class RecordingResizeObserver {
  static all = new Set<RecordingResizeObserver>()
  readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.all.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    RecordingResizeObserver.all.delete(this)
  }
  static resize(target: Element) {
    for (const observer of [...RecordingResizeObserver.all])
      if (observer.targets.has(target))
        observer.callback([{ target } as ResizeObserverEntry], observer as never)
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  RecordingResizeObserver.all.clear()
})

function flushViewport(): void {
  act(() => {
    vi.runOnlyPendingTimers()
  })
}

describe('bounded variable-height issue window', () => {
  it('keeps a viewport buffer mounted on either side of a deep scroll', () => {
    vi.useFakeTimers()
    const view = render(<WindowHarness />)
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 320)
    scroll.scrollTop = 2000
    fireEvent.scroll(scroll)
    flushViewport()
    const indexes = view.getAllByTestId('row').map(row => Number(row.dataset.index))
    expect(indexes[0]).toBeLessThanOrEqual(42)
    expect(indexes.at(-1)).toBeGreaterThanOrEqual(65)
    expect(indexes.length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
  })

  it('reserves the capped window for visible rows before overscan in a tall viewport', () => {
    vi.useFakeTimers()
    const view = render(<WindowHarness />)
    const scroll = view.getByTestId('scroll')
    sizeViewport(scroll, 1600)
    scroll.scrollTop = 8000
    fireEvent.scroll(scroll)
    flushViewport()
    const indexes = view.getAllByTestId('row').map(row => Number(row.dataset.index))
    expect(indexes).toContain(200)
    expect(indexes).toContain(239)
    expect(indexes.length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
  })

  it('keeps the row anchor when an earlier group shifts the nested container', () => {
    vi.useFakeTimers()
    const view = render(<NestedWindowHarness />)
    const scroll = view.getByTestId('nested-scroll')
    const container = view.getByTestId('nested-container')
    sizeViewport(scroll, 320)
    let precedingHeight = 0
    Object.defineProperty(container, 'offsetParent', { configurable: true, value: scroll })
    vi.spyOn(container, 'offsetTop', 'get').mockImplementation(() => precedingHeight)
    scroll.scrollTop = 800
    fireEvent.scroll(scroll); flushViewport()
    precedingHeight = 400
    view.rerender(<NestedWindowHarness keys={[...KEYS]} />); flushViewport()
    expect(scroll.scrollTop).toBe(1200)
    precedingHeight = 0
    view.rerender(<NestedWindowHarness keys={[...KEYS]} />); flushViewport()
    expect(scroll.scrollTop).toBe(800)
  })
  it.each([0, 48])('keeps selection redraw and scroll ID reads flat at 1x and 4x with height %i', height => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, height } as DOMRect)
    const counts = [1, 4].map(scale => {
      let reads = 0
      const keys = new Proxy(Array.from({ length: 674 * scale }, (_, index) => `issue-${index}`), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads++
          return Reflect.get(target, key, receiver)
        },
      })
      const view = render(<WindowHarness keys={keys} />)
      const scroll = view.getByTestId('scroll')
      sizeViewport(scroll, 320)
      flushViewport()
      reads = 0
      view.rerender(<WindowHarness keys={keys} focusKey="issue-2" />)
      flushViewport()
      const selection = reads
      view.rerender(<WindowHarness keys={keys} />)
      flushViewport()
      reads = 0
      scroll.scrollTop = 800
      fireEvent.scroll(scroll)
      flushViewport()
      const scrolling = reads
      expect(view.getAllByTestId('row').length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS + 1)
      view.unmount()
      console.info('board viewport ID reads', JSON.stringify({ scale, height, selection, scrolling }))
      return { selection, scrolling }
    })
    expect(counts[0]!.selection).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS * 2)
    expect(counts[0]!.scrolling).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS * 2)
    expect(counts[1]).toEqual(counts[0])
  })

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
    Object.defineProperty(container, 'offsetParent', { configurable: true, value: scroll })
    vi.spyOn(container, 'offsetTop', 'get').mockReturnValue(19_760)
    scroll.scrollTop = 20_000
    fireEvent.scroll(scroll)
    flushViewport()
    const first = Number(view.getAllByTestId('nested-row')[0]?.getAttribute('data-index'))
    expect(first).toBe(0)
    expect(Number(view.getAllByTestId('nested-row').at(-1)?.getAttribute('data-index'))).toBe(21)
  })

  it('shares layout coordinates when a contained fold skips the scroller as offset parent', () => {
    vi.useFakeTimers()
    const view = render(<NestedWindowHarness keys={KEYS.slice(0, 8)} />)
    const scroll = view.getByTestId('nested-scroll')
    const container = view.getByTestId('nested-container')
    const fold = document.createElement('div')
    sizeViewport(scroll, 320)
    vi.spyOn(scroll, 'offsetTop', 'get').mockReturnValue(120)
    vi.spyOn(fold, 'offsetTop', 'get').mockReturnValue(400)
    vi.spyOn(fold, 'clientTop', 'get').mockReturnValue(2)
    Object.defineProperty(container, 'offsetParent', { configurable: true, value: fold })
    vi.spyOn(container, 'offsetTop', 'get').mockReturnValue(40)
    scroll.scrollTop = 322
    fireEvent.scroll(scroll)
    flushViewport()
    expect(view.getAllByTestId('nested-row').map(node => node.textContent)).toEqual(KEYS.slice(0, 8))
  })

  it('mounts rows when a preceding section shrinks and scrolls this one into view', () => {
    // POD-6052: collapsing the Pinned fold animates its height to zero after
    // the last React commit. Nothing scrolls and no window resizes, so only
    // the shrinking section itself can report that this window moved up.
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver)
    const view = render(<SectionedWindowHarness />)
    const scroll = view.getByTestId('sectioned-scroll')
    const preceding = view.getByTestId('preceding-section')
    const container = view.getByTestId('sectioned-container')
    sizeViewport(scroll, 320)
    let precedingHeight = 2_000
    Object.defineProperty(container, 'offsetParent', { configurable: true, value: scroll })
    vi.spyOn(container, 'offsetTop', 'get').mockImplementation(() => precedingHeight)
    RecordingResizeObserver.resize(scroll)
    flushViewport()
    expect(view.queryAllByTestId('sectioned-row')).toEqual([])
    precedingHeight = 0
    RecordingResizeObserver.resize(preceding)
    flushViewport()
    const rows = view.getAllByTestId('sectioned-row').map((node) => node.textContent)
    expect(rows.slice(0, 8)).toEqual(KEYS.slice(0, 8))
  })

  it('follows a section inserted above the window after it mounted', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver)
    const view = render(<SectionedWindowHarness />)
    const scroll = view.getByTestId('sectioned-scroll')
    const container = view.getByTestId('sectioned-container')
    sizeViewport(scroll, 320)
    let precedingHeight = 2_000
    Object.defineProperty(container, 'offsetParent', { configurable: true, value: scroll })
    vi.spyOn(container, 'offsetTop', 'get').mockImplementation(() => precedingHeight)
    RecordingResizeObserver.resize(scroll)
    flushViewport()
    view.rerender(<SectionedWindowHarness late />)
    // Mutation records arrive as a microtask after the commit.
    await act(async () => {})
    flushViewport()
    expect(view.queryAllByTestId('sectioned-row')).toEqual([])
    precedingHeight = 0
    RecordingResizeObserver.resize(view.getByTestId('late-section'))
    flushViewport()
    expect(view.getAllByTestId('sectioned-row')[0]?.textContent).toBe(KEYS[0])
  })
})
