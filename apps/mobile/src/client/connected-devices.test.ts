import { describe, expect, it, vi } from 'vitest'
import { readConnectedDevices } from './connected-devices-api'
import type { fetchMobileTransport } from './trpc'

const body = {
  sessions: [
    {
      sessionId: 'abcdefghijklmnopqrstuvwx',
      userId: 'user:one',
      label: 'mobile',
      deviceId: 'phone-one',
      deviceName: 'Operator iPhone',
      platform: 'ios',
      createdAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-08-31T00:00:00.000Z',
      current: true,
    },
  ],
}

describe('readConnectedDevices', () => {
  it('reads the active profile endpoint through its own bearer and typed response', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    await expect(
      readConnectedDevices(
        'https://podium.example/',
        'profile-bearer',
        fetcher as unknown as typeof fetchMobileTransport,
      ),
    ).resolves.toEqual(body.sessions)
    expect(fetcher).toHaveBeenCalledWith(
      'https://podium.example/auth/client-sessions',
      { cache: 'no-store', headers: { accept: 'application/json' } },
      'profile-bearer',
    )
  })

  it('refuses a malformed device inventory instead of publishing partial metadata', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ sessions: [{ current: true }] }), { status: 200 }),
    )
    await expect(
      readConnectedDevices(
        'https://podium.example',
        'bearer',
        fetcher as unknown as typeof fetchMobileTransport,
      ),
    ).rejects.toThrow()
  })
})
