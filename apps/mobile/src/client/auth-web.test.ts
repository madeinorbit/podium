import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

import { logout } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('signs out a browser through the Better Auth session endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)

  await logout('https://api.podium.do')

  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.podium.do/platform/auth/sign-out',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: '{}',
    }),
  )
})
