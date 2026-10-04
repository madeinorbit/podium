import { createPoolHost } from '@podium/client-graph/host'
import { poolBackedScreens } from './pool-screens'

/** The web's pool host: the shared host over this app's screen list. */
const host = createPoolHost({
  screens: poolBackedScreens,
  dev: import.meta.env.DEV,
})

/** StoreProvider owns this teardown, including while the import is in flight. */
export const attachWorklistPool = host.attach
/** The real sidebar's data hook. null is the initial import/loading state. */
export const useWorklistPool = host.usePool
/** Layout-only pool subscription for companions on their current component tree. */
export const useWorklistPoolProjection = host.usePoolProjection
/** Force GC between turns, then check retired generations. */
export const worklistPoolSurvivors = host.survivors
