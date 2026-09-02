import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { expoFetch, runtimePlatform } = vi.hoisted(() => ({
  expoFetch: vi.fn(),
  runtimePlatform: { OS: 'ios' },
}))
vi.mock('expo/fetch', () => ({ fetch: expoFetch }))
vi.mock('react-native', () => ({ Platform: runtimePlatform }))

import {
  authenticatedAssetHeaders,
  authenticatedImageSource,
  authenticatedVideoSource,
  AUTHENTICATED_TEXT_PREVIEW_CAP,
  fetchAuthenticatedAsset,
  readAuthenticatedTextPreview,
} from './authenticated-assets'

beforeEach(() => {
  runtimePlatform.OS = 'ios'
  expoFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
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
    expect(
      authenticatedVideoSource('https://podium.example/files/artifact.mp4', 'phone-token'),
    ).toEqual({
      uri: 'https://podium.example/files/artifact.mp4',
      headers: { Authorization: 'Bearer phone-token' },
    })
  })

  it('keeps web file requests cookie-only even if a token is supplied accidentally', () => {
    runtimePlatform.OS = 'web'
    expect(authenticatedAssetHeaders('must-not-leak')).toBeUndefined()
    expect(authenticatedImageSource('/files/asset', 'must-not-leak')).toEqual({
      uri: '/files/asset',
    })
    expect(authenticatedVideoSource('/files/asset.mp4', 'must-not-leak')).toEqual({
      uri: '/files/asset.mp4',
    })
  })

  it('uses streaming expo/fetch on native with the bearer and no ambient cookies', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('native') })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const response = {
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
      headers: new Headers(),
    } as unknown as Response
    expoFetch.mockResolvedValue(response)
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    const fetched = await fetchAuthenticatedAsset(
      'https://podium.example/files/asset',
      'phone-token',
    )
    await expect(readAuthenticatedTextPreview(fetched, 16)).resolves.toBe('native')
    expect(expoFetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      headers: { Authorization: 'Bearer phone-token' },
    })
    expect(globalFetch).not.toHaveBeenCalled()
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
    expect(expoFetch).not.toHaveBeenCalled()
  })
})

describe('protected text previews', () => {
  it('keeps the preview budget at 512 KB', () => {
    expect(AUTHENTICATED_TEXT_PREVIEW_CAP).toBe(512 * 1024)
  })

  it('stops a response stream at the preview cap and cancels the rest', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('abc') })
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('def') })
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('unread') })
    const cancel = vi.fn().mockResolvedValue(undefined)
    const response = {
      body: { getReader: () => ({ read, cancel }) },
      headers: new Headers({ 'content-length': '1024' }),
    } as unknown as Response

    await expect(readAuthenticatedTextPreview(response, 5)).resolves.toBe('abcde')
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('streams a gzip response when Content-Length is absent', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('text') })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const response = {
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
      headers: new Headers({ 'content-encoding': 'gzip' }),
    } as unknown as Response

    await expect(readAuthenticatedTextPreview(response, 8)).resolves.toBe('text')
  })

  it('decodes a one-chunk small stream without allocating a 512 KB target', async () => {
    const chunk = new TextEncoder().encode('tiny')
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: chunk })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const cancel = vi.fn()
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    const response = {
      body: { getReader: () => ({ read, cancel }) },
      headers: new Headers({ 'content-length': String(chunk.byteLength) }),
    } as unknown as Response

    await expect(readAuthenticatedTextPreview(response)).resolves.toBe('tiny')
    expect(decode).toHaveBeenCalledWith(chunk)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('uses the one-shot fallback only when Content-Length fits', async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode('safe').buffer)
    const response = {
      body: null,
      headers: new Headers({ 'content-length': '4' }),
      arrayBuffer,
    } as unknown as Response

    await expect(readAuthenticatedTextPreview(response, 5)).resolves.toBe('safe')
    expect(arrayBuffer).toHaveBeenCalledOnce()
  })

  it.each([
    new Headers(),
    new Headers({ 'content-length': '6' }),
    new Headers({ 'content-length': '' }),
    new Headers({ 'content-encoding': 'gzip', 'content-length': '4' }),
  ])('refuses an unbounded one-shot fallback', async (headers) => {
    const arrayBuffer = vi.fn()
    const response = { body: null, headers, arrayBuffer } as unknown as Response

    await expect(readAuthenticatedTextPreview(response, 5)).rejects.toThrow(
      'This file is too large to preview safely on this device.',
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
})
