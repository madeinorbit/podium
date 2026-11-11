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
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(logout('https://podium.example', 'phone-token')).rejects.toThrow(
      'logout failed: 503',
    )
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe('omit')
  })

  it('sends the member email with the bearer-only native login request', async () => {
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
      login(
        'https://podium.example',
        'secret',
        { id: 'profile-one', name: 'My phone' },
        ' Alice@example.com ',
      ),
    ).resolves.toEqual({ ok: true, bearer: 'phone-token' })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'Alice@example.com',
      password: 'secret',
      delivery: 'native',
      deviceId: 'profile-one',
      deviceName: 'My phone',
      platform: 'ios',
    })
  })
})

it('revokes a device bearer through the shared sign-out endpoint without an edition probe', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await logout('https://workspace.example', 'device-token')
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    'https://workspace.example/auth/logout',
  ])
  const init = fetchMock.mock.calls[0]![1] as RequestInit
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer device-token')
  expect(init.credentials).toBe('omit')
})
