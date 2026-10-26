import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BaseBranchMenuContent, type BaseBranchMenuProps } from './BaseBranchMenu'

afterEach(cleanup)

function Harness(props: Omit<BaseBranchMenuProps, 'onDone'>) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<button type="button">Branch</button>} />
      {open && <BaseBranchMenuContent {...props} onDone={() => setOpen(false)} />}
    </DropdownMenu>
  )
}

it('saves a listed branch, a typed one, or the default, and closes on success', async () => {
  const save = vi.fn(async (_branch: string | null) => {})
  render(
    <Harness
      heading="Base branch"
      current="tf.dev"
      choices={['main', 'tf.dev']}
      fallback={{ label: 'Use Podium default (main)' }}
      onSave={save}
    />,
  )
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    return screen.findByRole('menuitem', { name: 'main' })
  }
  fireEvent.click(await open())
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith('main')

  await open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Use Podium default (main)' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith(null)

  await open()
  fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: ' release ' } })
  expect(screen.queryByRole('menuitem', { name: 'main' })).toBeNull()
  fireEvent.keyDown(screen.getByLabelText('Branch name'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith('release')

  // Picking the current value is a no-op close.
  save.mockClear()
  fireEvent.click(await open().then(() => screen.getByRole('menuitem', { name: /tf\.dev/ })))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).not.toHaveBeenCalled()
})

it("keeps the menu open and shows the setter's refusal under the field", async () => {
  const save = vi.fn(async () => {
    throw new Error("Branch 'nope' does not exist in /repo.")
  })
  render(<Harness heading="Base branch" current={null} choices={[]} onSave={save} />)
  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  const field = await screen.findByLabelText('Branch name')
  fireEvent.change(field, { target: { value: 'nope' } })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Use nope' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    "Branch 'nope' does not exist in /repo.",
  )
  expect(screen.getByRole('menu')).toBeTruthy()
})
