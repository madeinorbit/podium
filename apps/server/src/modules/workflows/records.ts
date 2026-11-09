/**
 * WORKFLOWS AS SYNCED RECORDS (POD-6676, ADR 12 D1; design POD-5620 §1.10).
 *
 * Four kinds reach the feed: `workflow`, `workflowRevision`, `workflowBinding`
 * and `workflowRun`. Every one of them is written by the workflow service, from
 * many sites (a library write, a run advance, a run the server starts after a
 * spawn), so the change entries are not restated at each site. Instead:
 *
 *  - THE REPOSITORY RECORDS WHAT A WRITE TOUCHED. {@link recordedWorkflowStore}
 *    wraps `WorkflowsRepository`: each mutating method notes the record it
 *    changed (a run step names its run, a new revision its workflow) in the
 *    operation's {@link WorkflowTouched}, held in async context for the length
 *    of one operation.
 *  - ONE COMMIT PER OPERATION. {@link committedWorkflowWrite} runs the operation
 *    inside the writer's `commit`: the rows and their change entries commit
 *    together (ADR 2 D10), and the entries are read back from the rows the
 *    operation touched, so a record on the feed is always the stored one. An
 *    operation started inside another (an adoption starting its new run) joins
 *    the outer commit.
 *  - STRICT IN PRODUCTION. A service wired with a writer refuses a workflow write
 *    outside any operation: a write the feed would never hear of is a bug, and
 *    it fails where it is made. A service built without one (the engine's unit
 *    tests) writes as before and publishes nothing.
 *
 * A run carries its revision by id and no history (`WorkflowRunRecord`); the
 * history stays the `workflows.status` answer, because it grows.
 *
 * `records.workflowBinding.edit` is the one generic edit of the family
 * (`binding-record.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  parseWorkflowBindingRowId,
  type WorkflowBindingTarget,
  type WorkflowRunRecord,
  type WorkflowRunStepWire,
  workflowBindingRowId,
} from '@podium/model'
import type { EntityChangeSpec, LedgerCommitOp } from '@podium/sync'
import type { WorkflowRunRow, WorkflowsRepository } from '../../store/workflows'

/** The records one workflow operation changed. */
export class WorkflowTouched {
  readonly workflows = new Set<string>()
  readonly revisions = new Set<string>()
  /** Binding row ids (`workflowBindingRowId`). */
  readonly bindings = new Set<string>()
  readonly runs = new Set<string>()
}

const touchedScope = new AsyncLocalStorage<WorkflowTouched>()

/** What one mutating repository method changed, from its arguments and answer. */
type Touch = (touched: WorkflowTouched, args: readonly unknown[], result: unknown) => void

const arg = <T>(args: readonly unknown[]): T => args[0] as T

/** Every mutating method of the repository. A method missing here is a write
 *  the feed would not hear of; `records.test.ts` holds the list to the class. */
export const WORKFLOW_STORE_WRITES: Readonly<Record<string, Touch>> = {
  insertWorkflow: (t, args) => t.workflows.add(arg<{ id: string }>(args).id),
  insertRevision: (t, args, result) => {
    t.revisions.add((result as { id: string }).id)
    // A revision moves its workflow's latest pointers.
    t.workflows.add(arg<{ workflowId: string }>(args).workflowId)
  },
  // The revision's workflow is read back with it (its pointers may move).
  publishRevision: (t, args) => t.revisions.add(arg<string>(args)),
  setBinding: (t, args) => {
    const input = arg<{ targetKind: WorkflowBindingTarget; targetId: string }>(args)
    t.bindings.add(workflowBindingRowId(input.targetKind, input.targetId))
  },
  insertRun: (t, args) => t.runs.add(arg<{ run: { id: string } }>(args).run.id),
  updateRunStatus: (t, args) => t.runs.add(arg<string>(args)),
  updateStep: (t, args) => t.runs.add(arg<{ runId: string }>(args).runId),
  assignStep: (t, args) => t.runs.add(arg<string>(args)),
  resetStep: (t, args) => t.runs.add(arg<string>(args)),
}

/** Methods that write rows no record carries: the run history (a request
 *  answer, design §1.10). Listed so the method check stays total. */
export const WORKFLOW_STORE_UNSYNCED_WRITES: readonly string[] = ['appendEvent']

/**
 * The repository as the service holds it: every mutating method records what
 * it touched in the current operation. `strict` refuses a write outside one.
 */
export function recordedWorkflowStore(
  store: WorkflowsRepository,
  opts: { strict: boolean },
): WorkflowsRepository {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function' || typeof prop !== 'string') return value
      const touch = WORKFLOW_STORE_WRITES[prop]
      const method = value as (...args: unknown[]) => Promise<unknown>
      if (touch === undefined) return method.bind(target)
      return async (...args: unknown[]) => {
        const touched = touchedScope.getStore()
        if (touched === undefined && opts.strict) {
          throw new Error(`workflows: ${prop} ran outside a change-log commit`)
        }
        const result = await method.apply(target, args)
        if (touched !== undefined) touch(touched, args, result)
        return result
      }
    },
  })
}

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
  store: WorkflowsRepository,
  writer: WorkflowChangeWriter | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (touchedScope.getStore() !== undefined || writer === undefined) return await operation()
  const touched = new WorkflowTouched()
  const { result } = await writer.commit({
    write: async () => await touchedScope.run(touched, operation),
    changes: async () => await workflowRecordChanges(store, touched),
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

/**
 * The change entries of the records one operation touched, read back as they
 * are stored now. A few reads per touched record; an operation touches a few.
 * Workflows, revisions and bindings are never deleted (a workflow archives), so
 * every entry is an upsert.
 */
export async function workflowRecordChanges(
  store: WorkflowsRepository,
  touched: WorkflowTouched,
): Promise<EntityChangeSpec[]> {
  const out: EntityChangeSpec[] = []
  const workflowOfRevision = new Map<string, string>()
  const revisionWorkflow = async (revisionId: string): Promise<string | undefined> => {
    const known = workflowOfRevision.get(revisionId)
    if (known !== undefined) return known
    const revision = await store.getRevision(revisionId)
    if (revision === null) return undefined
    workflowOfRevision.set(revisionId, revision.workflowId)
    return revision.workflowId
  }
  const workflowIds = new Set(touched.workflows)
  for (const id of touched.revisions) {
    const revision = await store.getRevision(id)
    if (revision === null) continue
    workflowOfRevision.set(id, revision.workflowId)
    workflowIds.add(revision.workflowId)
    out.push({ entity: 'workflowRevision', id, op: 'upsert', value: revision })
  }
  for (const id of workflowIds) {
    const workflow = await store.getWorkflow(id)
    if (workflow !== null) out.push({ entity: 'workflow', id, op: 'upsert', value: workflow })
  }
  for (const id of touched.bindings) {
    const key = parseWorkflowBindingRowId(id)
    if (key === undefined) continue
    const binding = await store.getBinding(key.targetKind, key.targetId)
    if (binding !== null) out.push({ entity: 'workflowBinding', id, op: 'upsert', value: binding })
  }
  for (const id of touched.runs) {
    const run = await store.getRun(id)
    if (run === null) continue
    const workflowId = await revisionWorkflow(run.revisionId)
    if (workflowId === undefined) continue
    const value = workflowRunRecordOf(run, workflowId, await store.getRunSteps(id))
    out.push({ entity: 'workflowRun', id, op: 'upsert', value })
  }
  return out
}

/** What the boot reconcile appends through: the boot's `server` writer. */
export interface WorkflowReconcileWriter {
  reconcile(
    entity: 'workflow' | 'workflowRevision' | 'workflowBinding' | 'workflowRun',
    rows: { id: string; value: unknown }[],
  ): Promise<unknown>
}

/**
 * THE BOOT BACK-FILL (POD-6676). Workflow rows were stored long before they
 * were synced, so at boot every stored row becomes an upsert on the log; the
 * Authority skips rows that did not change, so a restart appends nothing new.
 * Five reads whatever the size of the library.
 *
 * Rolling back needs no data step: the tables are unchanged in shape, and an
 * older build parses these kinds' log rows as unknown and advances its cursor.
 */
export async function reconcileWorkflowRecords(
  writer: WorkflowReconcileWriter,
  store: Pick<
    WorkflowsRepository,
    | 'allWorkflowsForBootReconcile'
    | 'allRevisionsForBootReconcile'
    | 'listBindings'
    | 'allRunsForBootReconcile'
  >,
): Promise<void> {
  const workflows = await store.allWorkflowsForBootReconcile()
  await writer.reconcile(
    'workflow',
    workflows.map((value) => ({ id: value.id, value })),
  )
  const revisions = await store.allRevisionsForBootReconcile()
  await writer.reconcile(
    'workflowRevision',
    revisions.map((value) => ({ id: value.id, value })),
  )
  const bindings = await store.listBindings()
  await writer.reconcile(
    'workflowBinding',
    bindings.map((value) => ({
      id: workflowBindingRowId(value.targetKind, value.targetId),
      value,
    })),
  )
  const runs = await store.allRunsForBootReconcile()
  await writer.reconcile(
    'workflowRun',
    runs.map(({ run, workflowId, steps }) => ({
      id: run.id,
      value: workflowRunRecordOf(run, workflowId, steps),
    })),
  )
}
