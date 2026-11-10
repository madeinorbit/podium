/**
 * WHICH KINDS COMPARE AT SAVE (POD-6769, design POD-6253 §3).
 *
 * A kind in {@link COMPARE_AT_SAVE_KINDS} has moved: a write names the records
 * it may affect in its commit's `affects`, and the Authority builds them from
 * the database before the write and again after it, through the record
 * builders (`record-builders.ts`), appending a change for each that differs.
 * Nothing compares such a kind's value with `change_latest` when it is saved.
 * The Authority refuses the other path for a moved kind (a declared change or a
 * capture), and refuses a named record of a kind that is not listed, so the
 * list is the fact and not a description of it.
 *
 * A kind not listed keeps the old compare. Kinds move one at a time: a kind is
 * added here in the commit that moves every one of its writers.
 *
 * The boot reconcile of a moved kind still compares against `change_latest`
 * (it has no write to build around); it goes with the boot re-check (POD-6221).
 */

import type { MetadataEntityKind } from '@podium/protocol'
import type { RecordSourcePort } from '@podium/sync'
import { type RecordReads, serverRecordBuilders } from './record-builders'

export const COMPARE_AT_SAVE_KINDS: readonly MetadataEntityKind[] = [
  'userLayout',
  'userReadPosition',
]

/**
 * The Authority's record source: the moved kinds, built through the server's
 * record builders over `reads`. The store's repositories route each statement
 * to the transaction open when it runs, so a build inside a commit's span sees
 * that span's own writes.
 */
export function compareAtSaveRecords(
  reads: RecordReads,
  kinds: readonly MetadataEntityKind[] = COMPARE_AT_SAVE_KINDS,
): RecordSourcePort {
  const registry = serverRecordBuilders()
  const moved = new Set<MetadataEntityKind>(kinds)
  for (const kind of moved) registry.get(kind)
  return {
    comparesAtSave: (kind) => moved.has(kind),
    build: async (kind, ids) => await registry.build(reads, kind, ids),
  }
}
