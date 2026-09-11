import { createRouter, routeDefaults } from '@podium/client-core/router'
import { afterEach, expect, test, vi } from 'vitest'
import { workspaceFetch, workspaceSlug, workspaceSocketUrl } from './workspace-request'
import { reportingFetch, serverConfig } from '@/app/trpc'
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})
test('extracts only a workspace prefix and preserves socket parameters', () => {
  expect(workspaceSlug('/w/anna/session/1')).toBe('anna')
  expect(workspaceSlug('/w/anna')).toBe('anna')
  expect(workspaceSlug('/workspace/anna')).toBeUndefined()
  expect(workspaceSlug('/w/')).toBeUndefined()
  expect(workspaceSlug('/w/%invalid/')).toBeUndefined()
  const url = new URL(workspaceSocketUrl('wss://api.example/client?v=4', '/w/anna/'))
  expect(url.searchParams.get('workspace')).toBe('anna')
  expect(url.searchParams.get('v')).toBe('4')
  expect(workspaceSocketUrl('wss://api.example/client?v=4', '/')).toBe(
    'wss://api.example/client?v=4',
  )
})
test('web fetches and tRPC preserve credentials and headers while sending the workspace', async () => {
  window.history.replaceState(null, '', '/w/anna/session/1')
  const base = vi.fn<typeof fetch>(async () => new Response('{}'))
  vi.stubGlobal('fetch', base)
  await workspaceFetch('/auth/status', {
    credentials: 'include',
    headers: { authorization: 'Bearer token' },
  })
  let init = base.mock.calls[0]![1] as RequestInit
  expect(new Headers(init.headers).get('Podium-Workspace')).toBe('anna')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer token')
  expect(init.credentials).toBe('include')
  await reportingFetch(base)('https://api.example/trpc/auth.status')
  init = base.mock.calls[1]![1] as RequestInit
  expect(new Headers(init.headers).get('Podium-Workspace')).toBe('anna')
  expect(serverConfig(window.location).wsClientUrl).toContain('workspace=anna')
})
test('ordinary URLs do not add a workspace header', async () => {
  const base = vi.fn<typeof fetch>(async () => new Response('{}'))
  vi.stubGlobal('fetch', base)
  await workspaceFetch('/auth/status')
  expect(base).toHaveBeenCalledWith('/auth/status', undefined)
})

test.each([
  '/w/anna',
  '/w/anna/issues/iss_1',
  '/w/anna/unknown',
])('real router preserves HTTP and socket workspace routing from %s', async (path) => {
  window.history.replaceState(null, '', path)
  const router = createRouter()
  const base = vi.fn<typeof fetch>(async () => new Response('{}'))
  vi.stubGlobal('fetch', base)
  try {
    const checkRequests = async () => {
      await workspaceFetch('/auth/status')
      await reportingFetch(base)('https://api.example/trpc/auth.status')
      for (const call of base.mock.calls.slice(-2)) {
        expect(new Headers(call[1]?.headers).get('Podium-Workspace')).toBe('anna')
      }
      expect(new URL(serverConfig(window.location).wsClientUrl).searchParams.get('workspace')).toBe(
        'anna',
      )
    }
    await checkRequests()
    router.navigate(routeDefaults('settings'))
    expect(window.location.pathname).toBe('/w/anna/settings')
    await checkRequests()
    router.replace({ ...routeDefaults('workspace'), pane: 's1' })
    expect(window.location.pathname).toBe('/w/anna/workspace')
    await checkRequests()
    // A history event must reparse both the view and workspace identity.
    window.history.replaceState(null, '', '/w/anna/issues/iss_1')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(router.current()).toMatchObject({ workspaceSlug: 'anna', issueId: 'iss_1' })
    await checkRequests()
  } finally {
    router.dispose()
  }
})
