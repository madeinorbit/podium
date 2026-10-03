/** Component-fixture writer over the same cache/event boundary as the kernel.
 * Only tests seed metadata this way; production facade write refusal stays intact. */
import {
  createKernelReplica, createSideCache, entityForKind, rowKey, memoryStorage,
  type Replica, type ReplicaKind, type ReplicaRows,
} from '@podium/client-core/replica'
import type { EntityRecord } from '@podium/sync/replica'

export function createMobileTestReplica(): Replica {
  const records = new Map<string, EntityRecord>()
  let seq = 0
  const key = (entity: string, id: string) => `${entity}:${id}`
  const replica = createKernelReplica({ cache: {
    readCursor: () => seq ? { seq } : null, readEntities: () => [...records.values()],
    read: (entity, id) => records.get(key(entity, id)), durability: () => 'degraded-memory',
  }, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  function applyChanges<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][], removed: string[]) {
    const entity = entityForKind(kind)
    replica.batch(() => {
      for (const id of removed) {
        if (!records.delete(key(entity, id))) continue
        replica.onKernelEvent({ type: 'removed', entity, entityId: id })
      }
      for (const value of rows) {
        const entityId = rowKey(kind, value), address = key(entity, entityId)
        if (records.get(address)?.value === value) continue
        const record = { entity, entityId, value, provenance: { seq: ++seq } }
        records.set(address, record)
        replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
      }
    })
  }
  return Object.assign(replica, {
    applyChanges,
    applySnapshot<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]) {
      const entity = entityForKind(kind), keep = new Set(rows.map(row => rowKey(kind, row)))
      const removed = [...records.values()].filter(row => row.entity === entity && !keep.has(row.entityId)).map(row => row.entityId)
      applyChanges(kind, rows, removed)
    },
  })
}
