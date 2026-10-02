import { MOBX_CHIPS_KEY, MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('chip startup choice', () => {
  it('uses the shared MobX pilot setting with URL precedence and stays fixed until reload', async () => {
    for (const [query, setting, expected] of [
      ['', null, 'legacy'],
      ['?mobxSidebar=1', null, 'legacy'],
      ['?mobxChips=1&mobxChipsCheck=1', null, 'pool'],
      ['?mobxChips=0', '1', 'legacy'],
      ['?mobxChips=1', '0', 'pool'],
      ['', '1', 'pool'],
    ] as const) {
      vi.resetModules()
      vi.stubGlobal('location', { search: query })
      const m = await import('./chips-data-layer')
      m.initializeChipsDataLayer({ get: (key) => key === MOBX_SIDEBAR_KEY ? setting : null })
      expect(m.chipsDataLayer()).toBe(expected)
      expect(m.chipsCheckRequested()).toBe(query.includes('mobxChipsCheck=1'))
      vi.stubGlobal('location', { search: expected === 'pool' ? '?mobxChips=0' : '?mobxChips=1' })
      m.initializeChipsDataLayer({ get: () => (expected === 'pool' ? null : '1') })
      expect(m.chipsDataLayer()).toBe(expected)
    }
  })

  it('does not opt in through the retired chips-only device setting', async () => {
    vi.stubGlobal('location', { search: '' })
    const mode = await import('./chips-data-layer')
    mode.initializeChipsDataLayer({ get: (key) => key === MOBX_CHIPS_KEY ? '1' : null })
    expect(mode.chipsDataLayer()).toBe('legacy')
  })
})
