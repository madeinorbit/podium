/** Kernel-backed fixture for engine and UI tests. Entity writes belong only to this fixture. */
import type { EntityRecord } from '@podium/sync/replica'
import { memoryStorage, type ReplicaKind, type ReplicaRows } from '../src/replica/contract'
import { createKernelReplica, createSideCache, entityForKind, rowKey } from '../src/replica/kernel'
import { COLD_CURSOR, type FeedCursor } from '../src/replica/feed'

export type ReplicaFixtureOptions = Partial<Parameters<typeof createSideCache>[0]>
export { memoryStorage }

export function createReplicaFixture(options: ReplicaFixtureOptions = {}) {
  const records = new Map<string, EntityRecord>()
  let cursor: { seq: number; feedId?: string; epoch?: string } | null = null
  const replica = createKernelReplica({
    cache: {
      readCursor: () => cursor,
      readEntities: () => [...records.values()],
      read: (entity, entityId) => records.get(`${entity}:${entityId}`),
      durability: () => 'durable',
    },
    side: createSideCache({ ...options, storage: options.storage ?? memoryStorage() }),
  })
  const replace = () => replica.onKernelEvent({
    type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: cursor?.seq ?? 0,
    entityCount: records.size, bufferedFramesApplied: 0,
  })
  const put = <K extends ReplicaKind>(kind: K, value: ReplicaRows[K]) => {
    const entity = entityForKind(kind)
    const entityId = rowKey(kind, value)
    const record = { entity, entityId, value, provenance: { seq: cursor?.seq ?? 0 } }
    records.set(`${entity}:${entityId}`, record)
    return record
  }
  Object.assign(replica, {
    applySnapshot<K extends ReplicaKind>(kind: K, values: ReplicaRows[K][]) {
      const entity = entityForKind(kind)
      for (const [key, record] of records) if (record.entity === entity) records.delete(key)
      for (const value of values) put(kind, value)
      replace()
    },
    applyChanges<K extends ReplicaKind>(kind: K, values: ReplicaRows[K][], removeIds: string[]) {
      const entity = entityForKind(kind)
      for (const entityId of removeIds) {
        records.delete(`${entity}:${entityId}`)
        replica.onKernelEvent({ type: 'removed', entity, entityId })
      }
      for (const value of values)
        replica.onKernelEvent({ type: 'upserted', record: put(kind, value), readmitted: false })
    },
    // Wire-v1 tests own feed identity; the product read facade exposes only seq.
    getFeedCursor(): FeedCursor {
      return cursor === null ? COLD_CURSOR : {
        feedId: cursor.feedId ?? null, epoch: cursor.epoch ?? null, seq: cursor.seq,
      }
    },
    setCursor(seq: number) { cursor = { ...cursor, seq } },
    setFeedCursor(next: FeedCursor) {
      cursor = next.seq === null ? null : {
        ...(next.feedId === null ? {} : { feedId: next.feedId }),
        ...(next.epoch === null ? {} : { epoch: next.epoch }), seq: next.seq,
      }
    },
    resetCache() { cursor = null; records.clear(); replace() },
  })
  return replica
}
