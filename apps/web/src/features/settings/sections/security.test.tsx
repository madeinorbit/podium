import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { AccountProfileSection } from './security'

const frame = vi.hoisted(() => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }))
vi.mock('../settings-frame', () => ({ useSettingsFrame: () => frame }))

function fakeTrpc(hasOwnCredential = true) {
  let profile = {
    id: 'me',
    displayName: 'Alice',
    email: 'alice@example.com',
    role: 'member' as const,
  }
  return {
    auth: {
      profile: { query: vi.fn(async () => profile) },
      setDisplayName: {
        mutate: vi.fn(async ({ displayName }: { displayName: string }) => {
          profile = { ...profile, displayName }
          return { displayName }
        }),
      },
      setEmail: {
        mutate: vi.fn(async ({ email }: { email: string }) => {
          profile = { ...profile, email }
          return { email }
        }),
      },
      status: {
        query: vi.fn().mockResolvedValue({
          hasOwnCredential,
          loginRequired: true,
          canManageInstance: false,
          loginPolicySource: 'default',
        }),
      },
      setPassword: { mutate: vi.fn().mockResolvedValue({ loginRequired: true }) },
    },
  } as unknown as Trpc
}
async function openPassword(trpc: Trpc) {
  render(<AccountProfileSection trpc={trpc} />)
  fireEvent.click(await screen.findByRole('button', { name: /^(change|set) password$/i }))
  const flow = frame.openTakeover.mock.calls.at(-1)?.[0]
  expect(flow).toBeTruthy()
  return render(flow.content)
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  frame.openTakeover.mockClear()
  frame.closeTakeover.mockClear()
})

describe('Account Profile', () => {
  it('commits the name on Enter and shows the role read-only', async () => {
    const trpc = fakeTrpc()
    render(<AccountProfileSection trpc={trpc} />)
    const name = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'New name' } })
    expect(trpc.auth.setDisplayName.mutate).not.toHaveBeenCalled()
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() =>
      expect(trpc.auth.setDisplayName.mutate).toHaveBeenCalledWith({ displayName: 'New name' }),
    )
    expect(screen.getByText('Member')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull()
  })
  it('asks for a password only when a changed email is submitted', async () => {
    const trpc = fakeTrpc()
    render(<AccountProfileSection trpc={trpc} />)
    const email = await screen.findByRole('textbox', { name: 'Email' })
    expect(screen.queryByLabelText('Your password')).toBeNull()
    fireEvent.submit(email.closest('form')!)
    expect(screen.queryByLabelText('Your password')).toBeNull()
    expect(trpc.auth.setEmail.mutate).not.toHaveBeenCalled()
    fireEvent.change(email, { target: { value: 'next@example.com' } })
    expect(screen.queryByLabelText('Your password')).toBeNull()
    fireEvent.submit(email.closest('form')!)
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save email' }))
    await waitFor(() =>
      expect(trpc.auth.setEmail.mutate).toHaveBeenCalledWith({
        email: 'next@example.com',
        current: 'secret',
      }),
    )
  })
  it('saves an email without a password when the caller has none', async () => {
    const trpc = fakeTrpc(false)
    render(<AccountProfileSection trpc={trpc} />)
    const email = await screen.findByRole('textbox', { name: 'Email' })
    fireEvent.change(email, { target: { value: 'next@example.com' } })
    fireEvent.submit(email.closest('form')!)
    await waitFor(() =>
      expect(trpc.auth.setEmail.mutate).toHaveBeenCalledWith({
        email: 'next@example.com',
        current: undefined,
      }),
    )
  })
  it('keeps a refused email and its error on the email row', async () => {
    const trpc = fakeTrpc(false)
    vi.mocked(trpc.auth.setEmail.mutate).mockRejectedValue(
      new Error('Email is already used in this workspace.'),
    )
    render(<AccountProfileSection trpc={trpc} />)
    const email = await screen.findByRole('textbox', { name: 'Email' })
    fireEvent.change(email, { target: { value: 'next@example.com' } })
    fireEvent.submit(email.closest('form')!)
    const error = await screen.findByRole('alert')
    expect(error.closest('.settings-row')).toBe(email.closest('.settings-row'))
    expect((email as HTMLInputElement).value).toBe('next@example.com')
  })
  it('settles auth-status failure and retries instead of loading forever', async () => {
    const trpc = fakeTrpc()
    vi.mocked(trpc.auth.status.query).mockRejectedValueOnce(new Error('offline'))
    render(<AccountProfileSection trpc={trpc} />)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Couldn’t load your profile and sign-in settings.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeTruthy()
  })
})

describe('Account password takeover', () => {
  it('sends the current and new password and checks the cookie refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const trpc = fakeTrpc()
    await openPassword(trpc)
    fireEvent.change(screen.getByLabelText('Current password', { selector: 'input' }), { target: { value: 'old' } })
    fireEvent.change(screen.getByLabelText('New password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('Confirm new password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.submit(screen.getByLabelText('New password', { selector: 'input' }).closest('form')!)
    await waitFor(() =>
      expect(trpc.auth.setPassword.mutate).toHaveBeenCalledWith({ current: 'old', next: 'new' }),
    )
    await waitFor(() => expect(frame.closeTakeover).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login'),
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({ email: 'alice@example.com', password: 'new' }),
      }),
    )
  })
  it('refuses a mismatched confirmation before writing a credential', async () => {
    const trpc = fakeTrpc(false)
    await openPassword(trpc)
    fireEvent.change(screen.getByLabelText('New password', { selector: 'input' }), { target: { value: 'one' } })
    fireEvent.change(screen.getByLabelText('Confirm new password', { selector: 'input' }), { target: { value: 'two' } })
    fireEvent.submit(screen.getByLabelText('New password', { selector: 'input' }).closest('form')!)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Passwords don’t match.')
    expect(trpc.auth.setPassword.mutate).not.toHaveBeenCalled()
  })
  it('retries a failed cookie refresh without changing the password twice', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const trpc = fakeTrpc(false)
    await openPassword(trpc)
    fireEvent.change(screen.getByLabelText('New password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('Confirm new password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.submit(screen.getByLabelText('New password', { selector: 'input' }).closest('form')!)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Your password changed'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(frame.closeTakeover).toHaveBeenCalledOnce())
    expect(trpc.auth.setPassword.mutate).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('finishes an open-mode password change without calling the disabled login endpoint', async () => {
    const trpc = fakeTrpc(false)
    vi.mocked(trpc.auth.setPassword.mutate).mockResolvedValue({ loginRequired: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await openPassword(trpc)
    fireEvent.change(screen.getByLabelText('New password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('Confirm new password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.submit(screen.getByLabelText('New password', { selector: 'input' }).closest('form')!)
    await waitFor(() => expect(frame.closeTakeover).toHaveBeenCalledOnce())
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not close a newer takeover when a password save finishes after leaving', async () => {
    const trpc = fakeTrpc(false)
    let finish: ((answer: { loginRequired: boolean }) => void) | undefined
    vi.mocked(trpc.auth.setPassword.mutate).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const flow = await openPassword(trpc)
    fireEvent.change(screen.getByLabelText('New password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('Confirm new password', { selector: 'input' }), { target: { value: 'new' } })
    fireEvent.submit(screen.getByLabelText('New password', { selector: 'input' }).closest('form')!)
    flow.unmount()
    finish?.({ loginRequired: false })
    await waitFor(() => expect(trpc.auth.status.query).toHaveBeenCalledTimes(2))
    expect(frame.closeTakeover).not.toHaveBeenCalled()
  })
})
