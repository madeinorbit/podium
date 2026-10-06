/** Read-only fixture composition. Production always owns its transaction writer. */
import { createWorklistPool } from '@podium/client-graph/create'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import type { WorklistRuntime } from '@podium/client-graph/runtime-pool'
import type { PoolSummaryFields } from '@podium/client-graph/source-registry'
import { EMPTY_PENDING } from './row-source'

export function createReadOnlyRuntimePool(runtime: WorklistRuntime, summaries: PoolSummaryFields) {
  const rows = createRowSource(runtime, runtime.replica, { pending: EMPTY_PENDING })
  const locals = createEngineLocals(runtime)
  try {
    const handle = createWorklistPool({
    ...rows.source,
    ...(rows.source.issueIdsByRef ? { issueIdByRef: (ref: string) => rows.source.issueIdsByRef!(ref)[0] } : {}),
    subscribe: listener => rows.source.subscribe(listener),
  }, locals.source, { summaries, worklist: 'demand' })
    return { pool: handle.pool, dispose() {
      try { handle.dispose() } finally {
        try { locals.dispose() } finally { rows.dispose() }
      }
    } }
  } catch (error) {
    try { locals.dispose() } finally { rows.dispose() }
    throw error
  }
}
