import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

import { login, logout } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('native auth transport', () => {
  it('refuses cleartext password submission before fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(login('http://192.168.1.8', 'secret')).resolves.toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a non-2xx logout response as failed revocation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ needsAuth: true, authed: true, userId: 'user:admin' }))
      .mockResolvedValue(new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(logout('https://podium.example', 'phone-token')).rejects.toThrow(
      'logout failed: 503',
    )
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe('omit')
  })

  it('uses the finalized bearer-only native login request and response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          delivery: 'native',
          token: 'phone-token',
          userId: 'user:admin',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      login('https://podium.example', 'secret', { id: 'profile-one', name: 'My phone' }),
    ).resolves.toEqual({ ok: true, bearer: 'phone-token' })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(String(init.body))).toEqual({
      password: 'secret',
      delivery: 'native',
      deviceId: 'profile-one',
      deviceName: 'My phone',
      platform: 'ios',
    })
  })
})

it('revokes a hosted bearer through the platform and still retires pairing credentials', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        needsAuth: true,
        authed: true,
        userId: 'user:admin',
        mode: 'cloud',
        signInUrl: 'https://ade.podium.do/account/sign-in',
      }),
    )
    .mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await logout('https://api.podium.do', 'cloud-token')
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    'https://api.podium.do/auth/status',
    'https://api.podium.do/platform/auth/sign-out',
    'https://api.podium.do/auth/logout',
  ])
  const init = fetchMock.mock.calls[1]![1] as RequestInit
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer cloud-token')
  expect(init.credentials).toBe('omit')
  expect(init.redirect).toBe('error')
})
it('reports platform revocation failure instead of claiming sign-out succeeded', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ needsAuth: true, authed: true, userId: 'user:admin', mode: 'cloud' }),
    )
    .mockResolvedValue(new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(logout('https://api.podium.do', 'cloud-token')).rejects.toThrow(
    'Cloud sign-out failed: 503',
  )
})
