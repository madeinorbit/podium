import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '@/test-support/auth-capabilities'
import { LoginGate } from './LoginGate'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})
function status(capabilities: unknown, prompt = 'email-password') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ needsAuth: true, authed: false, capabilities, prompt })),
  )
}
test('the server prompt overrides a remembered form and provides host reset help', async () => {
  localStorage.setItem('podium.login.withEmail', '1')
  status(passwordCapabilities, 'password')
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  await screen.findByLabelText('Password')
  expect(screen.queryByLabelText('Email')).toBeNull()
  expect(screen.queryByRole('button', { name: /Sign in with email/ })).toBeNull()
  expect(screen.getByText(/podium setup/)).toBeTruthy()
  expect(screen.queryByText('Continue with Google')).toBeNull()
  expect(screen.queryByText('Continue with GitHub')).toBeNull()
  expect(screen.queryByText('Create account')).toBeNull()
})
test('account capabilities expose configured providers, sign-up, and mailed reset', async () => {
  status(accountCapabilities)
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  await screen.findByLabelText('Email')
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toContain(
    '/account/forgot-password',
  )
  expect(screen.getByRole('link', { name: 'Create account' }).getAttribute('href')).toContain(
    '/account/sign-up',
  )
  expect(screen.queryByText(/podium setup/)).toBeNull()
  expect(screen.queryByText(/ask an admin/i)).toBeNull()
})
test('disabled password and unconfigured providers never appear', async () => {
  status({
    ...accountCapabilities,
    passwordSignIn: false,
    providers: ['github'],
    selfSignUp: false,
  })
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  await screen.findByRole('button', { name: 'Continue with GitHub' })
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.queryByText('Continue with Google')).toBeNull()
  expect(screen.queryByText('Create account')).toBeNull()
})

test('the password prompt suppresses provider controls even when providers are configured', async () => {
  status(accountCapabilities, 'password')
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  await screen.findByLabelText('Password')
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull()
})
