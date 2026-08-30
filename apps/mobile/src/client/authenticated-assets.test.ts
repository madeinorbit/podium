import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimePlatform = vi.hoisted(() => ({ OS: 'ios' }))
vi.mock('react-native', () => ({ Platform: runtimePlatform }))

import {
  authenticatedAssetHeaders,
  authenticatedImageSource,
  AUTHENTICATED_TEXT_PREVIEW_CAP,
  fetchAuthenticatedAsset,
  readAuthenticatedTextPreview,
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

  it('streams safely when Content-Length is absent', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('text') })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const response = {
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
      headers: new Headers(),
    } as unknown as Response

    await expect(readAuthenticatedTextPreview(response, 8)).resolves.toBe('text')
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
  ])(
    'refuses an unbounded one-shot fallback',
    async (headers) => {
      const arrayBuffer = vi.fn()
      const response = { body: null, headers, arrayBuffer } as unknown as Response

      await expect(readAuthenticatedTextPreview(response, 5)).rejects.toThrow(
        'This file is too large to preview safely on this device.',
      )
      expect(arrayBuffer).not.toHaveBeenCalled()
    },
  )
})
