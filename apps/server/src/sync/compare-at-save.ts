/**
 * Every synced kind compares model records before and after its source write.
 * A writer names records in affects, creates, or the closed after-write list.
 * Bootstrap and access checks use the same builders; there is no copy fallback.
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
  'session',
  'sessionUserState',
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
 *    Append and retention captures run inside their row transaction; any
 *    log failure rolls the source write back.
 *  - A `pendingInteraction` guarded insert or state transition determines
 *    which ask changed, including a fingerprint collision that reuses an
 *    existing id. The repository captures successful changes inside the row
 *    transaction, so there is no later publication a crash can lose.
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
