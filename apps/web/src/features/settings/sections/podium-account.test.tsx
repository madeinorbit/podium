import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountContext } from '@/lib/account-context'
import { SignedInDevicesSection, type MobilePairingApi } from './connected-devices'

const sync = vi.hoisted(() => ({ unsyncedChangeCount: 0 as number | null }))
vi.mock('../readers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../readers')>()),
  useSettingsUnsyncedChangeCount: () => sync.unsyncedChangeCount,
}))
afterEach(() => { cleanup(); sync.unsyncedChangeCount = 0; vi.restoreAllMocks() })

const api = {
  auth: {
    mobileSessions: { query: async () => [{ sessionId: 'a'.repeat(24), userId: 'me', label: 'login', kind: 'browser', deviceId: 'browser', deviceName: 'This browser', platform: 'web', lastSeenAt: null, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', current: true }] },
    revokeMobileSession: { mutate: vi.fn() },
  },
} as unknown as MobilePairingApi
function mount(signOut = vi.fn(async () => {})) {
  const ui = () => <AccountContext.Provider value={{ signOut }}><SignedInDevicesSection api={api} /></AccountContext.Provider>
  return { ...render(ui()), signOut, ui }
}
it('clears this account through the existing account runtime when signing out this device', async () => {
  const { signOut } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledOnce()
  expect(api.auth.revokeMobileSession.mutate).not.toHaveBeenCalled()
})
it('keeps queued work when the inline warning is cancelled', async () => {
  sync.unsyncedChangeCount = 2
  const { signOut } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  expect(screen.getByText('2 changes on this device haven’t synced yet')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signOut).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(signOut).not.toHaveBeenCalled()
})
it('discards queued work only after explicit inline confirmation', async () => {
  sync.unsyncedChangeCount = 1
  const { signOut } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  expect(signOut).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
  await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
})
it('checks the latest queue count after waiting', async () => {
  sync.unsyncedChangeCount = 2
  const { signOut, rerender, ui } = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  sync.unsyncedChangeCount = 0
  rerender(ui())
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalledOnce()
})
it('waits for this account’s count before enabling sign-out', async () => {
  sync.unsyncedChangeCount = null
  const { signOut } = mount()
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Sign out' })
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(signOut).not.toHaveBeenCalled()
})
it('shows a cleanup failure inline and permits another attempt', async () => {
  const signOut = vi.fn().mockRejectedValueOnce(new Error('Cleanup failed')).mockResolvedValue(undefined)
  mount(signOut)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Cleanup failed')
  fireEvent.click(screen.getByRole('button', { name: 'Sign out device' }))
  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2))
})
