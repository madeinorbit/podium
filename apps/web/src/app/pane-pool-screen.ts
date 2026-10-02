import { type ClientRuntime, loadingNavigationProvider } from '@podium/client-core/engine'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { initializePaneDataLayer, paneDataLayer } from '@/lib/pane-data-layer'
import type { PoolScreen } from './pool-screen-registry'

const generations = new WeakMap<ClientRuntime, object>()

export const panePoolScreen: PoolScreen = {
  id: 'pane',
  initialize: initializePaneDataLayer,
  enabled: () => paneDataLayer() === 'pool',
  prepare(runtime) {
    const generation = {}
    generations.set(runtime, generation)
    runtime.setNavigationProvider(loadingNavigationProvider)
    return () => {
      if (generations.get(runtime) !== generation) return
      generations.delete(runtime)
      runtime.setNavigationProvider(loadingNavigationProvider)
    }
  },
  options: () => ({ summaries: MISSION_SUMMARIES }),
  async attach(runtime, pool) {
    const generation = generations.get(runtime)
    const { createPoolNavigationProvider } = await import('./pool-navigation-provider')
    if (!generation || generations.get(runtime) !== generation || runtime.isDestroyed) return
    runtime.setNavigationProvider(createPoolNavigationProvider(pool))
    return () => {
      if (generations.get(runtime) === generation) runtime.setNavigationProvider(loadingNavigationProvider)
    }
  },
}
