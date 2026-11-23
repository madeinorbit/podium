import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '@/test-support/auth-capabilities'
import { InviteView } from './InviteView'
import { LoginGate } from './LoginGate'

function serveMemberApi(fetcher: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url.endsWith('/auth/status')
      ? Promise.resolve(
          Response.json({
            needsAuth: true,
            authed: false,
            capabilities: passwordCapabilities,
            prompt: 'email-password',
          }),
        )
      : fetcher(url, init),
  )
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})
test('accepts an invite before the login gate and submits its bound email and password', async () => {
  window.history.replaceState(null, '', '/#invite=secret')
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'anna@example.com' }) })
    .mockResolvedValue({ ok: true, json: async () => ({ userId: 'mem_anna' }) })
  serveMemberApi(fetchMock)
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  expect(await screen.findByLabelText('Email')).toHaveProperty('readOnly', true)
  expect(screen.queryByText('Workspace')).toBeNull()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anna' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }))
  expect(await screen.findByText('You’re a member')).toBeTruthy()
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
    token: 'secret',
    email: 'anna@example.com',
    password: 'password123',
    displayName: 'Anna',
  })
  expect(fetchMock.mock.calls[1]![1].credentials).toBe('include')
  expect(fetchMock.mock.calls[0]![0]).toMatch(/\/inspect$/)
})
test('invalid invites cannot submit; password confirmation catches mistakes', async () => {
  serveMemberApi(vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Expired' }) }))
  const onDone = vi.fn()
  const result = render(<InviteView token="bad" httpOrigin="" onDone={onDone} />)
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'This invite has expired, was revoked, or has already been used.',
  )
  expect(screen.queryByRole('button', { name: 'Join workspace' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }))
  expect(onDone).toHaveBeenCalledOnce()
  result.unmount()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: null }) })
  serveMemberApi(fetchMock)
  render(<InviteView token="valid" httpOrigin="" onDone={vi.fn()} />)
  await screen.findByLabelText('Name')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anna' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anna@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different' } })
  fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('match'))
  expect(fetchMock).toHaveBeenCalledOnce()
})

test('a password reset link asks for a new password without creating a member profile', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () =>
      url.endsWith('/inspect') ? { kind: 'password-reset', email: null } : { ok: true },
  }))
  serveMemberApi(fetchMock)
  render(<InviteView token="reset" httpOrigin="" onDone={vi.fn()} />)
  expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeTruthy()
  await screen.findByLabelText('Password')
  expect(screen.queryByLabelText('Name')).toBeNull()
  expect(screen.queryByLabelText('Email')).toBeNull()
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-password123' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'new-password123' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }))
  expect(await screen.findByText('Password updated')).toBeTruthy()
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
    token: 'reset',
    password: 'new-password123',
  })
})

test('an invitation arriving in an already open signed-in app takes priority', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/inspect')
          ? { kind: 'invitation', email: 'bob@example.com' }
          : {
              needsAuth: true,
              authed: true,
              userId: 'alice',
              memberId: 'alice',
              syncBoundaryId: 'server',
              capabilities: passwordCapabilities,
              prompt: 'email-password',
            },
    })),
  )
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  await screen.findByText('Workspace')
  window.history.pushState(null, '', '/#invite=secret')
  fireEvent(window, new HashChangeEvent('hashchange'))
  expect(await screen.findByRole('heading', { name: 'Join this workspace' })).toBeTruthy()
  expect(await screen.findByLabelText('Email')).toHaveProperty('value', 'bob@example.com')
  expect(screen.queryByText('Workspace')).toBeNull()
})

test('an account-managed invitation keeps the token in the account page fragment, not its request URL', async () => {
  window.history.replaceState(null, '', '/workspace-invitation?workspace=ws_team#invite=secret')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith('/status')
          ? {
              needsAuth: true,
              authed: false,
              capabilities: accountCapabilities,
              prompt: 'email-password',
            }
          : { kind: 'invitation', email: 'bob@example.com' },
      ),
    ),
  )
  render(<InviteView token="secret" httpOrigin="" onDone={vi.fn()} />)
  const link = await screen.findByRole('link', { name: 'Continue to accept invitation' })
  const href = new URL(link.getAttribute('href')!)
  expect(href.search).not.toContain('secret')
  expect(new URLSearchParams(href.hash.slice(1)).get('returnTo')).toBe(
    '/workspace-invitation?workspace=ws_team#invite=secret',
  )
})

test('an account-managed invitation offers account acceptance without a server-local password form', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith('/status')
          ? {
              needsAuth: true,
              authed: false,
              capabilities: accountCapabilities,
              prompt: 'email-password',
            }
          : { kind: 'invitation', email: 'bob@example.com' },
      ),
    ),
  )
  render(<InviteView token="account-invite" httpOrigin="" onDone={vi.fn()} />)
  const link = await screen.findByRole('link', { name: 'Continue to accept invitation' })
  expect(link.getAttribute('href')).toContain('https://accounts.example/account/sign-in')
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.queryByLabelText('Name')).toBeNull()
})
