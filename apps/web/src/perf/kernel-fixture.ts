import {
  createKernelReplica,
  createSideCache,
  memoryStorage,
  type KernelCacheRead,
} from '@podium/client-core/replica'
import type { EntityRecord } from '@podium/sync/replica'

export const PROFILES = [
  { name: 'ci', issues: 674, sessions: 530, repositories: 12, worktrees: 96 },
  { name: 'live', issues: 4867, sessions: 4304, repositories: 500, worktrees: 468 },
  { name: 'growth', issues: 9734, sessions: 8608, repositories: 1000, worktrees: 936 },
] as const
export const FIXED_NOW = Date.parse('2026-09-18T12:00:00Z')

/** Same read contract as the opened IndexedDB cache, without disk/transport noise.
 * Map writes retain all untouched row identities and do not scan the corpus. */
export class BenchmarkCache implements KernelCacheRead {
  private records = new Map<string, EntityRecord>()
  reads = 0
  scans = 0
  readCursor() {
    return { seq: 1 }
  }
  readEntities() {
    this.scans++
    return [...this.records.values()]
  }
  read(entity: string, id: string) {
    this.reads++
    return this.records.get(`${entity}:${id}`)
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: string, entityId: string, value: unknown): EntityRecord {
    const record = { entity, entityId, value, provenance: { seq: 1 } }
    this.records.set(`${entity}:${entityId}`, record)
    return record
  }
}
export function kernelFixture(cache = new BenchmarkCache()) {
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return {
    cache,
    replica,
    upsert(entity: string, id: string, value: unknown) {
      replica.onKernelEvent({
        type: 'upserted',
        record: cache.put(entity, id, value),
        readmitted: false,
      })
    },
  }
}
