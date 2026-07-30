import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { redirectPhoneToMobileApp } from './mobile-entry-redirect'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'

const desktopGlobal = globalThis as { __PODIUM_DESKTOP__?: NativeDesktopBridge }

/** Point the app at a URL with a given UA and capture any location.replace(). */
function boot(url: string, userAgent: string) {
  const replace = vi.fn()
  const { pathname, search } = new URL(url, 'http://podium.local')
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    pathname,
    search,
    replace,
  } as unknown as Location)
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  return { replace, redirected: redirectPhoneToMobileApp() }
}

afterEach(() => {
  vi.restoreAllMocks()
  desktopGlobal.__PODIUM_DESKTOP__ = undefined
})

describe('redirectPhoneToMobileApp [POD-359]', () => {
  it('sends a phone that landed on the cached desktop shell to the Expo app', () => {
    // The shell can only be here because a stale service worker answered `/`
    // from its precache before the server could redirect.
    const { replace, redirected } = boot('/', IPHONE)
    expect(redirected).toBe(true)
    expect(replace).toHaveBeenCalledWith('/mobile')
  })

  it('carries the query string across', () => {
    const { replace } = boot('/?server=wss://x&e2e=1', IPHONE)
    expect(replace).toHaveBeenCalledWith('/mobile?server=wss://x&e2e=1')
  })

  it('stays put once the server has marked the landing ?desktop', () => {
    // This is the loop-breaker: no Expo build means /mobile bounced us back
    // here, and a second hop would ping-pong forever.
    const { replace, redirected } = boot('/?desktop=1', IPHONE)
    expect(redirected).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('leaves desktops, deep links, and the Tauri shell alone', () => {
    expect(boot('/', MAC).replace).not.toHaveBeenCalled()
    expect(boot('/session/s1', IPHONE).replace).not.toHaveBeenCalled()

    desktopGlobal.__PODIUM_DESKTOP__ = { platform: 'macos' } as NativeDesktopBridge
    expect(boot('/', IPHONE).replace).not.toHaveBeenCalled()
  })
})
