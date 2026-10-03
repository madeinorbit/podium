import { createPoolHost } from '@podium/client-graph/host'
import { initializePoolTransactions, poolTransactionsEnabled } from '@/lib/pool-transactions-switch'
import { poolBackedScreens } from './pool-screens'

/** The web's pool host: the shared host over this app's screen list. */
const host = createPoolHost({
  screens: poolBackedScreens,
  dev: import.meta.env.DEV,
  start(runtime) {
    runtime.enablePoolRuntimeWork?.()
    if (runtime.ui) initializePoolTransactions(runtime.ui)
  },
  options: () => (poolTransactionsEnabled() ? { transactions: true } : {}),
})

/** StoreProvider owns this teardown, including while the import is in flight. */
export const attachWorklistPool = host.attach
/** The real sidebar's data hook. null is the initial import/loading state. */
export const useWorklistPool = host.usePool
/** Layout-only pool subscription for companions on their current component tree. */
export const useWorklistPoolProjection = host.usePoolProjection
/** Force GC between turns, then check retired generations. */
export const worklistPoolSurvivors = host.survivors
