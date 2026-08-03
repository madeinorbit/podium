import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { LoginPasswordSection } from './security'

/**
 * `enabled` used to be one boolean for the whole instance. It is now three answers: does
 * the CALLER have a password, does the INSTANCE require login, and may this caller change
 * that. The default here is an admin, because the disable flow is admin-only.
 */
function fakeTrpc(enabled: boolean, canManageInstance = true) {
  return {
    auth: {
      status: {
        query: vi.fn().mockResolvedValue({
          hasOwnCredential: enabled,
          loginRequired: enabled,
          canManageInstance,
        }),
      },
      setPassword: { mutate: vi.fn().mockResolvedValue({ loginRequired: true }) },
      setLoginRequired: { mutate: vi.fn().mockResolvedValue({ loginRequired: false }) },
    },
  } as unknown as Trpc
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LoginPasswordSection', () => {
  it('in open mode: sets a password and then logs in to obtain the cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const trpc = fakeTrpc(false)
    render(<LoginPasswordSection trpc={trpc} />)
    const btn = await screen.findByRole('button', { name: /set password/i })
    fireEvent.change(screen.getByPlaceholderText(/^password$/i), { target: { value: 'newpw' } })
    fireEvent.change(screen.getByPlaceholderText(/confirm/i), { target: { value: 'newpw' } })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(trpc.auth.setPassword.mutate).toHaveBeenCalledWith({
        current: undefined,
        next: 'newpw',
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('refuses to save when the new password and confirmation differ', async () => {
    const trpc = fakeTrpc(false)
    render(<LoginPasswordSection trpc={trpc} />)
    const btn = await screen.findByRole('button', { name: /set password/i })
    fireEvent.change(screen.getByPlaceholderText(/^password$/i), { target: { value: 'a' } })
    fireEvent.change(screen.getByPlaceholderText(/confirm/i), { target: { value: 'b' } })
    fireEvent.click(btn)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(trpc.auth.setPassword.mutate).not.toHaveBeenCalled()
  })

  it('in enabled mode: a change sends the current + new password', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const trpc = fakeTrpc(true)
    render(<LoginPasswordSection trpc={trpc} />)
    const changeBtn = await screen.findByRole('button', { name: /change password/i })
    fireEvent.change(screen.getByPlaceholderText(/current password/i), { target: { value: 'old' } })
    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: 'new' } })
    fireEvent.change(screen.getByPlaceholderText(/confirm/i), { target: { value: 'new' } })
    fireEvent.click(changeBtn)
    await waitFor(() =>
      expect(trpc.auth.setPassword.mutate).toHaveBeenCalledWith({ current: 'old', next: 'new' }),
    )
  })

  it('in enabled mode: disable acknowledgement is scoped to the disable flow', async () => {
    const trpc = fakeTrpc(true)
    render(<LoginPasswordSection trpc={trpc} />)
    await screen.findByRole('button', { name: /change password/i })

    expect(screen.queryByText(/I understand that anyone who can reach this server/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /disable login/i }))
    expect(screen.getByText(/I understand that anyone who can reach this server/i)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/current password to disable login/i), {
      target: { value: 'old' },
    })
    const finalDisable = screen.getByRole('button', {
      name: /^disable login$/i,
    }) as HTMLButtonElement
    expect(finalDisable.disabled).toBe(true)
    fireEvent.click(screen.getByText(/I understand that anyone who can reach this server/i))
    expect(finalDisable.disabled).toBe(false)
    fireEvent.click(finalDisable)

    await waitFor(() =>
      expect(trpc.auth.setLoginRequired.mutate).toHaveBeenCalledWith({
        required: false,
        current: 'old',
        acknowledgeNoPassword: true,
      }),
    )
  })
  it('a non-admin can change their own password but cannot disable login', async () => {
    // The split POD-1554 exists for: one user must not be able to turn login off for
    // everybody. The server refuses it too (roleFloor: admin) — this asserts the UI does
    // not offer an action the caller cannot take.
    const trpc = fakeTrpc(true, false)
    render(<LoginPasswordSection trpc={trpc} />)
    expect(await screen.findByRole('button', { name: /change password/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /disable login/i })).toBeNull()
  })
})
