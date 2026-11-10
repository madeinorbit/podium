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
 * A kind not listed keeps the old compare. Kinds move one at a time.
 *
 * HOW A KIND MOVES
 *  1. It has a record builder (`record-builders.ts`): `build(ids)` answers the
 *     record exactly as its publisher publishes it. Prove that with the parity
 *     test and tool of POD-6763 before going on.
 *  2. Every writer names the record instead of declaring its value. In a
 *     `commit`: `affects: [{ entity, id }]`, and drop the kind's entries from
 *     `changes`. A writer that must read to know the ids passes a function,
 *     which runs inside the transaction before the first build. A row the
 *     write creates under an id it decides is named in `creates`.
 *  3. A `capture` of the kind becomes a `commit` that runs the row write: a
 *     capture has no write to build around. A repository hook that published
 *     after its row write wraps that write instead.
 *  4. Add the kind to the list below, in the same commit as its writers.
 *  5. Tests that build their own Ledger give it `testStoreRecords(store)`
 *     (`test-support/record-writer.ts`); a service unit test with no Ledger
 *     uses `recordTestWriter`.
 *  6. Re-pin the kind's statement-count tests: two builds replace one read of
 *     `change_latest`.
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
  'pin',
  'tabOrder',
  'userPreferences',
  'agentProfile',
  'automation',
  'automationRun',
  'subscription',
  'instancePreferences',
  'issueProjection',
  'issueBodies',
  'issueUserState',
  'issueDep',
  'workflow',
  'workflowRevision',
  'workflowBinding',
  'workflowRun',
]

/**
 * THE CLOSED LIST of kinds whose writer names its records AFTER the write
 * (`wrote` on the commit; coordinator decision of 2026-11-10 on POD-6769). A
 * workflow operation learns which records it wrote while it runs, so it cannot
 * name them first. Such a record is built once, after the write, and appended
 * as it is, with no compare: a write that changed nothing costs one redundant
 * row. That is acceptable for workflows and for nothing chatty, so this list
 * does not grow without a decision. The Authority refuses `wrote` for every
 * other kind.
 */
export const NAMED_AFTER_WRITE_KINDS: readonly MetadataEntityKind[] = [
  'workflow',
  'workflowRevision',
  'workflowBinding',
  'workflowRun',
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
  const namedAfter = new Set(NAMED_AFTER_WRITE_KINDS.filter((kind) => moved.has(kind)))
  return {
    comparesAtSave: (kind) => moved.has(kind),
    namedAfterWrite: (kind) => namedAfter.has(kind),
    build: async (kind, ids) => await registry.build(reads, kind, ids),
  }
}
