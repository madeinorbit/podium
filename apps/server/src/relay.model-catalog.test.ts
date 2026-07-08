import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

describe('SessionRegistry model catalog wiring', () => {
  it('defaults to an empty catalog and never shells out when no probe is injected', () => {
    const registry = new SessionRegistry()
    // No modelProbe → empty snapshot, and get() must not throw (default no-op probe).
    expect(registry.modules.settings.getModelCatalog()).toEqual({ byAgent: {}, fetchedAt: 0 })
    registry.dispose()
  })

  it('serves the injected probe result via refreshModelCatalog + getModelCatalog', async () => {
    const modelProbe = vi.fn(async () => ({
      grok: [{ value: 'grok-build', label: 'grok-build' }],
      cursor: [{ value: 'composer-2.5', label: 'Composer 2.5' }],
    }))
    const registry = new SessionRegistry(undefined, undefined, { modelProbe })
    const snapshot = await registry.modules.settings.refreshModelCatalog()
    expect(snapshot.byAgent.grok?.[0]?.value).toBe('grok-build')
    expect(registry.modules.settings.getModelCatalog().byAgent.cursor?.[0]?.value).toBe('composer-2.5')
    expect(modelProbe).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('persists the catalog so a restart serves it instantly without re-probing', async () => {
    const store = new SessionStore(':memory:')
    const probe = vi.fn(async () => ({ grok: [{ value: 'grok-build', label: 'grok-build' }] }))

    // First "boot": probe once, which persists to the shared store.
    const first = new SessionRegistry(store, undefined, { modelProbe: probe })
    await first.modules.settings.refreshModelCatalog()
    first.dispose()

    // Second "boot" (same DB): the catalog is served from persistence immediately —
    // get() returns it with no additional probe on the fresh registry.
    const probe2 = vi.fn(async () => ({}))
    const second = new SessionRegistry(store, undefined, { modelProbe: probe2 })
    expect(second.modules.settings.getModelCatalog().byAgent.grok?.[0]?.value).toBe('grok-build')
    second.dispose()
  })
})
