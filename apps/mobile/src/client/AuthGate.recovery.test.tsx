import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  removeProfile: vi.fn().mockResolvedValue(undefined),
  updateCredential: vi.fn(),
}))

vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
}))
vi.mock('./auth', () => ({
  fetchAuthStatus: async () => ({
    needsAuth: true,
    authed: false,
    providerSignedIn: true,
    deniedReason: 'not a member of this workspace',
    signInUrl: 'https://app.example/account/sign-in',
  }),
  logout: mocks.logout,
}))
vi.mock('./hosted-sign-in-runtime', () => ({ hostedSignIn: { begin: mocks.begin } }))
vi.mock('./server-profile-context', () => ({
  useServerProfile: () => ({
    activation: 'online',
    config: { httpOrigin: 'https://api.example' },
    bearer: 'phone-token',
    profile: { id: 'phone', mode: 'protected', workspaceId: 'ws_selected' },
    removeProfile: mocks.removeProfile,
    updateCredential: mocks.updateCredential,
  }),
}))
vi.mock('./demoData', () => ({ demoEnabled: () => false }))
vi.mock('./launch-ready', () => ({ LaunchReadyView: ({ children }: any) => children }))
vi.mock('../screens/LoginScreen', () => ({ LoginScreen: () => null }))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
}))

import { AuthGate } from './AuthGate'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('passes the selected workspace and account origin through membership recovery', async () => {
  render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }))
  await waitFor(() => expect(mocks.begin).toHaveBeenCalled())
  expect(mocks.begin).toHaveBeenCalledWith(
    'https://api.example',
    'https://app.example/account/sign-in',
    'ws_selected',
  )
})
