import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  probe: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  removeProfile: vi.fn().mockResolvedValue(undefined),
  updateCredential: vi.fn(),
}))

vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
}))
vi.mock('./auth', () => ({
  probeAuth: () => mocks.probe(),
  logout: mocks.logout,
}))
const denied = {
  kind: 'membership-denied',
  reason: 'not a member of this workspace',
  status: {
    needsAuth: true,
    userId: null,
    mode: 'cloud',
    authed: false,
    providerSignedIn: true,
    deniedReason: 'not a member of this workspace',
    signInUrl: 'https://app.example/account/sign-in',
  },
} as const
vi.mock('./hosted-sign-in-runtime', () => ({ hostedSignIn: { begin: mocks.begin } }))
vi.mock('./server-profile-context', () => ({
  useServerProfile: () => ({
    activation: 'online',
    config: { httpOrigin: 'https://api.example' },
    bearer: 'c'.repeat(43),
    profile: { id: 'phone', mode: 'protected', workspaceId: 'ws_selected' },
    removeProfile: mocks.removeProfile,
    updateCredential: mocks.updateCredential,
  }),
}))
vi.mock('./demoData', () => ({ demoEnabled: () => false }))
vi.mock('./launch-ready', () => ({ LaunchReadyView: ({ children }: any) => children }))
vi.mock('../screens/LoginScreen', () => ({
  LoginScreen: ({ repairNeeded }: { repairNeeded?: boolean }) =>
    repairNeeded ? <div>Pair this phone again</div> : null,
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
}))

import { AuthGate } from './AuthGate'

beforeEach(() => mocks.probe.mockResolvedValue(denied))

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

it('tells the phone to pair again if its pre-upgrade credential is refused', async () => {
  mocks.probe.mockResolvedValue({
    kind: 'login',
    status: { needsAuth: true, authed: false, userId: null },
  })
  render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  expect(await screen.findByText('Pair this phone again')).toBeTruthy()
  expect(screen.queryByText('Workspace')).toBeNull()
})
