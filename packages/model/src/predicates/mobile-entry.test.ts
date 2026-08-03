import { describe, expect, it } from 'vitest'
import { desktopShellLocation, isPhoneUserAgent, mobileEntryRedirect } from './mobile-entry'

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const androidPhone =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'
const androidTablet =
  'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
const ipad =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'

describe('isPhoneUserAgent', () => {
  it('matches phones and nothing else', () => {
    expect(isPhoneUserAgent(iphone)).toBe(true)
    expect(isPhoneUserAgent(androidPhone)).toBe(true)
    // An Android tablet has no `Mobile` token — the vite front door used to
    // match a bare `Android` and send it to the phone app (POD-359).
    expect(isPhoneUserAgent(androidTablet)).toBe(false)
    expect(isPhoneUserAgent(ipad)).toBe(false)
    expect(isPhoneUserAgent(mac)).toBe(false)
    expect(isPhoneUserAgent(undefined)).toBe(false)
  })
})

describe('mobileEntryRedirect', () => {
  const at = (pathname: string, search: string, userAgent = iphone, mobilePresent = true) =>
    mobileEntryRedirect({ pathname, search, userAgent, mobilePresent })

  it('sends a phone at the root to the Expo app, query intact', () => {
    expect(at('/', '')).toBe('/mobile')
    expect(at('/', '?server=wss://x&e2e=1')).toBe('/mobile?server=wss://x&e2e=1')
  })

  it('stays put for deep links, ?desktop, non-phones, and a missing Expo build', () => {
    expect(at('/session/s1', '')).toBeNull()
    expect(at('/', '?desktop=1')).toBeNull()
    expect(at('/', '?server=wss://x&desktop=1')).toBeNull()
    expect(at('/', '', mac)).toBeNull()
    expect(at('/', '', iphone, false)).toBeNull()
  })

  /**
   * The `?desktop` check used to be `new URLSearchParams(search).has(...)`, an
   * ambient global that made L0 model unbuildable under a lean lib (POD-1124).
   * The replacement has to keep every reading URLSearchParams gave it.
   */
  it('reads ?desktop the way URLSearchParams did', () => {
    // A bare valueless key counts as present.
    expect(at('/', '?desktop')).toBeNull()
    expect(at('/', '?e2e=1&desktop')).toBeNull()
    expect(at('/', '?desktop=')).toBeNull()
    // Keys are percent-decoded before the comparison, as URLSearchParams does.
    expect(at('/', '?%64esktop=1')).toBeNull()
    expect(at('/', '?%20desktop=1')).toBe('/mobile?%20desktop=1')
    // A search string with no leading `?`, as a caller may pass it.
    expect(at('/', 'desktop=1')).toBeNull()
    // Near-misses are not the marker.
    expect(at('/', '?desktops=1')).toBe('/mobile?desktops=1')
    expect(at('/', '?nodesktop=1')).toBe('/mobile?nodesktop=1')
    expect(at('/', '?x=desktop')).toBe('/mobile?x=desktop')
    // Only the KEY side is inspected, even when the value contains `=`.
    expect(at('/', '?x=a=desktop')).toBe('/mobile?x=a=desktop')
    // Empty segments and a malformed escape must not throw.
    expect(at('/', '?&&e2e=1')).toBe('/mobile?&&e2e=1')
    expect(at('/', '?%ZZ=1')).toBe('/mobile?%ZZ=1')
    expect(at('/', '?%ZZ=1&desktop=1')).toBeNull()
  })
})

describe('desktopShellLocation', () => {
  it('marks the root so the phone redirect is suppressed once', () => {
    expect(desktopShellLocation('')).toBe('/?desktop=1')
    // Raw append, so wss:// keeps its slashes rather than being percent-encoded.
    expect(desktopShellLocation('?server=wss://x&e2e=1')).toBe('/?server=wss://x&e2e=1&desktop=1')
  })

  it('does not stack a second marker on a query that already has one', () => {
    expect(desktopShellLocation('?desktop=1')).toBe('/?desktop=1')
    expect(desktopShellLocation('?e2e=1&desktop=1')).toBe('/?e2e=1&desktop=1')
    // A bare valueless marker is already a marker (POD-1124).
    expect(desktopShellLocation('?desktop')).toBe('/?desktop')
  })

  it('produces a location the redirect declines, so the two cannot loop', () => {
    const landing = new URL(desktopShellLocation('?server=wss://x'), 'http://podium.local')
    expect(
      mobileEntryRedirect({
        pathname: landing.pathname,
        search: landing.search,
        userAgent: iphone,
        mobilePresent: true,
      }),
    ).toBeNull()
  })
})
