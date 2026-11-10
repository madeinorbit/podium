import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountContext } from '@/lib/account-context'
import { PodiumAccountSection } from './podium-account'

const sync = vi.hoisted(() => ({ unsyncedChangeCount: 0 as number | null }))
vi.mock('../readers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../readers')>()),
  useSettingsUnsyncedChangeCount: () => sync.unsyncedChangeCount,
}))

afterEach(() => {
  cleanup()
  sync.unsyncedChangeCount = 0
})

function mount(signOut = vi.fn(async () => {})) {
  const ui = (
    <AccountContext.Provider value={{ signOut }}>
      <PodiumAccountSection />
    </AccountContext.Provider>
  )
  return { ...render(ui), signOut, ui }
}

it('signs out immediately when this device has no unsynced changes', () => {
  const { signOut } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('keeps the account and its queued work when the person chooses to wait', async () => {
  sync.unsyncedChangeCount = 2
  const { signOut } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).not.toHaveBeenCalled()
  expect(await screen.findByRole('alertdialog')).toBeTruthy()
  expect(
    screen.getByText("2 changes on this device haven't synced yet and will be lost."),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Wait' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(signOut).not.toHaveBeenCalled()
})

it('discards queued work only after explicit confirmation', async () => {
  sync.unsyncedChangeCount = 1
  const { signOut } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).not.toHaveBeenCalled()
  expect(
    await screen.findByText("1 change on this device hasn't synced yet and will be lost."),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
  expect(signOut).toHaveBeenCalledOnce()
})

it('checks the latest queue count on each attempt after waiting', async () => {
  sync.unsyncedChangeCount = 2
  const { signOut, rerender } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Wait' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  sync.unsyncedChangeCount = 0
  rerender(
    <AccountContext.Provider value={{ signOut }}>
      <PodiumAccountSection />
    </AccountContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledOnce()
})

it('waits for this account’s count before enabling sign-out', () => {
  sync.unsyncedChangeCount = null
  const { signOut } = mount()
  const button = screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(signOut).not.toHaveBeenCalled()
})

it('shows a sign-out failure and allows another attempt', async () => {
  const signOut = vi
    .fn()
    .mockRejectedValueOnce(new Error('Cleanup failed'))
    .mockResolvedValue(undefined)
  mount(signOut)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cleanup failed')
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledTimes(2)
})
