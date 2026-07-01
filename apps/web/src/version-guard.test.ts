import { WIRE_VERSION } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkServerVersion, forceReload } from './version-guard'

const ORIGIN = 'https://relay.test'
const COUNTER_KEY = 'podium.vreload'

let reload: ReturnType<typeof vi.fn>
let unregister: ReturnType<typeof vi.fn>
let cacheDelete: ReturnType<typeof vi.fn>
let store: Map<string, string>

/** A minimal `/version` fetch Response stub. */
function versionResponse(body: unknown): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
} {
  return { ok: true, status: 200, json: async () => body }
}

beforeEach(() => {
  reload = vi.fn()
  unregister = vi.fn().mockResolvedValue(true)
  cacheDelete = vi.fn().mockResolvedValue(true)
  store = new Map<string, string>()

  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
  })
  vi.stubGlobal('caches', {
    keys: vi.fn().mockResolvedValue(['podium-precache', 'podium-runtime']),
    delete: cacheDelete,
  })
  vi.stubGlobal('location', { reload })
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('forceReload', () => {
  it('unregisters every service worker, deletes every cache, then reloads', async () => {
    await forceReload()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still reloads when the service-worker + caches APIs are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('caches', undefined)
    await forceReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('checkServerVersion', () => {
  it('returns ok and does not reload when the wire versions match, clearing a stale counter', async () => {
    store.set(COUNTER_KEY, '1') // a leftover counter from an earlier blip
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
    expect(store.has(COUNTER_KEY)).toBe(false)
  })

  it('hard-reloads when the server wire version differs from the bundle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION + 1,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('reloaded')
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(store.get(COUNTER_KEY)).toBe('1') // first reload recorded
  })

  it('hard-reloads when the bundle is older than the server minimum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION + 1,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('blocks (no further reload) after two reloads in a session, surfacing an error', async () => {
    store.set(COUNTER_KEY, '2') // already reloaded twice this session
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION + 1,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('blocked')
    expect(reload).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('treats a fetch rejection as ok (never blocks on a flaky /version)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })

  it('treats a non-JSON /version body as ok (old server serving the SPA shell)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      }),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })
})
