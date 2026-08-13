import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimePlatform = vi.hoisted(() => ({ OS: 'ios' }))
vi.mock('react-native', () => ({ Platform: runtimePlatform }))

import {
  authenticatedAssetHeaders,
  authenticatedImageSource,
  fetchAuthenticatedAsset,
} from './authenticated-assets'

beforeEach(() => {
  runtimePlatform.OS = 'ios'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('protected file transport', () => {
  it('adds the native bearer to image and fetch requests', () => {
    expect(authenticatedAssetHeaders('phone-token')).toEqual({
      Authorization: 'Bearer phone-token',
    })
    expect(
      authenticatedImageSource('https://podium.example/files/artifact', 'phone-token'),
    ).toEqual({
      uri: 'https://podium.example/files/artifact',
      headers: { Authorization: 'Bearer phone-token' },
    })
  })

  it('keeps web file requests cookie-only even if a token is supplied accidentally', () => {
    runtimePlatform.OS = 'web'
    expect(authenticatedAssetHeaders('must-not-leak')).toBeUndefined()
    expect(authenticatedImageSource('/files/asset', 'must-not-leak')).toEqual({
      uri: '/files/asset',
    })
  })

  it('omits ambient native cookies while carrying the bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchAuthenticatedAsset('https://podium.example/files/asset', 'phone-token')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      headers: { Authorization: 'Bearer phone-token' },
    })
  })

  it('uses cookies without Authorization on web', async () => {
    runtimePlatform.OS = 'web'
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchAuthenticatedAsset('/files/asset', 'must-not-leak')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      credentials: 'include',
      headers: undefined,
    })
  })
})
