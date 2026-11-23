import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

import { logout } from './auth'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('signs out a browser through the shared session endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  await logout('https://workspace.example')
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    'https://workspace.example/auth/logout',
    expect.objectContaining({ method: 'POST', credentials: 'include' }),
  )
})
