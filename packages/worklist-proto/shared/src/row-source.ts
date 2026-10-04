import { createRowSource as createSource, type RowSourceHandle, type RowSourceRuntime, type RowSourceReplica } from '@podium/client-graph/shared/row-source'
import { createRuntimeTransactions } from '@podium/client-graph/runtime-pool'
import type { ClientRuntime } from '@podium/client-core/engine'
export type { RowSourceHandle }
export function createRowSource(runtime: RowSourceRuntime, replica: RowSourceReplica, options: Parameters<typeof createSource>[2] = { mode: 'truth' }): RowSourceHandle {
  if (options?.mode !== 'pooled' || options.pending) return createSource(runtime, replica, options)
  const owner = runtime as ClientRuntime
  const log = createRuntimeTransactions(owner)
  const rows = createSource(runtime, replica, { mode: 'pooled', pending: log.pending, owned: new Set(['issue', 'session']) })
  log.bind(rows)
  const stop = owner.attachPoolWriter(log)
  return { ...rows, dispose() { stop(); log.dispose(); rows.dispose() } }
}
