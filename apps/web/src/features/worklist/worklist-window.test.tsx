// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISSUE_VIRTUAL_MAX_ITEMS } from '@/features/issues/use-bounded-virtual-list'
import { WorklistWindow } from './worklist-window'

const keys = Array.from({ length: 674 }, (_, index) => `row-${index}`)
const rowKey = (key: string) => key
const renderRow = (key: string) => <button>{key}</button>
function Harness({ rows = keys, selectedKey = null, draggingKey = null }: {
  rows?: string[]; selectedKey?: string | null; draggingKey?: string | null
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  return <div ref={scrollRef} data-testid="window-scroll">
    <WorklistWindow rows={rows} rowKey={rowKey} renderRow={renderRow} scrollRef={scrollRef}
      selectedKey={selectedKey} draggingKey={draggingKey} estimateSize={40} />
  </div>
}
const flush = () => act(() => vi.runOnlyPendingTimers())
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroll = document.querySelector<HTMLElement>('[data-testid="window-scroll"]')
    const top = this.dataset.testid === 'window-scroll' ? 0 : -(scroll?.scrollTop ?? 0)
    return { top, bottom: top + 40, height: this.dataset.windowRow ? 40 : 320 } as DOMRect
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const mounted = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-window-row]')].map((node) => node.dataset.windowRow!)

describe('worklist viewport', () => {
  it.each([1, 4])('keeps ordered DOM bounded before and after deep scrolling at %sx', scale => {
    const rows = Array.from({ length: 674 * scale }, (_, index) => `row-${index}`)
    const view = render(<Harness rows={rows} />)
    flush()
    expect(mounted(view.container)).toEqual(rows.slice(0, mounted(view.container).length))
    expect(mounted(view.container).length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
    const scroll = view.getByTestId('window-scroll')
    scroll.scrollTop = (rows.length - 10) * 40
    fireEvent.scroll(scroll); flush()
    const visible = mounted(view.container)
    expect(visible).toEqual(rows.slice(rows.indexOf(visible[0]!)))
    expect(visible.at(-1)).toBe(rows.at(-1))
    expect(visible.length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS)
  })

  it('reveals an external selection once, then allows independent scrolling', () => {
    const view = render(<Harness />); flush()
    const scroll = view.getByTestId('window-scroll')
    view.rerender(<Harness selectedKey="row-600" />); flush(); flush()
    expect(scroll.scrollTop).toBeGreaterThan(20_000)
    expect(view.getByText('row-600')).toBeTruthy()
    scroll.scrollTop = 0; fireEvent.scroll(scroll); flush()
    expect(scroll.scrollTop).toBe(0)
    expect(mounted(view.container)).not.toContain('row-600')
  })

  it('retains a drag source without pulling a distant viewport back to it', () => {
    const view = render(<Harness draggingKey="row-0" />); flush()
    const scroll = view.getByTestId('window-scroll')
    scroll.scrollTop = 20_000; fireEvent.scroll(scroll); flush()
    expect(view.getByText('row-0')).toBeTruthy()
    expect(scroll.scrollTop).toBe(20_000)
    expect(mounted(view.container).length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS + 1)
  })

  it('traverses every row with the keyboard across window boundaries', () => {
    const view = render(<Harness />); flush()
    act(() => view.getByText('row-0').focus())
    for (let index = 1; index < keys.length; index++) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); flush()
      expect(document.activeElement?.textContent).toBe(`row-${index}`)
      expect(mounted(view.container).length).toBeLessThanOrEqual(ISSUE_VIRTUAL_MAX_ITEMS + 1)
    }
    fireEvent.keyDown(document.activeElement!, { key: 'Home' }); flush()
    expect(document.activeElement?.textContent).toBe('row-0')
    fireEvent.keyDown(document.activeElement!, { key: 'End' }); flush()
    expect(document.activeElement?.textContent).toBe('row-673')
  })

  it('tabs to the next unmounted row instead of skipping the remainder', () => {
    const view = render(<Harness />); flush()
    const last = mounted(view.container).at(-1)!
    const next = keys[keys.indexOf(last) + 1]!
    act(() => view.getByText(last).focus())
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); flush()
    expect(document.activeElement?.textContent).toBe(next)
  })

  it('keeps the visible anchor when rows above are inserted or removed', () => {
    const view = render(<Harness />); flush()
    const scroll = view.getByTestId('window-scroll')
    scroll.scrollTop = 800; fireEvent.scroll(scroll); flush()
    view.rerender(<Harness rows={['inserted', ...keys]} />); flush()
    expect(scroll.scrollTop).toBe(840)
    view.rerender(<Harness rows={keys} />); flush()
    expect(scroll.scrollTop).toBe(800)
  })
})
