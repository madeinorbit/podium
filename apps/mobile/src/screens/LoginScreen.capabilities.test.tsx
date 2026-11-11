import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '../test-support/auth-capabilities'

vi.mock('../client/server-profile-context', () => ({
  useServerProfile: () => ({ profile: { id: 'phone', name: 'Phone' } }),
}))
vi.mock('../components/AsciiWordmark', () => ({ AsciiWordmark: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: any) => children,
}))
vi.mock('../components/HostedSignInButton', () => ({
  HostedSignInButton: ({ label }: any) => <button type="button">{label}</button>,
}))

import { LoginScreen } from './LoginScreen'

afterEach(() => cleanup())
test('phone password-only prompt hides email and shows host reset help', () => {
  render(
    <LoginScreen
      httpOrigin="https://workspace.example"
      capabilities={passwordCapabilities}
      prompt="password"
      onAuthed={() => {}}
    />,
  )
  expect(screen.getByLabelText('Password')).toBeTruthy()
  expect(screen.queryByLabelText('Email')).toBeNull()
  expect(screen.getByText(/podium setup/)).toBeTruthy()
  expect(screen.queryByText(/Leave email blank/)).toBeNull()
})
test('phone account capabilities show both providers and mailed reset without host help', () => {
  render(
    <LoginScreen
      httpOrigin="https://workspace.example"
      capabilities={accountCapabilities}
      prompt="email-password"
      onAuthed={() => {}}
    />,
  )
  expect(screen.getByLabelText('Email')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Create account' })).toBeTruthy()
  expect(screen.queryByText(/podium setup/)).toBeNull()
  expect(screen.queryByText(/Leave email blank/)).toBeNull()
})
