import { type ClientRuntime, loadingNavigationProvider } from '@podium/client-core/engine'
import type { PoolScreen } from './host'
import { NAVIGATION_SUMMARIES } from './navigation-schema'

const generations = new WeakMap<ClientRuntime, object>()

/** Keep runtime navigation addressed even while the phone pool imports. */
export const navigationPoolScreen: PoolScreen = {
  id: 'navigation',
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
  options: () => ({ summaries: NAVIGATION_SUMMARIES }),
  async attach(runtime, pool) {
    const generation = generations.get(runtime)
    const { createPoolNavigationProvider } = await import('./navigation-provider')
    if (!generation || generations.get(runtime) !== generation || runtime.isDestroyed) return
    runtime.setNavigationProvider(createPoolNavigationProvider(pool))
    return () => {
      if (generations.get(runtime) === generation)
        runtime.setNavigationProvider(loadingNavigationProvider)
    }
  },
}
