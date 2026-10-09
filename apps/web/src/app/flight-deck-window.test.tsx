// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useMemo, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import {
  type DeckWindowRow,
  DeckRowPlaceholder,
  DECK_OVERSCAN,
  useFlightDeckWindow,
} from './flight-deck-window'

const height = 560
const windowBudget = Math.ceil(3 * height / 32) + 2 * DECK_OVERSCAN + 1
const observers = new Set<ResizeObserverCallback>()
class Observer {
  constructor(private callback: ResizeObserverCallback) {
    observers.add(callback)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    observers.delete(this.callback)
  }
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.windowScroller ? height : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = this.closest<HTMLElement>('[data-window-scroller]')
    const top = this.dataset.windowContainer ? 80 - (scroll?.scrollTop ?? 0) : 0
    const size = this.classList.contains('deck-chrome') ? 80 : height
    return {
      top,
      bottom: top + size,
      left: 0,
      right: 600,
      width: 600,
      height: size,
      x: 0,
      y: top,
      toJSON() {},
    }
  })
})
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  cleanup()
  observers.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function rows(count: number): DeckWindowRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row:${index}`,
    size: index % 2 ? 46 : 32,
    text: `Unique row ${index}`,
  }))
}
function Fixture({ values, scope = 'mission' }: { values: DeckWindowRow[]; scope?: string }) {
  const scroll = useRef<HTMLDivElement | null>(null),
    list = useRef<HTMLDivElement | null>(null)
  const window = useFlightDeckWindow(values, scroll, list, scope)
  const stable = useMemo(() => values, [values])
  return (
    <div data-window-scroller="true" ref={scroll}>
      <div className="deck-chrome" style={{ height: 80 }} />
      <div data-window-container="true" ref={list}>
        {stable.map((row) =>
          window.contains(row.key) ? (
            <div
              key={row.key}
              ref={window.measure(row.key)}
              data-mounted-row={row.key}
              style={{ height: window.size(row.key) }}
            >
              <button type="button" data-real-key={row.key}>
                <span>{row.text?.slice(0, 7)}</span>
                {row.text?.slice(7)}
              </button>
              <button type="button" data-row-action={row.key}>
                Row action
              </button>
            </div>
          ) : (
            <DeckRowPlaceholder key={row.key} row={row} window={window} />
          ),
        )}
      </div>
    </div>
  )
}
async function scrollTo(container: HTMLElement, top: number) {
  const scroll = container.querySelector<HTMLElement>('[data-window-scroller]')!
  act(() => {
    scroll.scrollTop = top
    fireEvent.scroll(scroll)
  })
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  return scroll
}
function mounted(container: HTMLElement) {
  return container.querySelectorAll('[data-mounted-row]')
}
function selectText(node: Node, start: number, end: number) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('mission row window', () => {
  it('retains the rows a fast wheel burst can expose in either direction', async () => {
    const current = render(<Fixture values={rows(406)} />)
    await scrollTo(current.container, 2000)
    // Visible geometry is 2000..2480. Also keep the preceding and following
    // viewport ready, independently of the alternating 32/46px row heights.
    expect(current.container.querySelector('[data-mounted-row="row:40"]')).not.toBeNull()
    expect(current.container.querySelector('[data-mounted-row="row:72"]')).not.toBeNull()
    expect(mounted(current.container).length).toBeLessThanOrEqual(windowBudget)
  })

  it('attaches native Find when a cold placeholder gains searchable text', () => {
    let loaded = false
    const row = { key: 'cold', size: 32, get text() { if (!loaded) throw LOADING; return 'Arrived task' } }
    const window = { enabled: true, contains: () => false, size: () => 32, text: () => undefined,
      measure: () => () => {}, reveal: vi.fn(), beginFind: vi.fn() }
    const current = render(<DeckRowPlaceholder row={row} window={window} />)
    expect(current.container.querySelector('[hidden]')).toBeNull()
    loaded = true
    current.rerender(<DeckRowPlaceholder row={{ ...row }} window={window} />)
    const proxy = current.container.querySelector('[hidden="until-found"]')!
    expect(proxy.textContent).toBe('Arrived task')
    fireEvent(proxy, new Event('beforematch', { bubbles: true }))
    expect(window.beginFind).toHaveBeenCalledWith('cold')
  })

  for (const scale of [1, 4])
    it(`bounds mounted rows at ${scale}x while traversing the whole list`, async () => {
      const values = rows(406 * scale),
        current = render(<Fixture values={values} />)
      // Same viewport budget for the audit's 1x and a roster four times larger.
      const budget = windowBudget
      for (const top of [0, 2500, 9000, values.length * 39 - height]) {
        await scrollTo(current.container, top)
        expect(mounted(current.container).length).toBeGreaterThan(0)
        expect(mounted(current.container).length).toBeLessThanOrEqual(budget)
        expect(mounted(current.container).length).toBeLessThan(values.length / 4)
      }
    })

  it('mounts and focuses an off-window row through its Tab sentinel', async () => {
    const current = render(<Fixture values={rows(406)} />)
    expect(current.container.querySelector('[data-mounted-row="row:350"]')).toBeNull()
    const sentinel = current.container.querySelector<HTMLElement>(
      '[data-deck-placeholder="row:350"] button',
    )!
    act(() => sentinel.focus())
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-real-key')).toBe('row:350'),
    )
    expect(mounted(current.container).length).toBeLessThanOrEqual(windowBudget)
  })

  it('keeps the focused row mounted during pointer scrolling', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const button = current.container.querySelector<HTMLElement>('[data-real-key="row:1"]')!
    act(() => button.focus())
    await scrollTo(current.container, 6000)
    expect(document.activeElement).toBe(button)
    expect(current.container.querySelector('[data-mounted-row="row:1"]')).not.toBeNull()
    expect(mounted(current.container).length).toBeLessThanOrEqual(windowBudget + 1)
  })

  it('restores the last Tab stop when entering an offscreen row in reverse order', async () => {
    const current = render(<Fixture values={rows(406)} />)
    act(() =>
      current.container
        .querySelector<HTMLElement>('[data-deck-placeholder="row:350"] button')!
        .focus(),
    )
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-real-key')).toBe('row:350'),
    )
    act(() =>
      current.container
        .querySelector<HTMLElement>('[data-deck-placeholder="row:1"] button')!
        .focus(),
    )
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-row-action')).toBe('row:1'),
    )
  })

  it('keeps the native Find text node alive until the browser commits selection', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const proxy = current.container.querySelector(
      '[data-deck-placeholder="row:350"] [hidden="until-found"]',
    )!
    expect(proxy.textContent).toBe('Unique row 350')
    act(() => {
      fireEvent(proxy, new Event('beforematch', { bubbles: true }))
    })
    await scrollTo(current.container, 350 * 39 - height / 2)
    expect(proxy.isConnected).toBe(true)
    expect(current.container.querySelector('[data-mounted-row="row:350"]')).toBeNull()
    act(() => {
      selectText(proxy.firstChild!, 0, 'Unique row 350'.length)
      fireEvent(document, new Event('selectionchange'))
    })
    await waitFor(() =>
      expect(current.container.querySelector('[data-mounted-row="row:350"]')).not.toBeNull(),
    )
    expect(document.getSelection()?.toString()).toBe('Unique row 350')
    expect(mounted(current.container).length).toBeLessThanOrEqual(windowBudget)
  })

  it('transfers the native find range when its scroll mounts the matching row', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const proxy = current.container.querySelector(
      '[data-deck-placeholder="row:350"] [hidden="until-found"]',
    )!
    act(() => selectText(proxy.firstChild!, 0, 'Unique row 350'.length))
    await scrollTo(current.container, 350 * 39 - height / 2)
    expect(document.getSelection()?.toString()).toBe('Unique row 350')
    expect(
      document
        .getSelection()
        ?.anchorNode?.parentElement?.closest('[data-mounted-row]')
        ?.getAttribute('data-mounted-row'),
    ).toBe('row:350')
    expect(current.container.querySelector('[data-deck-placeholder="row:350"]')).toBeNull()
  })

  it('releases a held Find match when selection commits to another visible row', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const proxy = current.container.querySelector(
      '[data-deck-placeholder="row:350"] [hidden="until-found"]',
    )!
    act(() => fireEvent(proxy, new Event('beforematch', { bubbles: true })))
    await scrollTo(current.container, 350 * 39 - height / 2)
    const other = current.container.querySelector('[data-real-key="row:349"] span')!
    act(() => {
      selectText(other.firstChild!, 0, 'Unique'.length)
      fireEvent(document, new Event('selectionchange'))
    })
    expect(current.container.querySelector('[data-mounted-row="row:350"]')).not.toBeNull()
    expect(document.getSelection()?.toString()).toBe('Unique')
  })

  it('does not mistake the previous selection for the new native Find result', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const prior = current.container.querySelector('[data-real-key="row:1"] span')!
    act(() => selectText(prior.firstChild!, 0, 'Unique'.length))
    const proxy = current.container.querySelector(
      '[data-deck-placeholder="row:350"] [hidden="until-found"]',
    )!
    act(() => fireEvent(proxy, new Event('beforematch', { bubbles: true })))
    await scrollTo(current.container, 350 * 39 - height / 2)
    expect(proxy.isConnected).toBe(true)
    expect(current.container.querySelector('[data-mounted-row="row:350"]')).toBeNull()
    act(() => {
      selectText(proxy.firstChild!, 0, 'Unique row 350'.length)
      fireEvent(document, new Event('selectionchange'))
    })
    expect(current.container.querySelector('[data-mounted-row="row:350"]')).not.toBeNull()
    expect(document.getSelection()?.toString()).toBe('Unique row 350')
  })

  it('hands off native Find when keyboard focus enters the held match', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const proxy = current.container.querySelector(
      '[data-deck-placeholder="row:350"] [hidden="until-found"]',
    )!
    act(() => {
      fireEvent(proxy, new Event('beforematch', { bubbles: true }))
      selectText(proxy.firstChild!, 0, 'Unique row 350'.length)
      current.container
        .querySelector<HTMLElement>('[data-deck-placeholder="row:350"] button')!
        .focus()
    })
    await waitFor(() =>
      expect(current.container.querySelector('[data-mounted-row="row:350"]')).not.toBeNull(),
    )
    expect(document.getSelection()?.toString()).toBe('Unique row 350')
    expect(document.getSelection()?.anchorNode?.isConnected).toBe(true)
  })

  it('keeps a selected match mounted when pointer scrolling leaves it behind', async () => {
    const current = render(<Fixture values={rows(406)} />)
    const match = current.container.querySelector('[data-real-key="row:1"] span')!
    act(() => selectText(match.firstChild!, 0, 'Unique'.length))
    await scrollTo(current.container, 6000)
    expect(document.getSelection()?.toString()).toBe('Unique')
    expect(current.container.querySelector('[data-mounted-row="row:1"]')).not.toBeNull()
    expect(mounted(current.container).length).toBeLessThanOrEqual(windowBudget + 1)
  })

  it('retains the same row and pixel when rows above it are removed', async () => {
    const values = rows(406),
      current = render(<Fixture values={values} />)
    const scroll = await scrollTo(current.container, 3900)
    const before = scroll.scrollTop
    current.rerender(<Fixture values={values.slice(10)} />)
    expect(scroll.scrollTop).toBe(before - 390)
  })

  it('compensates measured height changes above the viewport', async () => {
    const values = rows(406),
      current = render(<Fixture values={values} />)
    const scroll = await scrollTo(current.container, 3900)
    const above = current.container.querySelector<HTMLElement>('[data-mounted-row="row:97"]')!
    expect(above).not.toBeNull()
    const before = scroll.scrollTop
    act(() => {
      for (const callback of observers)
        callback(
          [
            { target: above, borderBoxSize: [{ blockSize: 78 }] },
          ] as unknown as ResizeObserverEntry[],
          {} as ResizeObserver,
        )
    })
    expect(scroll.scrollTop).toBe(before + 32)
  })

  it('disconnects measurements and pending frames on unmount', async () => {
    const current = render(<Fixture values={rows(406)} />)
    await scrollTo(current.container, 5000)
    current.unmount()
    expect(observers.size).toBe(0)
  })
})
