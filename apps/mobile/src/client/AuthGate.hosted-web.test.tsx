import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '../test-support/auth-capabilities'

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  removeProfile: vi.fn().mockResolvedValue(undefined),
  updateCredential: vi.fn(),
}))
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  logout: mocks.logout,
}))
vi.mock('./hosted-sign-in-runtime', () => ({ hostedSignIn: { begin: mocks.begin } }))
vi.mock('./server-profile-context', () => ({
  useServerProfile: () => ({
    activation: 'online',
    config: { httpOrigin: 'https://api.example' },
    bearer: null,
    profile: { id: 'browser', name: 'Browser', mode: 'protected' },
    removeProfile: mocks.removeProfile,
    updateCredential: mocks.updateCredential,
  }),
}))
vi.mock('./demoData', () => ({ demoEnabled: () => false }))
vi.mock('./launch-ready', () => ({ LaunchReadyView: ({ children }: any) => children }))
vi.mock('../components/AsciiWordmark', () => ({ AsciiWordmark: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: any) => children,
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress }: any) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}))

import { AuthGate } from './AuthGate'
import { hostedBrowserSignInUrl } from './hosted-browser-sign-in'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})
it('navigates a logged-out browser to account sign-in and opens the gate on cookie return', async () => {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  vi.spyOn(window.location, 'href', 'get').mockReturnValue(
    'https://app.example/mobile/session/123?tab=files#recent',
  )
  let cookie = false
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json({
      capabilities: { ...accountCapabilities, accountUrl: 'https://app.example/account' },
      prompt: 'email-password',
      needsAuth: true,
      authed: cookie && init.credentials === 'include',
      userId: cookie ? 'mem_browser' : null,
      ...(cookie ? { memberId: 'mem_browser', syncBoundaryId: 'installation-browser' } : {}),
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  const view = render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
  expect(screen.getByLabelText('Password')).toBeTruthy()
  expect(screen.queryByText('Workspace')).toBeNull()
  expect(assign).toHaveBeenCalledWith(
    'https://app.example/account/sign-in?returnTo=%2Fmobile%2Fsession%2F123%3Ftab%3Dfiles%23recent&switchAccount=1',
  )
  view.unmount()
  cookie = true // Account sign-in sets the HttpOnly cookie; navigation reloads the shell.
  render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  await screen.findByText('Workspace')
  expect(fetcher).toHaveBeenCalledTimes(2)
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toBe('https://api.example/auth/status')
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
  }
  expect(mocks.begin).not.toHaveBeenCalled()
  expect(mocks.updateCredential).not.toHaveBeenCalled()
})
it.each([
  'https://evil.example/mobile/a',
  'https://app.example//evil.example',
  'https://app.example/account/handoff',
])('defaults unsafe return %s to the mobile root', (current) => {
  const url = new URL(
    hostedBrowserSignInUrl(
      'https://app.example/account/sign-in?handoff=desktop&challenge=secret&returnTo=https://evil.example#bad',
      current,
    ),
  )
  expect(url.search).toBe('?returnTo=%2Fmobile%2F&switchAccount=1')
  expect(url.hash).toBe('')
})
it.each([
  'javascript:alert(1)',
  'http://app.example/account/sign-in',
  'https://user:pass@app.example/account/sign-in',
  'https://app.example/account/handoff',
])('rejects invalid account page %s', (page) => {
  expect(() => hostedBrowserSignInUrl(page, 'https://app.example/mobile/')).toThrow()
})
it('shows the workspace refusal instead of a repeat-sign-in loop', async () => {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        capabilities: { ...accountCapabilities, accountUrl: 'https://app.example/account' },
        prompt: 'email-password',
        needsAuth: true,
        authed: false,
        userId: null,

        denied: 'not_workspace_member',
      }),
    ),
  )
  render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This account is not a member of this workspace.',
  )
  expect(screen.getByRole('button', { name: 'Use another account' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Use another account' }))
  await waitFor(() => expect(assign).toHaveBeenCalled())
  expect(mocks.logout).toHaveBeenCalledWith('https://api.example', null, undefined)
  expect(mocks.removeProfile).toHaveBeenCalledWith('browser')
})

it('opens an invitation in the shared web screen before checking an existing browser sign-in', async () => {
  window.history.replaceState(null, '', '/mobile/#invite=invitation-secret')
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {})
  const fetcher = vi.fn(async () =>
    Response.json({
      needsAuth: true,
      authed: true,
      userId: 'alice',
      memberId: 'alice',
      syncBoundaryId: 'server',
      capabilities: accountCapabilities,
      prompt: 'email-password',
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(
    <AuthGate>
      <div>Workspace</div>
    </AuthGate>,
  )
  await waitFor(() => expect(replace).toHaveBeenCalled())
  const target = new URL(replace.mock.calls[0]![0])
  expect(target.pathname).toBe('/')
  expect(target.searchParams.has('desktop')).toBe(true)
  expect(target.hash).toBe('#invite=invitation-secret')
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByText('Workspace')).toBeNull()
  window.history.replaceState(null, '', '/')
})
