import { type ClientRuntime, loadingNavigationProvider } from '@podium/client-core/engine'
import type { PoolScreen } from '@podium/client-graph/host'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'

const generations = new WeakMap<ClientRuntime, object>()

export const NAVIGATION_SUMMARIES = {
  issue: [...MISSION_SUMMARIES.issue, 'id', 'updatedAt', 'worktreePath'],
  session: ['displayRef', 'lastActiveAt'],
} as const

export const panePoolScreen: PoolScreen = {
  id: 'pane',
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
    const { createPoolNavigationProvider } = await import('./pool-navigation-provider')
    if (!generation || generations.get(runtime) !== generation || runtime.isDestroyed) return
    runtime.setNavigationProvider(createPoolNavigationProvider(pool))
    return () => {
      if (generations.get(runtime) === generation)
        runtime.setNavigationProvider(loadingNavigationProvider)
    }
  },
}
