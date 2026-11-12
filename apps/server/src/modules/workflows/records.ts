/**
 * WORKFLOWS AS SYNCED RECORDS (POD-6676, ADR 12 D1; design POD-5620 §1.10).
 *
 * Four kinds reach the feed: `workflow`, `workflowRevision`, `workflowBinding`
 * and `workflowRun`. Every one of them is written by the workflow service, from
 * many sites (a library write, a run advance, a run the server starts after a
 * spawn), so the change entries are not restated at each site:
 *
 *  - ONE COMMIT PER OPERATION. {@link committedWorkflowWrite} runs the operation
 *    inside the writer's `commit`: the rows and their change entries commit
 *    together (ADR 2 D10). The database captures every row the operation
 *    changed, and the Authority builds the records those rows reach from the
 *    stored rows (POD-6920), so a record on the feed is always the stored one.
 *    An operation started inside another (an adoption starting its new run)
 *    joins the outer commit.
 *  - A WRITE OUTSIDE AN OPERATION CANNOT COMMIT: its capture is never drained,
 *    and the database refuses the transaction (POD-6920).
 *
 * A run carries its revision by id and no history (`WorkflowRunRecord`); the
 * history stays the `workflows.status` answer, because it grows.
 *
 * `records.workflowBinding.edit` is the one generic edit of the family
 * (`binding-record.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorkflowRunRecord, WorkflowRunStepWire } from '@podium/model'
import type { LedgerCommitOp } from '@podium/sync'
import type { WorkflowRunRow } from '../../store/workflows'

/** Set while a workflow operation's commit is open, so a nested one joins it. */
const operationScope = new AsyncLocalStorage<true>()

/** What a workflow operation commits through: a command's writer or the
 *  service's own server origin. */
export interface WorkflowChangeWriter {
  commit<T>(op: LedgerCommitOp<T>): Promise<{ result: T }>
}

/**
 * Run one workflow operation as one commit: its rows and the change entries of
 * every record it touched. Inside an operation already open, it joins it.
 * Without a writer (unit tests), it runs as it is.
 */
export async function committedWorkflowWrite<T>(
  writer: WorkflowChangeWriter | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (operationScope.getStore() !== undefined || writer === undefined) return await operation()
  const { result } = await writer.commit({
    write: async () => await operationScope.run(true, operation),
  })
  return result
}

/** A run as the feed carries it: its revision by id, no history. */
export function workflowRunRecordOf(
  run: WorkflowRunRow,
  workflowId: string,
  steps: readonly WorkflowRunStepWire[],
): WorkflowRunRecord {
  return {
    id: run.id,
    subjectKind: run.subjectKind,
    subjectId: run.subjectId,
    coordinatorSessionId: run.coordinatorSessionId,
    revisionId: run.revisionId,
    workflowId,
    status: run.status,
    supersedesRunId: run.supersedesRunId,
    steps: [...steps],
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }
}
