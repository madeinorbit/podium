/** Historical corpus time notifications feed only its explicit manual clock. */
import { createWorklistPool as createPool } from '@podium/client-graph/create'
export type { WorklistPoolHandle } from '@podium/client-graph/create'

export function createWorklistPool(...args: Parameters<typeof createPool>) {
  const handle = createPool(...args)
  const locals = args[1]
  const stopClock = locals.subscribe(keys => {
    const stamp = locals.get().coarseNow
    if (keys.has('coarseNow') && stamp !== undefined) handle.pool.clock.advance(stamp)
  })
  return { pool: handle.pool, dispose() { stopClock(); handle.dispose() } }
}
