import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptViewport } from './TranscriptViewport'

let viewportHeight = 400
let heights = new Map<string, number>()
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
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function content(
  data = keys,
  options: { loadingOlder?: boolean; onFollowChange?: (following: boolean) => void } = {},
): ReactElement {
  return (
    <TranscriptViewport
      identity="one"
      data={data}
      keyExtractor={(key) => key}
      renderItem={({ item }) => <span>{item}</span>}
      ListFooterComponent={<span>Working</span>}
      moreAbove
      loadingOlder={options.loadingOlder}
      onFollowChange={options.onFollowChange}
    />
  )
}
function read(scroller: HTMLElement, top: number): void {
  fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop })
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

describe('phone web viewport', () => {
  it('retains the latest reader position through loading and actual prepend commits', () => {
    const mode = vi.fn()
    const { getByTestId, container, rerender } = render(content(keys, { onFollowChange: mode }))
    const scroller = getByTestId('transcript-scroller')
    expect(scroller.scrollTop).toBe(840)
    act(() => read(scroller, 80))
    rerender(content(keys, { loadingOlder: true, onFollowChange: mode }))
    act(() => read(scroller, 320))
    const row = container.querySelector('[data-row-key="row-3"]')!
    rerender(content(['older-one', 'older-two', ...keys], { onFollowChange: mode }))
    expect(scroller.scrollTop).toBe(520)
    expect(row.getBoundingClientRect().top).toBe(-20)
    expect(container.querySelector('[data-row-key="row-3"]')).toBe(row)
    expect(mode).toHaveBeenLastCalledWith(false)
  })
  it('does not trim or replace a loaded message when live rows arrive', () => {
    const { container, getByTestId, rerender } = render(content())
    const scroller = getByTestId('transcript-scroller')
    act(() => read(scroller, 320))
    const row = container.querySelector('[data-row-key="row-3"]')!
    rerender(content([...keys, ...Array.from({ length: 400 }, (_, index) => `new-${index}`)]))
    expect(scroller.scrollTop).toBe(320)
    expect(container.querySelector('[data-row-key="row-3"]')).toBe(row)
    expect(container.querySelectorAll('[data-block]')).toHaveLength(413)
  })
})
