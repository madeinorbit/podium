import './synced-models'
import { omitGone } from './lookup'
import { settingsView } from './settings-views'
import { machineViewsFromWire, runSubjectReference, type RunSubjectReference } from '@podium/client-core/values'
import type { WorkflowRunWire } from '@podium/protocol'
import type { MobxPool } from './pool'
import type { MachineModel } from './models'
import { WORKFLOW_SCHEMA } from './workflow-schema'
import { LOADING } from './worklist/rollup'

/** Read-only projections over the one pool reader. The host's observed
 * projection supplies memoization; nothing here retains a second row copy. */
export function workflowMachines(pool: MobxPool) {
  const catalog = omitGone(pool.row(WORKFLOW_SCHEMA.machines.catalog, 'catalog'))
  const machines: MachineModel[] = []
  let pending = catalog === LOADING ? 1 : 0
  if (catalog && catalog !== LOADING) for (const id of catalog.machines) {
    const row = omitGone(pool.model(WORKFLOW_SCHEMA.machines.entity, id))
    if (row === LOADING) pending++
    else if (row) machines.push(row)
  }
  return { views: machineViewsFromWire(machines), pending }
}

export function workflowSubject(pool: MobxPool, run: WorkflowRunWire): RunSubjectReference<{ id: string }> | typeof LOADING {
  // The session summary applies the existing resume-twin rule and source-order
  // tie break. A raw keyed session read would expose a suppressed parked twin.
  const present = run.subjectKind === 'session'
    ? settingsView(pool).sessionPresent(run.subjectId)
    : omitGone(pool.row(WORKFLOW_SCHEMA.issue.entity, run.subjectId, 'summary'))
  if (present === LOADING) return LOADING
  return runSubjectReference(run, id => present ? { id } : undefined)
}
