import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

import { login, logout } from './auth'

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

it('sends an empty identifier for password-only browser login', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(login('https://podium.example', 'secret')).resolves.toEqual({
    ok: true,
    bearer: null,
  })
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(init.credentials).toBe('include')
  expect(JSON.parse(String(init.body))).toEqual({ email: '', password: 'secret' })
})
