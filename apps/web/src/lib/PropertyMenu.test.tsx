import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PropertyMenu } from './PropertyMenu'

afterEach(cleanup)

it('does no option work while closed and keeps filtering, selection and reopening', async () => {
  const labels = vi.fn((value: string) => value)
  const options = ['Alpha', 'Beta'].map((value) => ({
    value,
    get label() {
      return labels(value)
    },
  }))
  const select = vi.fn(),
    changed = vi.fn()
  const props = {
    trigger: <button type="button">Pick</button>,
    options,
    onSelect: select,
    onOpenChange: changed,
  }
  const view = render(<PropertyMenu {...props} />)
  expect(labels).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pick' }))
  await screen.findByRole('menuitem', { name: 'Alpha' })
  expect(changed).toHaveBeenCalledWith(true)
  fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'Beta' } })
  expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }))
  expect(select).toHaveBeenCalledWith('Beta')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(changed).toHaveBeenCalledWith(false)
  labels.mockClear()
  view.rerender(<PropertyMenu {...props} />)
  expect(labels).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Pick' }))
  await screen.findByRole('menuitem', { name: 'Alpha' })
  expect(screen.getByPlaceholderText('Filter…')).toHaveProperty('value', '')
})
