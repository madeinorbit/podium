import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ResizableColumn } from '@/features/worklist/sidebar-common'
import { FLIGHT_DECK_SIZING } from './flight-deck-display'

const values = vi.hoisted(() => new Map<string, string>())
vi.mock('./store', () => ({
  readFixture: (select: (store: unknown) => unknown) =>
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

const column = () => (
  <ResizableColumn {...FLIGHT_DECK_SIZING} handleLabel="Resize Flight Deck">
    <div>Full</div>
  </ResizableColumn>
)

function drag(handle: HTMLElement, from: number, to: number) {
  handle.setPointerCapture = vi.fn()
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: from })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(handle, { pointerId: 1 })
}

it('drags one width from narrow to wide and back, with no mode in between', () => {
  values.set(FLIGHT_DECK_SIZING.storageKey, '900')
  const ui = render(column())
  const handle = ui.getByRole('separator', { name: 'Resize Flight Deck' })
  // What a wide deck could not do before (its floor was 540).
  drag(handle, 900, 400)
  expect(values.get(FLIGHT_DECK_SIZING.storageKey)).toBe('400')
  // What a compact deck could not do before (its ceiling was 620).
  drag(handle, 400, 1000)
  expect(values.get(FLIGHT_DECK_SIZING.storageKey)).toBe('1000')
  ui.unmount()
  const reopened = render(column())
  expect(reopened.getByRole('separator').getAttribute('aria-valuenow')).toBe('1000')
})

it('reaches both ends of the range from the keyboard', () => {
  const ui = render(column())
  fireEvent.keyDown(ui.getByRole('separator'), { key: 'End' })
  expect(values.get(FLIGHT_DECK_SIZING.storageKey)).toBe(String(FLIGHT_DECK_SIZING.max))
  fireEvent.keyDown(ui.getByRole('separator'), { key: 'Home' })
  expect(values.get(FLIGHT_DECK_SIZING.storageKey)).toBe('300')
})
