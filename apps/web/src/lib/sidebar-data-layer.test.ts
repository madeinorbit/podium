import { MOBX_SIDEBAR_KEY, uiStateRoute } from '@podium/client-core/ui-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({
  get: vi.fn((key: string) => (key === MOBX_SIDEBAR_KEY ? value : null)),
})

beforeEach(() => {
  vi.resetModules()
  history.replaceState(null, '', '/')
})
afterEach(() => history.replaceState(null, '', '/'))

describe('sidebar startup data layer', () => {
  it.each([
    ['', '1', 'pool'],
    ['?mobxSidebar=0', '1', 'legacy'],
    ['?mobxSidebar=1', '0', 'pool'],
  ] as const)('uses the shared MobX pilot setting with URL precedence: %s', async (query, setting, expected) => {
    history.replaceState(null, '', `/${query}`)
    const mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(stored(setting))
    expect(mode.sidebarDataLayer()).toBe(expected)
    expect(mode.sidebarCheckRequested()).toBe(false)
  })

  it.each([
    ['', false], ['?mobxSidebarCheck=1', false], ['?mobxSidebar=0&mobxSidebarCheck=1', false],
    ['?mobxSidebar=1', false], ['?mobxSidebar=1&mobxSidebarCheck=0', false], ['?mobxSidebar=1&mobxSidebarCheck=1', true],
  ])('freezes both diagnostic opt-ins at startup: %s', async (query, expected) => {
    const mode = await import('./sidebar-data-layer')
    history.replaceState(null, '', `/${query}`)
    mode.initializeSidebarDataLayer(stored(null))
    expect(mode.sidebarCheckRequested()).toBe(expected)
    history.replaceState(null, '', expected ? '/' : '/?mobxSidebar=1&mobxSidebarCheck=1')
    mode.initializeSidebarDataLayer(stored('1'))
    expect(mode.sidebarCheckRequested()).toBe(expected)
  })
  it('defaults to legacy and reads the declared device-local key once', async () => {
    const mode = await import('./sidebar-data-layer')
    const ui = stored(null)
    expect(uiStateRoute(MOBX_SIDEBAR_KEY).home).toBe('device-local')
    mode.initializeSidebarDataLayer(ui)
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')
    expect(ui.get).toHaveBeenCalledExactlyOnceWith(MOBX_SIDEBAR_KEY)
  })

  it('only opts in through the persisted debug flag value', async () => {
    for (const [value, expected] of [
      [null, 'legacy'],
      ['0', 'legacy'],
      ['true', 'legacy'],
      ['garbage', 'legacy'],
      ['1', 'pool'],
    ] as const) {
      vi.resetModules()
      const mode = await import('./sidebar-data-layer')
      mode.initializeSidebarDataLayer(stored(value))
      expect(mode.sidebarDataLayer(), String(value)).toBe(expected)
    }
  })

  it('URL on and off override the opposite stored value without writing it', async () => {
    for (const [value, preference, expected] of [
      ['1', '0', 'pool'],
      ['0', '1', 'legacy'],
      ['true', '0', 'pool'],
      ['false', '1', 'legacy'],
    ] as const) {
      vi.resetModules()
      history.replaceState(null, '', `/?mobxSidebar=${value}`)
      const mode = await import('./sidebar-data-layer')
      const ui = stored(preference)
      mode.initializeSidebarDataLayer(ui)
      expect(mode.sidebarDataLayer(), value).toBe(expected)
      expect(ui.get).not.toHaveBeenCalled()
    }
  })

  it('falls back to the stored flag for an absent or invalid URL override', async () => {
    for (const query of ['', '?mobxSidebar=', '?mobxSidebar=garbage', '?other=1']) {
      for (const [preference, expected] of [
        ['0', 'legacy'],
        ['1', 'pool'],
      ] as const) {
        vi.resetModules()
        history.replaceState(null, '', `/${query}`)
        const mode = await import('./sidebar-data-layer')
        mode.initializeSidebarDataLayer(stored(preference))
        expect(mode.sidebarDataLayer(), query).toBe(expected)
      }
    }
  })

  it('ignores preference changes for the session and applies them after reload in both directions', async () => {
    const values = new Map<string, string>()
    const ui = { get: vi.fn((key: string) => values.get(key) ?? null) }
    let mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')

    values.set(MOBX_SIDEBAR_KEY, '1')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')
    expect(ui.get).toHaveBeenCalledTimes(1)

    vi.resetModules() // A reload creates a new app module lifetime.
    mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('pool')

    values.set(MOBX_SIDEBAR_KEY, '0')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('pool')
    expect(ui.get).toHaveBeenCalledTimes(2)

    vi.resetModules()
    mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')
  })

  it('ignores URL changes after boot until reload', async () => {
    const ui = stored('1')
    history.replaceState(null, '', '/?mobxSidebar=0')
    let mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')

    history.replaceState(null, '', '/?mobxSidebar=1')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('legacy')

    vi.resetModules()
    mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(ui)
    expect(mode.sidebarDataLayer()).toBe('pool')
    expect(ui.get).not.toHaveBeenCalled()
  })

  it('keeps the startup mode through a principal/provider rebuild', async () => {
    const firstPrincipal = stored('0')
    const secondPrincipal = stored('1')
    let mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(firstPrincipal)
    mode.initializeSidebarDataLayer(secondPrincipal)
    expect(mode.sidebarDataLayer()).toBe('legacy')
    expect(secondPrincipal.get).not.toHaveBeenCalled()

    vi.resetModules()
    mode = await import('./sidebar-data-layer')
    mode.initializeSidebarDataLayer(secondPrincipal)
    expect(mode.sidebarDataLayer()).toBe('pool')
  })
})
