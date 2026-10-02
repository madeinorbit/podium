import type { ClientRuntime } from '@podium/client-core/engine'
import { chipCheckFor, chipPerf } from '@podium/client-core/perf'
import { createPoolHost } from '@podium/client-graph/host'
import { sidebarDataLayer } from '@/lib/sidebar-data-layer'
import { chipsPerfRequested } from '@/lib/chips-data-layer'
import { poolBackedScreens } from './pool-screens'

/** TEMPORARY with the chip switch: the ?chipsPerf=1 census measures chips on
 * either data layer, so it runs with or without an enabled pool screen. */
function installChipCensus(runtime: ClientRuntime): () => void {
  if (!chipsPerfRequested() || typeof window === 'undefined') return () => {}
  chipPerf.enable()
  const owner = new WeakRef(runtime)
  const census = { reset: chipPerf.reset,
    read: () => { const current = owner.deref(); return current ? chipPerf.read(current) : null },
    check: () => { const current = owner.deref(); return current ? chipCheckFor(current) : null },
  }
  Object.assign(window, { __chipPerf: census })
  return () => { if (Reflect.get(window, '__chipPerf') === census) Reflect.deleteProperty(window, '__chipPerf') }
}

/** The web's pool host: the shared host over this app's screen list. */
const host = createPoolHost({
  screens: poolBackedScreens,
  dev: import.meta.env.DEV,
  start(runtime) {
    if (sidebarDataLayer() === 'pool') runtime.enablePoolRuntimeWork?.()
    return installChipCensus(runtime)
  },
})

/** StoreProvider owns this teardown, including while the import is in flight. */
export const attachWorklistPool = host.attach
/** The real sidebar's data hook. null is the initial import/loading state. */
export const useWorklistPool = host.usePool
/** Layout-only pool subscription for companions on their current component tree. */
export const useWorklistPoolProjection = host.usePoolProjection
/** Force GC between turns, then check retired generations. */
export const worklistPoolSurvivors = host.survivors
