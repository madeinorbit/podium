import { SyncRecord } from './sync-stream'
import type { WireFixture } from './wire-golden.fixtures'

export const SYNC_WIRE_FIXTURES: WireFixture[] = [
  { name: 'sync.meta.snapshot', schema: SyncRecord, value: {
    type: 'syncMeta', formatVersion: 1, mode: 'snapshot', transferId: 'transfer-1',
    feedId: 'feed-1', epoch: 'epoch-1', seq: 10, minAvailableSeq: 0,
    wireVersion: 3, wireSchemaDigest: '0123456789abcdef', totalRows: 0,
  } },
  { name: 'sync.meta.delta', schema: SyncRecord, value: {
    type: 'syncMeta', formatVersion: 1, mode: 'delta', transferId: 'transfer-1',
    feedId: 'feed-1', epoch: 'epoch-1', seq: 10, fromSeq: 5, minAvailableSeq: 0,
    wireVersion: 3, wireSchemaDigest: '0123456789abcdef',
  } },
  { name: 'sync.bootstrap', schema: SyncRecord, value: {
    type: 'feedBootstrap', feedId: 'feed-1', epoch: 'epoch-1', fromSeq: 0,
    seq: 10, minAvailableSeq: 0, changes: [], last: true,
  } },
  { name: 'sync.delta', schema: SyncRecord, value: {
    type: 'feedDelta', feedId: 'feed-1', epoch: 'epoch-1', fromSeq: 5,
    seq: 10, minAvailableSeq: 0,
    changes: [{ seq: 8, entity: 'issue', entityId: 'issue-1', op: 'evict' }],
  } },
  { name: 'sync.complete', schema: SyncRecord, value: {
    type: 'syncComplete', transferId: 'transfer-1', seq: 10, records: 1, rows: 1,
  } },
  { name: 'sync.error', schema: SyncRecord, value: {
    type: 'syncError', transferId: 'transfer-1', reason: 'read-failed',
  } },
]
