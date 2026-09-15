import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { expoFetch, runtimePlatform } = vi.hoisted(() => ({
  expoFetch: vi.fn(), runtimePlatform: { OS: 'ios' },
}))
vi.mock('expo/fetch', () => ({ fetch: expoFetch }))
vi.mock('react-native', () => ({ Platform: runtimePlatform }))
import { HttpBootstrapSource, SyncAuthExpiredError } from '@podium/client-core/sync-stream'
import { MobileAuthExpiredError } from './auth'
import { createMobileSyncFetch, MOBILE_SYNC_BUFFER_CAP, requireMobileSyncStream } from './mobile-sync-fetch'

beforeEach(() => { runtimePlatform.OS = 'ios'; expoFetch.mockReset() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function buffered(headers: HeadersInit = {}, bytes = new Uint8Array(3)) {
  return { body: {}, headers: new Headers(headers), status: 200, statusText: 'OK',
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer) } as unknown as Response
}

describe('mobile HTTP sync fetch port', () => {
  it.each(['ios', 'android'])('uses Expo on %s with bearer, workspace and cancellation, leaving coding to the stack', async (os) => {
    runtimePlatform.OS = os
    const webFetch = vi.fn()
    vi.stubGlobal('fetch', webFetch)
    const response = new Response('chunk')
    expoFetch.mockResolvedValue(response)
    const signal = new AbortController().signal
    const port = createMobileSyncFetch('token', undefined, { workspaceId: 'workspace' })
    expect(await port.fetch('https://server/sync/bootstrap', { signal, headers: { 'X-Test': 'value' } })).toBe(response)
    const init = expoFetch.mock.calls[0]![1]
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBe(signal)
    expect(init.headers.get('Authorization')).toBe('Bearer token')
    expect(init.headers.get('Podium-Workspace-Id')).toBe('workspace')
    expect(init.headers.get('X-Test')).toBe('value')
    expect(init.headers.has('Accept-Encoding')).toBe(false)
    expect(webFetch).not.toHaveBeenCalled()
  })

  it('uses global web fetch with cookies and the workspace slug', async () => {
    runtimePlatform.OS = 'web'
    const fetch = vi.fn().mockResolvedValue(new Response('chunk'))
    vi.stubGlobal('fetch', fetch)
    await createMobileSyncFetch(null, undefined, { workspaceSlug: 'project' }).fetch('/sync/delta', {})
    expect(fetch.mock.calls[0]![1].credentials).toBe('include')
    expect(fetch.mock.calls[0]![1].headers.get('Podium-Workspace')).toBe('project')
    expect(fetch.mock.calls[0]![1].headers.has('Authorization')).toBe(false)
    expect(expoFetch).not.toHaveBeenCalled()
  })

  it('routes 401 to credential expiry and preserves the shared typed refusal', async () => {
    expoFetch.mockResolvedValue(new Response(null, { status: 401 }))
    const expired = vi.fn()
    const source = new HttpBootstrapSource({ origin: 'https://server', streamingFetch: createMobileSyncFetch('old', expired) })
    await expect(source.bootstrap().next()).rejects.toBeInstanceOf(SyncAuthExpiredError)
    expect(expired).toHaveBeenCalledExactlyOnceWith(expect.any(MobileAuthExpiredError))
  })

  it.each<HeadersInit>([{}, { 'content-length': String(MOBILE_SYNC_BUFFER_CAP + 1) },
    { 'content-length': '-1' }, { 'content-length': 'invalid' },
    { 'content-length': '3', 'content-encoding': 'gzip' }])('refuses unsafe non-streaming response %j before reading', async (headers) => {
    const response = buffered(headers)
    await expect(requireMobileSyncStream(response)).rejects.toThrow('cannot be buffered safely')
    expect(response.arrayBuffer).not.toHaveBeenCalled()
  })

  it('turns a bounded identity fallback into a readable stream', async () => {
    const response = await requireMobileSyncStream(buffered({ 'content-length': '3' }))
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array(3))
    expect((await reader.read()).done).toBe(true)
  })

  it('refuses a fallback whose actual size disagrees with its declaration', async () => {
    await expect(requireMobileSyncStream(buffered({ 'content-length': '2' }))).rejects.toThrow('declared size')
  })
})
