import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ begin: vi.fn(), updateCredential: vi.fn() }))
vi.mock('./hosted-sign-in-runtime', () => ({ hostedSignIn: { begin: mocks.begin } }))
vi.mock('./server-profile-context', () => ({
  useServerProfile: () => ({
    activation: 'online', config: { httpOrigin: 'https://api.example' }, bearer: null,
    profile: { id: 'browser', name: 'Browser', mode: 'protected' },
    updateCredential: mocks.updateCredential,
  }),
}))
vi.mock('./demoData', () => ({ demoEnabled: () => false }))
vi.mock('./launch-ready', () => ({ LaunchReadyView: ({ children }: any) => children }))
vi.mock('../components/AsciiWordmark', () => ({ AsciiWordmark: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({ KeyboardAvoidingRoot: ({ children }: any) => children }))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
}))
import { AuthGate } from './AuthGate'
import { hostedBrowserSignInUrl } from './hosted-browser-sign-in'
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks() })
it('navigates a logged-out browser to account sign-in and opens the gate on cookie return', async () => {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  vi.spyOn(window.location, 'href', 'get').mockReturnValue('https://app.example/mobile/session/123?tab=files#recent')
  let cookie = false
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => Response.json({
    mode: 'cloud', needsAuth: true, authed: cookie && init.credentials === 'include',
    userId: cookie ? 'mem_browser' : null, signInUrl: 'https://app.example/account/sign-in',
  }))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<AuthGate><div>Workspace</div></AuthGate>)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with Podium Cloud' }))
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.queryByText('Workspace')).toBeNull()
  expect(assign).toHaveBeenCalledWith('https://app.example/account/sign-in?returnTo=%2Fmobile%2Fsession%2F123%3Ftab%3Dfiles%23recent')
  view.unmount()
  cookie = true // Account sign-in sets the HttpOnly cookie; navigation reloads the shell.
  render(<AuthGate><div>Workspace</div></AuthGate>)
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
it.each(['https://evil.example/mobile/a', 'https://app.example//evil.example', 'https://app.example/account/handoff'])('defaults unsafe return %s to the mobile root', (current) => {
  const url = new URL(hostedBrowserSignInUrl('https://app.example/account/sign-in?handoff=desktop&challenge=secret&returnTo=https://evil.example#bad', current))
  expect(url.search).toBe('?returnTo=%2Fmobile%2F')
  expect(url.hash).toBe('')
})
it.each(['javascript:alert(1)', 'http://app.example/account/sign-in', 'https://user:pass@app.example/account/sign-in', 'https://app.example/account/handoff'])('rejects invalid account page %s', (page) => {
  expect(() => hostedBrowserSignInUrl(page, 'https://app.example/mobile/')).toThrow()
})
