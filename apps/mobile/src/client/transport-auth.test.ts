import { afterEach, describe, expect, it, vi } from 'vitest'
import { bearerHeaders, readServerConfig, setActiveServerRuntime } from './trpc'

afterEach(() => {
  setActiveServerRuntime(undefined, null)
  delete (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  vi.unstubAllGlobals()
})

describe('native bearer transport', () => {
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
