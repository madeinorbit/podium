import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResizableColumn } from '@/features/worklist/sidebar-common'
import { flightDeckSizing } from './flight-deck-display'

const values = vi.hoisted(() => new Map<string, string>())
vi.mock('./store', () => ({
  useRuntimeSelector: (select: (store: unknown) => unknown) =>
    select({
      uiState: {
        get: (key: string) => values.get(key) ?? null,
        set: (key: string, value: string) => values.set(key, value),
      },
    }),
}))
vi.mock('@/lib/use-reduced-motion', () => ({ useReducedMotion: () => true }))
afterEach(() => {
  cleanup()
  values.clear()
})

it('changes Full width stores without remounting its scroll and filter subtree', () => {
  const compact = flightDeckSizing(true, 'compact')
  const expanded = flightDeckSizing(true, 'expanded')
  values.set(compact.storageKey, '320')
  values.set(expanded.storageKey, '920')
  function Content() {
    const [filter, setFilter] = useState('All')
    return (
      <button type="button" onClick={() => setFilter('Needs you')}>
        {filter}
      </button>
    )
  }
  const column = (wide: boolean) => (
    <ResizableColumn {...(wide ? expanded : compact)} handleLabel="Resize Flight Deck">
      <Content />
    </ResizableColumn>
  )
  const ui = render(column(false))
  const control = ui.getByRole('button')
  control.parentElement!.scrollTop = 125
  fireEvent.click(control)
  ui.rerender(column(true))
  expect(ui.getByRole('button', { name: 'Needs you' })).toBe(control)
  expect(control.parentElement!.scrollTop).toBe(125)
  expect(ui.getByRole('separator').getAttribute('aria-valuenow')).toBe('920')
  ui.rerender(column(false))
  expect(ui.getByRole('button')).toBe(control)
  expect(ui.getByRole('separator').getAttribute('aria-valuenow')).toBe('320')
})

it('resizes Full beyond 860, restores it on reopen and keeps Waterfall saved widths intact', () => {
  const full = flightDeckSizing(true, 'expanded')
  const legacy = flightDeckSizing(false, 'expanded')
  values.set(legacy.storageKey, '740')
  const column = () => (
    <ResizableColumn {...full} handleLabel="Resize Flight Deck">
      <div>Full</div>
    </ResizableColumn>
  )
  const ui = render(column())
  const handle = ui.getByRole('separator', { name: 'Resize Flight Deck' })
  const capture = vi.fn()
  handle.setPointerCapture = capture
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 })
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(capture).toHaveBeenCalledWith(1)
  expect(values.get(full.storageKey)).toBe('1000')
  expect(values.get(legacy.storageKey)).toBe('740')
  ui.unmount()
  const reopened = render(column())
  expect(reopened.getByRole('separator').getAttribute('aria-valuenow')).toBe('1000')
  fireEvent.keyDown(reopened.getByRole('separator'), { key: 'End' })
  expect(values.get(full.storageKey)).toBe('1120')
  fireEvent.keyDown(reopened.getByRole('separator'), { key: 'Home' })
  expect(values.get(full.storageKey)).toBe('540')
})
