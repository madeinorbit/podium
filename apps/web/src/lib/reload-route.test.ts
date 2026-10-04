import { describe, expect, it, vi } from 'vitest'
import { NAVIGATION_FALLBACK_DENYLIST } from '../../mobile-routing'
import { freshInterfaceUrl, restoreReloadRoute } from './reload-route'

describe('fresh interface recovery route', () => {
  it('bypasses old worker caches and restores the exact workspace URL', () => {
    const original = 'https://podium.test/workspace?wt=%2Frepo&pane=unsent#draft'
    const fresh = new URL(freshInterfaceUrl(original))
    expect(
      NAVIGATION_FALLBACK_DENYLIST.some((rule) => rule.test(fresh.pathname + fresh.search)),
    ).toBe(true)
    const replaceState = vi.fn()
    restoreReloadRoute({
      location: { href: fresh.href },
      history: { state: { retained: true }, replaceState },
    } as unknown as Pick<Window, 'location' | 'history'>)
    expect(replaceState).toHaveBeenCalledWith(
      { retained: true },
      '',
      '/workspace?wt=%2Frepo&pane=unsent#draft',
    )
  })

  it('refuses a supplied foreign destination', () => {
    const replaceState = vi.fn()
    restoreReloadRoute({
      location: { href: 'https://podium.test/?__podium_reload_route=https%3A%2F%2Fforeign.test' },
      history: { state: null, replaceState },
    } as unknown as Pick<Window, 'location' | 'history'>)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
  })
})
