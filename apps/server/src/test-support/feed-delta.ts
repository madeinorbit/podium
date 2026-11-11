import type { MetadataChange, Principal } from '@podium/protocol'
import type { SessionRegistry } from '../relay'

/** Array view of direct Authority reads for publication assertions. Evictions
 * are omitted; this helper checks published rows, not replica eviction behavior. */
export async function feedDelta(registry: SessionRegistry, cursor: number, principal: Principal) {
  const delivery = await registry.changeLedger.authority.changesSince(cursor, principal)
  if (!delivery || delivery.kind !== 'batch') throw new Error('expected a servable delta')
  const changes: MetadataChange[] = []
  for (const change of delivery.changes) {
    if (change.op === 'evict') continue
    changes.push({
      seq: change.seq,
      entity: change.entity,
      id: change.entityId,
      op: change.op,
      ...(change.op === 'upsert' ? { value: change.value } : {}),
    } as MetadataChange)
  }
  return {
    kind: 'delta' as const,
    changes,
    cursor: delivery.throughSeq,
    ...(await registry.syncDelta.serving.identity()),
    minAvailableSeq: await registry.syncDelta.serving.retentionFloor(),
  }
}
