import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../BottomSheet', () => ({
  BottomSheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
import { PromptSheet } from './PromptSheet'
afterEach(cleanup)
it('follows live rename text until edited, then keeps the explicit draft through updates', () => {
  const confirm = vi.fn()
  const props = {
    visible: true,
    title: 'Rename',
    placeholder: 'Task title',
    confirmLabel: 'Save',
    preserveEdits: true,
    onConfirm: confirm,
    onClose: () => {},
  }
  const view = render(<PromptSheet {...props} initialValue="Original" />)
  view.rerender(<PromptSheet {...props} initialValue="Changed elsewhere" />)
  const input = view.getByPlaceholderText('Task title') as HTMLInputElement
  expect(input.value).toBe('Changed elsewhere')
  fireEvent.change(input, { target: { value: 'My draft' } })
  view.rerender(<PromptSheet {...props} initialValue="Another live update" />)
  expect(input.value).toBe('My draft')
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  expect(confirm).toHaveBeenCalledWith('My draft')
  view.rerender(<PromptSheet {...props} visible={false} initialValue="Latest" />)
  view.rerender(<PromptSheet {...props} initialValue="Latest" />)
  expect((view.getByPlaceholderText('Task title') as HTMLInputElement).value).toBe('Latest')
})
