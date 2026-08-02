import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

describe('SessionRegistry model catalog wiring', () => {
  it('defaults to an empty catalog and never shells out when no probe is injected', () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const machineId = registry.sessionStore.hostMachineId
    // No modelProbe → empty snapshot, and get() must not throw (default no-op probe).
    expect(registry.modules.settings.getModelCatalog(machineId)).toEqual({
      machineId,
      byAgent: {},
      fetchedAt: 0,
    })
    registry.dispose()
  })

  it('serves the injected probe result via refreshModelCatalog + getModelCatalog', async () => {
    const modelProbe = vi.fn(async () => ({
      grok: [{ value: 'grok-build', label: 'grok-build' }],
      cursor: [{ value: 'composer-2.5', label: 'Composer 2.5' }],
    }))
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default', modelProbe })
    const machineId = registry.sessionStore.hostMachineId
    const snapshot = await registry.modules.settings.refreshModelCatalog(machineId)
    expect(snapshot.machineId).toBe(machineId)
    expect(snapshot.byAgent.grok?.[0]?.value).toBe('grok-build')
    expect(registry.modules.settings.getModelCatalog(machineId).byAgent.cursor?.[0]?.value).toBe(
      'composer-2.5',
    )
    expect(modelProbe).toHaveBeenCalledWith(machineId)
    expect(modelProbe).toHaveBeenCalledTimes(1)
    registry.dispose()
  })

  it('persists the catalog so a restart serves it instantly without re-probing', async () => {
    const store = new SessionStore(':memory:')
    const machineId = store.hostMachineId
    const probe = vi.fn(async () => ({ grok: [{ value: 'grok-build', label: 'grok-build' }] }))

    // First "boot": probe once, which persists to the shared store under this machine.
    const first = new SessionRegistry(store, undefined, { instanceId: 'default', modelProbe: probe })
    await first.modules.settings.refreshModelCatalog(machineId)
    first.dispose()

    // Second "boot" (same DB): the catalog is served from persistence immediately —
    // get() returns it with no additional probe on the fresh registry.
    const probe2 = vi.fn(async () => ({}))
    const second = new SessionRegistry(store, undefined, {
      instanceId: 'default',
      modelProbe: probe2,
    })
    expect(second.modules.settings.getModelCatalog(machineId).byAgent.grok?.[0]?.value).toBe(
      'grok-build',
    )
    second.dispose()
  })

  it('does not serve one machine’s catalog under another machineId', async () => {
    const store = new SessionStore(':memory:')
    const host = store.hostMachineId
    const other = 'other-machine'
    const probe = vi.fn(async (machineId: string) =>
      machineId === host
        ? { grok: [{ value: 'host-model', label: 'host-model' }] }
        : { grok: [{ value: 'other-model', label: 'other-model' }] },
    )
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default', modelProbe: probe })
    await registry.modules.settings.refreshModelCatalog(host)
    await registry.modules.settings.refreshModelCatalog(other)
    expect(registry.modules.settings.getModelCatalog(host).byAgent.grok?.[0]?.value).toBe(
      'host-model',
    )
    expect(registry.modules.settings.getModelCatalog(other).byAgent.grok?.[0]?.value).toBe(
      'other-model',
    )
    registry.dispose()
  })
})
