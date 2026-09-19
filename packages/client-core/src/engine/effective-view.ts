import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { rowKey } from '../replica/kernel/kinds'
import type { EffectiveLocalState, EffectiveReadView } from './effective-changes'
import type { ReplicaBindingSnapshot } from './replica-binding'
import type { EngineState } from './state'

const paintedKinds = new Set<ReplicaKind>([
  'sessions', 'issues', 'issueProjections', 'issueEvents', 'pendingInteractions',
  'shipOrders', 'conversations', 'automations', 'automationRuns',
])

/** Borrow immutable arrays from the existing completed Store/replica snapshots.
 * No diff, overlay fold or retirement lives here. Lazy lookup indexing is still
 * O(collection); measure it separately, never describe this view as O(delta).
 * The pilot is opt-in and legacy consumers still own/materialise these arrays. */
export function effectiveView(
  snapshot: EngineState,
  replica: ReplicaBindingSnapshot,
  measure?: (kind: ReplicaKind, rows: number) => void,
): EffectiveReadView {
  const indexes = new Map<ReplicaKind, Map<string, object>>()
  function index(kind: ReplicaKind): Map<string, object> {
    let result = indexes.get(kind)
    if (result) return result
    const rows = (paintedKinds.has(kind)
      ? snapshot[kind as keyof EngineState]
      : replica[kind]) as readonly object[]
    result = new Map()
    for (const row of rows) {
      const id = rowKey(kind, row as ReplicaRows[typeof kind])
      if (!result.has(id)) result.set(id, row)
    }
    indexes.set(kind, result)
    measure?.(kind, rows.length)
    return result
  }
  return {
    commit: snapshot,
    row: <K extends ReplicaKind>(kind: K, id: string) => index(kind).get(id) as Readonly<ReplicaRows[K]> | undefined,
    ids: (kind) => [...index(kind).keys()],
    local: (key) => snapshot[key] as EffectiveLocalState[typeof key],
  }
}
