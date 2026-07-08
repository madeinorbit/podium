/**
 * React live-query over one replica collection: the rows re-render on every
 * collection change — the store derives its entity arrays from this instead of
 * mirroring hub events into useState. The replica is ALWAYS live (in-memory in
 * private browsing), so this is the one entity read path. Split from the engine
 * so non-React consumers of the replica never load @tanstack/react-db.
 */

import type { Collection } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { Replica, ReplicaKind, ReplicaRows } from './replica'

const EMPTY_ROWS: never[] = []

export function useReplicaRows<K extends ReplicaKind>(replica: Replica, kind: K): ReplicaRows[K][] {
  const { data } = useLiveQuery(
    () =>
      // biome-ignore lint/suspicious/noExplicitAny: adapter-internal cast from the untyped collection seam
      replica.collection(kind) as Collection<ReplicaRows[K], string, any>,
    [replica, kind],
  )
  // Stable empty identity so downstream memos don't churn pre-hydrate.
  return data === undefined || data.length === 0 ? EMPTY_ROWS : (data as ReplicaRows[K][])
}
