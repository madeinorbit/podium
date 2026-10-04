/** Standalone harness feeds attach the same transaction writer as the pool host. */
import { createRowSource as createSource, type PooledPending, type PoolOwnedKind,
  type RowSourceHandle, type RowSourceMode, type RowSourceRepaint,
  type RowSourceReplica, type RowSourceRuntime } from '@podium/client-graph/shared/row-source'
import { createRuntimeTransactions } from '@podium/client-graph/runtime-pool'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { PoolTransactions } from '@podium/client-graph/write/transactions'
export type { RowSourceHandle }

interface FixtureInputs extends RowSourceRuntime {
  readonly pending?: PooledPending
  onPending?(changed: () => void): () => void
  owner?: ClientRuntime
}

function followPending(rows: RowSourceRepaint, pending: PooledPending, follow: (changed: () => void) => () => void) {
  let previous = new Set<string>()
  return follow(() => {
    const next = new Set<string>()
    for (const kind of ['sessions', 'sessionUserStates', 'issueProjections', 'issueUserStates'] as const)
      for (const id of pending[kind]?.keys() ?? [])
        next.add(JSON.stringify([kind === 'sessions' || kind === 'sessionUserStates' ? 'session' : 'issue', id]))
    const touched = new Set([...previous, ...next])
    previous = next
    rows.repaint([...touched].map(key => {
      const [kind, id] = JSON.parse(key) as ['issue' | 'session', string]
      return { kind, id }
    }))
  })
}

export function createRowSource(runtime: RowSourceRuntime, replica: RowSourceReplica,
  options: { mode: RowSourceMode; pending?: PooledPending; owned?: ReadonlySet<PoolOwnedKind> } = { mode: 'truth' },
): RowSourceHandle & RowSourceRepaint {
  const fixture = runtime as FixtureInputs
  if (options.pending) return createSource(runtime, replica, options as Parameters<typeof createSource>[2])
  if (fixture.pending) {
    const rows = createSource(runtime, replica, options.mode === 'truth'
      ? { mode: 'truth' } : { mode: 'pooled', pending: fixture.pending })
    const stop = options.mode === 'pooled' && fixture.onPending
      ? followPending(rows, fixture.pending, fixture.onPending) : () => {}
    return { ...rows, dispose() { stop(); rows.dispose() } }
  }
  const owner = fixture.owner ?? runtime as ClientRuntime
  const existing = (owner as unknown as { poolWriter: PoolTransactions | null }).poolWriter
  const log = existing ?? createRuntimeTransactions(owner)
  const rows = createSource(runtime, replica, options.mode === 'truth'
    ? { mode: 'truth' } : { mode: 'pooled', pending: log.pending })
  if (existing) {
    const stop = options.mode === 'pooled'
      ? followPending(rows, log.pending, changed => owner.outbox.subscribe(changed)) : () => {}
    return { ...rows, dispose() { stop(); rows.dispose() } }
  }
  log.bind(rows)
  const stop = owner.attachPoolWriter(log)
  return { ...rows, dispose() { stop(); log.dispose(); rows.dispose() } }
}
