import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./server-profile-context', () => ({
  useServerProfile: () => ({
    activation: 'verified',
    config: { httpOrigin: 'https://a.example' },
    bearer: null,
    profile: { id: 'single-server', name: 'A', mode: 'protected' },
    removeProfile: async () => {},
    updateCredential: async () => {},
  }),
}))
vi.mock('./demoData', () => ({ demoEnabled: () => false }))
vi.mock('./launch-ready', () => ({ LaunchReadyView: ({ children }: any) => children }))
vi.mock('../screens/LoginScreen', () => ({ LoginScreen: () => <div>SIGN IN</div> }))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
}))
import { AuthGate } from './AuthGate'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('fails closed on a mobile HTTP auth refusal instead of opening a stale workspace', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 403 })),
  )
  render(
    <AuthGate>
      <div>WORKSPACE</div>
    </AuthGate>,
  )
  await screen.findByText('The server refused your account request.')
  expect(screen.queryByText('WORKSPACE')).toBeNull()
  expect(screen.queryByText('SIGN IN')).toBeNull()
})

it('keeps a blocked server out of the mobile password screen', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        needsAuth: true,
        authed: false,
        userId: null,
        readiness: { dataPlane: 'blocked' },
      }),
    ),
  )
  render(
    <AuthGate>
      <div>WORKSPACE</div>
    </AuthGate>,
  )
  await screen.findByText('The server is still starting.')
  expect(screen.queryByText('SIGN IN')).toBeNull()
  expect(screen.queryByText('WORKSPACE')).toBeNull()
})

it('admits a verified mobile account with the same identity used by the web gate', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        needsAuth: true,
        authed: true,
        userId: 'alice',
        memberId: 'alice',
        syncBoundaryId: 'installation-a',
      }),
    ),
  )
  render(
    <AuthGate>
      <div>WORKSPACE</div>
    </AuthGate>,
  )
  await screen.findByText('WORKSPACE')
})
