import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '../test-support/auth-capabilities'

vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return { ...actual, Platform: { ...actual.Platform, OS: 'ios' } }
})
vi.mock('../client/server-profile-context', () => ({
  useServerProfile: () => ({ profile: { id: 'phone', name: 'Phone' } }),
}))
vi.mock('../components/AsciiWordmark', () => ({ AsciiWordmark: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: any) => children,
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress, accessibilityLabel }: any) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../components/HostedSignInButton', () => ({
  HostedSignInButton: ({ server, signInUrl, label }: any) => (
    <button type="button" data-server={server} data-page={signInUrl}>
      {label}
    </button>
  ),
}))

import { LoginScreen } from './LoginScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows browser sign-in instead of a password for a hosted workspace', () => {
  render(
    <LoginScreen
      httpOrigin="https://api.example"
      capabilities={accountCapabilities}
      prompt="email-password"
      onAuthed={() => {}}
    />,
  )
  const button = screen.getByRole('button', { name: 'Continue with Google' })
  expect(button.getAttribute('data-server')).toBe('https://api.example')
  expect(button.getAttribute('data-page')).toBe('https://accounts.example/account/sign-in')
  expect(screen.getByLabelText('Password')).toBeTruthy()
})
it('preserves password sign-in for a paired self-hosted server', () => {
  render(
    <LoginScreen
      capabilities={passwordCapabilities}
      prompt="email-password"
      httpOrigin="https://self.example"
      onAuthed={() => {}}
    />,
  )
  expect(screen.getByLabelText('Password')).toBeTruthy()
  expect(screen.queryByText('Continue with Podium Cloud')).toBeNull()
})

it.each([
  'member@example.com',
  '',
])('submits self-hosted identity %j from the form', async (email) => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      ok: true,
      delivery: 'native',
      token: 'phone-token',
      userId: 'mem_member',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const onAuthed = vi.fn()
  render(
    <LoginScreen
      capabilities={passwordCapabilities}
      prompt="email-password"
      httpOrigin="https://self.example"
      onAuthed={onAuthed}
    />,
  )
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  await waitFor(() => expect(onAuthed).toHaveBeenCalledWith('phone-token'))
  const request = JSON.parse(fetchMock.mock.calls[0]![1].body)
  expect(request).toMatchObject({
    password: 'secret',
    delivery: 'native',
    deviceId: 'phone',
    deviceName: 'Phone',
  })
  if (email) expect(request.email).toBe(email)
  else expect(request).not.toHaveProperty('email')
  expect(screen.queryByText(/Leave email blank/)).toBeNull()
})
