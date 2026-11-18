/** Real replica trim + facade + row source + pool. Measurement fixture only. */
import { InMemoryReplicaStore } from '../../../packages/sync/src/replica/memory-store'
import { Replica } from '../../../packages/sync/src/replica/replica'
import { instanceKey } from '../../../packages/sync/src/replica/cache-state'
import { createKernelReplica } from '../../../packages/client-core/src/replica/kernel/facade'
import { createSideCache } from '../../../packages/client-core/src/replica/kernel/side-cache'
import { createRowSource } from '../../../packages/client-graph/src/shared/row-source'
import { createWorklistPool } from '../../../packages/client-graph/src/create'
import { fixedLocals } from '../../../packages/client-graph/src/shared/locals-source'

window.measureDeviceCache = async ({ rows, policy, instances, now, cap }) => {
  const cache = new InMemoryReplicaStore().viewFor('operator').cache
  const cursor = { feedId: 'measurement', epoch: 'one', seq: 1 }
  cache.applyAtomic({
    operations: rows.map(row => ({ kind: 'upsert', entity: row.entity, entityId: row.entityId, value: row.value,
      provenance: { seq: 1 }, ...(row.part === 'stub' ? { part: 'stub' } : {}) })),
    policy: { ...policy, cacheCap: cap }, cursor,
    instances: instances.map((spec, index) => ({ kind: 'mark', instance: {
      ...spec, key: instanceKey(spec), completeAt: cursor, releasedAt: index + 1,
    } })),
  })
  const replica = new Replica({ store: cache, authority: {}, now: () => now, onEvent: () => {} })
  const trimStart = performance.now()
  await replica.trim()
  const trimMs = performance.now() - trimStart
  const side = createSideCache({ storage: localStorage, adoptLegacyOutbox: false })
  const facade = createKernelReplica({ cache, side, collections: () => replica })
  const source = createRowSource({ principal: { userId: 'operator' } }, facade, { pending: { byRow: () => new Map() } })
  const handle = createWorklistPool(source.source, fixedLocals({ selectedIssueId: null, coarseNow: now }).source, { worklist: 'demand' })
  // Model handles for opened records survive while their cached rows do. No
  // watched view, no extra per-record computed values kept alive artificially.
  for (const row of cache.readEntities()) {
    if (row.entity === 'issueProjection') handle.pool.model('issue', row.entityId)
    if (row.entity === 'session') handle.pool.model('session', row.entityId)
  }
  const result = { cap, trimMs, mainRows: cache.readEntities().length, markers: cache.readInstances().size,
    mainIssues: cache.readEntities().filter(row => row.entity === 'issueProjection').length,
    serializedBytes: JSON.stringify(cache.readEntities()).length }
  window.deviceCacheHandles = { cache, replica, side, facade, source, handle }
  return result
}
