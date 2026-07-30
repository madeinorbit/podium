// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mobileRedirectLocation } from '../mobile-routing'

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'

describe('Vite mobile entry routing', () => {
  it('redirects a phone root request to the Expo app and preserves its query', () => {
    expect(mobileRedirectLocation('/?server=wss://x&e2e=1', iphone, true)).toBe(
      '/mobile?server=wss://x&e2e=1',
    )
  })

  it('does not redirect when mobile is unavailable or desktop was requested', () => {
    expect(mobileRedirectLocation('/', iphone, false)).toBeNull()
    expect(mobileRedirectLocation('/?desktop=1', iphone, true)).toBeNull()
  })

  it('leaves desktop, tablet, and deep-link requests alone', () => {
    expect(mobileRedirectLocation('/', 'Mozilla/5.0 (Macintosh) Safari/605.1.15', true)).toBeNull()
    expect(mobileRedirectLocation('/', 'Mozilla/5.0 (iPad) Mobile/15E148', true)).toBeNull()
    expect(
      mobileRedirectLocation('/', 'Mozilla/5.0 (Linux; Android 13; SM-X700) Safari/537.36', true),
    ).toBeNull()
    expect(mobileRedirectLocation('/session/s1', iphone, true)).toBeNull()
  })
})
