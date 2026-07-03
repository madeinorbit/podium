import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'

describe('SessionRegistry model catalog wiring', () => {
  it('defaults to an empty catalog and never shells out when no probe is injected', () => {
    const registry = new SessionRegistry()
    // No modelProbe → empty snapshot, and get() must not throw (default no-op probe).
    expect(registry.getModelCatalog()).toEqual({ byAgent: {}, fetchedAt: 0 })
    registry.dispose()
  })

  it('serves the injected probe result via refreshModelCatalog + getModelCatalog', async () => {
    const modelProbe = vi.fn(async () => ({
      grok: [{ value: 'grok-build', label: 'grok-build' }],
      cursor: [{ value: 'composer-2.5', label: 'Composer 2.5' }],
    }))
    const registry = new SessionRegistry(undefined, undefined, { modelProbe })
    const snapshot = await registry.refreshModelCatalog()
    expect(snapshot.byAgent.grok?.[0]?.value).toBe('grok-build')
    expect(registry.getModelCatalog().byAgent.cursor?.[0]?.value).toBe('composer-2.5')
    expect(modelProbe).toHaveBeenCalledTimes(1)
    registry.dispose()
  })
})
