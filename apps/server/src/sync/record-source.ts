/**
 * THE AUTHORITY'S RECORD SOURCE (POD-6253 design §1 and §3, POD-6920).
 *
 * Every synced kind is built from the model tables by its builder
 * (`record-builders.ts`), and which records a write changed comes from the
 * database's change capture: `drainCapture` takes the rows the capture
 * triggers wrote in the current transaction and maps them to record ids
 * through the kinds' declarations (`record-sources.ts`). The start-up load
 * and the sharing rules read the same builders. There is no copy fallback and
 * no record a writer names.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import type { RecordSourcePort } from '@podium/sync'
import { inChangeLogCommit } from '../store/commit-open'
import { spanOpen } from '../store/executor/executor'
import { type RecordReads, serverRecordBuilders } from './record-builders'
import { touchedRecords } from './record-sources'

/**
 * The record source over `reads`. The store's repositories route each
 * statement to the transaction open when it runs, so a drain and a build
 * inside a commit's span see that span's own writes. `kinds` limits a test to
 * a subset; production builds and drains every kind.
 */
export function databaseRecords(
  reads: RecordReads,
  kinds?: readonly MetadataEntityKind[],
): RecordSourcePort {
  const registry = serverRecordBuilders()
  const only = kinds === undefined ? undefined : new Set<MetadataEntityKind>(kinds)
  if (only) for (const kind of only) registry.get(kind)
  return {
    drainCapture: async (after) =>
      await touchedRecords(await reads.store.sync.drainCapture(after), reads, only),
    // Outside a transaction the capture is empty: no statement.
    captureMark: async () => (spanOpen() ? await reads.store.sync.captureMark() : 0),
    inCommit: inChangeLogCommit,
    build: async (kind, ids) => await registry.build(reads, kind, ids),
    buildMany: (idsByKind) => registry.buildMany(reads, idsByKind),
    kinds: () => registry.kinds(),
    streamAll: (kind) => registry.streamAll(reads, kind),
    streamAllKinds: () => registry.streamAllKinds(reads),
  }
}
