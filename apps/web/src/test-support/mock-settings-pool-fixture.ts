import { vi } from 'vitest'

/** Settings fixtures use the real model pool and retain their existing inputs.
 * The catalogue contains only IDs from the fixture's canonical machine table. */
vi.mock('@/app/store-worklist-pool', async () => {
  const { fixturePoolHooks } = await import('./pool-fixture')
  const { useCallback } = await import('react')
  const prepare = (pool: import('@podium/client-graph').MobxPool) => {
    pool.sources.view('settings.fixtureCatalog', () => {
      pool.sources.register(['settingsCatalog'], {
        read: () => ({ machines: [...pool.tables.machine.keys()], repositories: [] }),
        dispose() {},
      })
      return {}
    })
    return pool
  }
  return {
    useWorklistPool: () => prepare(fixturePoolHooks.useWorklistPool()),
    useWorklistPoolProjection<T>(read: (pool: import('@podium/client-graph').MobxPool) => T, empty: T) {
      const prepared = useCallback((pool: import('@podium/client-graph').MobxPool) => read(prepare(pool)), [read])
      return fixturePoolHooks.useWorklistPoolProjection(prepared, empty)
    },
  }
})
