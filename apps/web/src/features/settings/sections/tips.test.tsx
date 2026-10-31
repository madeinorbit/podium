import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { action, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { ShowTipsRow } from './tips'

vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))
afterEach(cleanup)

it('disables while loading and follows local and remote switch changes without resetting progress', () => {
  const seen = new Set(['first-prompt'])
  const record = vi.fn()
  const log = observable({
    ready: false,
    enabled: true,
    isSeen: (id: string) => seen.has(id),
    record,
    setEnabled: action((on: boolean) => {
      log.enabled = on
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
  act(() =>
    runInAction(() => {
      log.enabled = false
    }),
  )
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(log.isSeen('first-prompt')).toBe(true)
  expect(record).not.toHaveBeenCalled()
})
