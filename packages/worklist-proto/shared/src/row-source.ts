import { createRowSource as createSource, type RowSourceHandle, type RowSourceRuntime, type RowSourceReplica, type RowSourceRepaint } from '@podium/client-graph/shared/row-source'
import { createRuntimeTransactions } from '@podium/client-graph/runtime-pool'
import type { ClientRuntime } from '@podium/client-core/engine'
export type { RowSourceHandle }
export function createRowSource(runtime: RowSourceRuntime, replica: RowSourceReplica, options: { mode: import('@podium/client-graph/shared/row-source').RowSourceMode; pending?: import('@podium/client-graph/shared/row-source').PooledPending; owned?: ReadonlySet<import('@podium/client-graph/shared/row-source').PoolOwnedKind> } = { mode: 'truth' }): RowSourceHandle & RowSourceRepaint {
  if (options?.mode !== 'pooled' || options.pending) return createSource(runtime, replica, options as Parameters<typeof createSource>[2])
  const owner = runtime as ClientRuntime
  const log = createRuntimeTransactions(owner)
  const rows = createSource(runtime, replica, { mode: 'pooled', pending: log.pending, owned: new Set(['issue', 'session']) })
  log.bind(rows)
  const stop = owner.attachPoolWriter(log)
  return { ...rows, dispose() { stop(); log.dispose(); rows.dispose() } }
}
