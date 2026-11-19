import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DECK_LOAD_LIMIT_MS, SettlingDeck } from './FlightDeck'

const reload = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/force-reload', () => ({ forceReload: reload }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  reload.mockClear()
})

it('replaces a stuck deck skeleton with an error and a draft-preserving retry', async () => {
  vi.useFakeTimers()
  render(<SettlingDeck />)
  expect(screen.getByTestId('flight-settling')).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DECK_LOAD_LIMIT_MS)
  })
  expect(screen.queryByTestId('flight-settling')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('could not finish loading')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(reload).toHaveBeenCalledExactlyOnceWith('deck-load-timeout')
})
