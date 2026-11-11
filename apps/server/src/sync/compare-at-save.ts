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
 * NOT YET MOVED (POD-6770's finding): `session`, `sessionUserState`.
 * None of them is written by one write: each is republished after the fact,
 * from memory or from a hook that runs after the source write committed, and
 * relies on the compare with the stored copy to drop what did not change. To
 * move one, every SOURCE write names the dependent record before it runs (a
 * queue write names its session, a grant write the machine's rows).
 *
 * READING IS SEPARATE FROM THIS LIST. The record source builds every kind in
 * the registry, moved or not: the start-up load, the sharing rules and the
 * Authority's by-id reads take current values from it (POD-6770).
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
  'checkout',
  'repo',
  'issueProjection',
  'issueBodies',
  'issueUserState',
  'issueDep',
  'shipOrder',
  'shipLane',
  'workflow',
  'workflowRevision',
  'workflowBinding',
  'workflowRun',
  'effect',
  'superagentThread',
  // POD-6770: the issue's git observation and its panel items ride the issue
  // write funnel; a conversation is written by the scan and the metadata edit.
  'issueGitState',
  'issuePanelTodo',
  'issuePanelArtifact',
  'issuePanelDeferred',
  'issuePanelState',
  'conversation',
  'issueEvent',
  'pendingInteraction',
  'message',
  'machine',
  'machineAccess',
]

/**
 * THE CLOSED LIST of kinds whose writer names its records AFTER the write
 * (`wrote` on the commit; coordinator decisions of 2026-11-10 on POD-6769).
 * Such a record is built once, after the write, and appended as it is, with no
 * compare, so a named record that did not change costs one redundant row. The
 * list does not grow without a decision, and the Authority refuses `wrote` for
 * every other kind.
 *
 *  - The four workflow kinds: a workflow operation learns which records it
 *    wrote while it runs, so it cannot name them first. An operation that
 *    touches a record without changing it logs it again; workflows are not
 *    chatty.
 *  - `effect` and `superagentThread`: each is written through one repository
 *    funnel whose statements RETURN the rows they changed, so the named set is
 *    exactly the changed set. A write that changes nothing returns no row and
 *    logs nothing; each kind has a test for that (the scan bug of 2026-11-09
 *    was an effect row rewritten on every poll).
 *  - An `issueEvent` insert allocates its event id, and retention returns
 *    the ids it deleted. The window then identifies the arrivals and evictions.
 *    Appends publish after the event's transaction. A crash in between leaves
 *    the log behind until the boot reconcile. Retention captures its changes
 *    inside the deletion's transaction.
 *  - A `pendingInteraction` guarded insert or state transition determines
 *    which ask changed, including a fingerprint collision that reuses an
 *    existing id. The service announces only successful changes, after their
 *    transaction. A crash in between leaves a missing or stale ask on clients.
 *    The boot reconcile restores the open set. Announcements that overtake
 *    each other can append repeated removes.
 *  - The `message` repository's guarded statements RETURN only the rows
 *    they changed, and a confirmation determines which older messages leave
 *    its session's window. The capture and the row write share a transaction.
 *    A write that returns no rows names nothing and logs nothing. Session
 *    writes name their existing window before the write and compare it, so
 *    an unchanged conversation appends nothing either.
 */
export const NAMED_AFTER_WRITE_KINDS: readonly MetadataEntityKind[] = [
  'workflow',
  'workflowRevision',
  'workflowBinding',
  'workflowRun',
  'effect',
  'superagentThread',
  'issueEvent',
  'pendingInteraction',
  'message',
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
    buildMany: (idsByKind) => registry.buildMany(reads, idsByKind),
    // Every kind the registry builds, including kinds whose writers still
    // use the old compare (POD-6770).
    kinds: () => registry.kinds(),
    streamAll: (kind) => registry.streamAll(reads, kind),
    streamAllKinds: () => registry.streamAllKinds(reads),
  }
}
