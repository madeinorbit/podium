import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bearerHeaders,
  fetchMobileTransport,
  readServerConfig,
  setActiveServerRuntime,
} from './trpc'

afterEach(() => {
  setActiveServerRuntime(undefined, null)
  delete (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  vi.unstubAllGlobals()
})

describe('native bearer transport', () => {
  it('publishes a typed expiry only for an authenticated HTTP 401', async () => {
    const expired = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )

    await fetchMobileTransport('https://podium.example/trpc', undefined, 'device-token', expired)

    expect(expired).toHaveBeenCalledTimes(1)
    expect(expired.mock.calls[0]?.[0]).toMatchObject({
      kind: 'auth-expired',
      name: 'MobileAuthExpiredError',
    })
  })

  it('keeps transport rejection on the network path', async () => {
    const expired = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network request failed')
      }),
    )

    await expect(
      fetchMobileTransport('https://podium.example/trpc', undefined, 'device-token', expired),
    ).rejects.toThrow('Network request failed')
    expect(expired).not.toHaveBeenCalled()
  })

  it('adds the bearer without disturbing tRPC content headers', () => {
    const headers = bearerHeaders('device-token', { 'content-type': 'application/json' })
    expect(headers.get('authorization')).toBe('Bearer device-token')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('leaves web cookie requests without an authorization header', () => {
    expect(bearerHeaders(null).has('authorization')).toBe(false)
  })

  it('binds web to page origin ahead of native build injection', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        host: 'served.example',
        origin: 'https://served.example',
        search: '',
      },
    })
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'https://injected.example'
    expect(readServerConfig()).toMatchObject({
      httpOrigin: 'https://served.example',
      override: false,
    })
  })

  it('honors an explicit web page query override', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        host: 'served.example',
        origin: 'https://served.example',
        search: '?server=https%3A%2F%2Foverride.example',
      },
    })
    expect(readServerConfig()).toMatchObject({
      httpOrigin: 'https://override.example',
      override: true,
    })
  })
})
