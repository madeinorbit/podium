/**
 * THE BUILD SAYS SO, THE PAGE DOES NOT GUESS (PDM-24).
 *
 * A served web app belongs to its page origin because its HttpOnly session
 * cookie belongs there — that is why `readServerConfig` and `webProfile`
 * deliberately ignore the injected `__PODIUM_SERVER__` on web. The one
 * deployment where a different API host is still reachable with that cookie is
 * the same-site split (`app.<site>` calling `api.<site>`), where `SameSite=Lax`
 * still attaches it to everything the page asks for.
 *
 * Which case this is, is known at BUILD time and nowhere else. Computing it in
 * the page would mean deciding "same site" from the hostname, which needs the
 * public suffix list to be right; being wrong there means sending credentials
 * to a host that merely looks like a neighbour. So the build injects the flag
 * and the page believes it, or there is no flag and nothing changes.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

const globals = globalThis as {
  __PODIUM_SERVER__?: string | undefined
  __PODIUM_SAME_SITE__?: boolean | undefined
}

afterEach(() => {
  globals.__PODIUM_SERVER__ = undefined
  globals.__PODIUM_SAME_SITE__ = undefined
  window.history.replaceState(null, '', '/')
  // `readServerConfig` memoizes into module state, so each case needs its own
  // copy of the module rather than its own set of globals.
  vi.resetModules()
})

describe('sameSiteBuildServer', () => {
  test('is the injected origin when the build flagged it same-site', async () => {
    globals.__PODIUM_SERVER__ = 'https://api.meetpodium.com'
    globals.__PODIUM_SAME_SITE__ = true
    const { sameSiteBuildServer } = await import('./trpc')
    expect(sameSiteBuildServer()).toBe('https://api.meetpodium.com')
  })

  test('is undefined without the flag, however the origin arrived', async () => {
    globals.__PODIUM_SERVER__ = 'https://api.meetpodium.com'
    const { sameSiteBuildServer } = await import('./trpc')
    expect(sameSiteBuildServer()).toBeUndefined()
  })

  test('is undefined when the flag is set but nothing was injected', async () => {
    globals.__PODIUM_SAME_SITE__ = true
    const { sameSiteBuildServer } = await import('./trpc')
    expect(sameSiteBuildServer()).toBeUndefined()
  })
})

describe('readServerConfig on web', () => {
  test('uses the same-site build origin, and says it is an override', async () => {
    globals.__PODIUM_SERVER__ = 'https://api.meetpodium.com'
    globals.__PODIUM_SAME_SITE__ = true
    const { readServerConfig } = await import('./trpc')
    const config = readServerConfig()
    expect(config.httpOrigin).toBe('https://api.meetpodium.com')
    expect(config.wsClientUrl.startsWith('wss://api.meetpodium.com/client')).toBe(true)
    expect(config.override).toBe(true)
  })

  test('keeps the page origin when the build said nothing', async () => {
    globals.__PODIUM_SERVER__ = 'https://api.meetpodium.com'
    const { readServerConfig } = await import('./trpc')
    expect(readServerConfig().httpOrigin).toBe(window.location.origin)
  })

  test('an explicit ?server= override still wins, for development', async () => {
    globals.__PODIUM_SERVER__ = 'https://api.meetpodium.com'
    globals.__PODIUM_SAME_SITE__ = true
    window.history.replaceState(null, '', '/?server=http://127.0.0.1:18787')
    const { readServerConfig } = await import('./trpc')
    expect(readServerConfig().httpOrigin).toBe('http://127.0.0.1:18787')
  })
})
