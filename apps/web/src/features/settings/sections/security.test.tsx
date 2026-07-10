import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { LoginPasswordSection } from './security'

function fakeTrpc(enabled: boolean) {
  return {
    auth: {
      status: { query: vi.fn().mockResolvedValue({ enabled }) },
      setPassword: { mutate: vi.fn().mockResolvedValue({ enabled: true }) },
      clearPassword: { mutate: vi.fn().mockResolvedValue({ enabled: false }) },
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
      expect(trpc.auth.clearPassword.mutate).toHaveBeenCalledWith({
        current: 'old',
        acknowledgeNoPassword: true,
      }),
    )
  })
})
