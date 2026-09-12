import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  PressableScale: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
}))
vi.mock('../components/HostedSignInButton', () => ({
  HostedSignInButton: ({ server, signInUrl }: any) => (
    <button data-server={server} data-page={signInUrl}>
      Continue with Podium Cloud
    </button>
  ),
}))
import { LoginScreen } from './LoginScreen'
afterEach(cleanup)
it('shows browser sign-in instead of a password for a hosted workspace', () => {
  render(
    <LoginScreen
      httpOrigin="https://api.example"
      cloudSignInUrl="https://app.example/account/sign-in"
      onAuthed={() => {}}
    />,
  )
  const button = screen.getByRole('button', { name: 'Continue with Podium Cloud' })
  expect(button.getAttribute('data-server')).toBe('https://api.example')
  expect(button.getAttribute('data-page')).toBe('https://app.example/account/sign-in')
  expect(screen.queryByLabelText('Password')).toBeNull()
})
it('preserves password sign-in for a paired self-hosted server', () => {
  render(<LoginScreen httpOrigin="https://self.example" onAuthed={() => {}} />)
  expect(screen.getByLabelText('Password')).toBeTruthy()
  expect(screen.queryByText('Continue with Podium Cloud')).toBeNull()
})
