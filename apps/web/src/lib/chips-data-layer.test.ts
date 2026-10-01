import { describe, expect, it, vi } from 'vitest'

describe('chip startup choice', () => {
  it('defaults off, supports independent override, and stays fixed until reload', async () => {
    for (const [query, setting, expected] of [
      ['', null, 'legacy'], ['?mobxSidebar=1', null, 'legacy'], ['?mobxChips=1&mobxChipsCheck=1', null, 'pool'],
      ['?mobxChips=0', '1', 'legacy'], ['', '1', 'pool'],
    ] as const) {
      vi.resetModules()
      vi.stubGlobal('location', { search: query })
      const m = await import('./chips-data-layer')
      m.initializeChipsDataLayer({ get: () => setting })
      expect(m.chipsDataLayer()).toBe(expected)
      expect(m.chipsCheckRequested()).toBe(query.includes('mobxChipsCheck=1'))
      vi.stubGlobal('location', { search: expected === 'pool' ? '?mobxChips=0' : '?mobxChips=1' })
      m.initializeChipsDataLayer({ get: () => expected === 'pool' ? null : '1' })
      expect(m.chipsDataLayer()).toBe(expected)
    }
    vi.unstubAllGlobals()
  })
})
