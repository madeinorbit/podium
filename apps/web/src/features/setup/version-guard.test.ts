import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentSkew, resetSkewNotice } from '@/app/skew-notice'
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

  it('does not reload when this client is ahead of its server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('server-behind')
    expect(reload).not.toHaveBeenCalled()
  })

  it('tells the user the server is behind, not that the build is stale', async () => {
    resetSkewNotice()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
          appVersion: 'test',
        }),
      ),
    )
    await checkServerVersion(ORIGIN)
    expect(currentSkew()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('server'),
      }),
    )
    expect(currentSkew()?.message).not.toContain('bun run build')
  })

  it('does not burn a reload attempt on the server-behind path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
        }),
      ),
    )
    await checkServerVersion(ORIGIN)
    expect(store.has(COUNTER_KEY)).toBe(false)
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

/**
 * THE CHECK THE WIRE VERSION COULD NOT MAKE (POD-1610).
 *
 * The stale bundle and its server agreed on wire 2 for three days while failing
 * to understand each other, because `WIRE_VERSION` is coarse on purpose. These
 * cases pin the finer one — and, as importantly, pin the two ways it must NOT
 * fire: on a matched pair, and on a server too old to advertise a digest at all.
 */
describe('checkServerVersion — schema digest', () => {
  const matched = {
    wireVersion: WIRE_VERSION,
    minSupportedVersion: WIRE_VERSION,
    appVersion: 'test',
    wireSchemaDigest: wireSchemaDigest(),
  }

  beforeEach(() => {
    resetSkewNotice()
  })

  it('CAN SAY NO: a matched pair does not reload and raises no notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionResponse(matched)))
    expect(await checkServerVersion(ORIGIN)).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
    expect(currentSkew()).toBeNull()
  })

  it('says nothing when the server does not advertise a digest at all', async () => {
    // An older server. Silence is not skew — treating it as skew would reload-loop
    // every deployment that predates the field.
    const { wireSchemaDigest: _omitted, ...noDigest } = matched
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionResponse(noDigest)))
    expect(await checkServerVersion(ORIGIN)).toBe('ok')
    expect(currentSkew()).toBeNull()
  })

  it('hard-reloads on a digest mismatch, even at the same wire version', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeefdeadbeef' })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('raises a VISIBLE notice once reloading has failed twice', async () => {
    store.set(COUNTER_KEY, '2')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeefdeadbeef' })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('blocked')
    // The whole point: 'blocked' used to be a console.error and nothing else.
    const notice = currentSkew()
    expect(notice?.source).toBe('boot-digest')
    expect(notice?.message).toContain('does not match the server')
    expect(notice?.message).toContain('bun run build')
  })
})
