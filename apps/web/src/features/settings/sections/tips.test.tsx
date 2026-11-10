import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { action, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { ShowTipsRow } from './tips'

const notice = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: notice }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))
afterEach(() => {
  cleanup()
  notice.mockClear()
})

it('disables while loading and delegates local changes and Undo to the account log', () => {
  const seen = new Set(['first-prompt'])
  const record = vi.fn()
  const log = observable({
    ready: false,
    enabled: true,
    isSeen: (id: string) => seen.has(id),
    record,
    setEnabled: action((on: boolean) => {
      const previous = log.enabled
      log.enabled = on
      return action(() => {
        log.enabled = previous
      })
    }),
  })
  const view = render(<ShowTipsRow log={log} />)
  const toggle = view.getByRole('switch', { name: 'Show tips' })
  expect(toggle.hasAttribute('data-disabled')).toBe(true)
  act(() =>
    runInAction(() => {
      log.ready = true
    }),
  )
  fireEvent.click(toggle)
  expect(log.enabled).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(log.enabled).toBe(true)
  act(() => notice.mock.lastCall?.[1].action.onClick())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(log.isSeen('first-prompt')).toBe(true)
  expect(record).not.toHaveBeenCalled()
})
