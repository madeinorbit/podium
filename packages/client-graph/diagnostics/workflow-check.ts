import type { Store } from '@podium/client-core/engine'
import { machineViewsFromWire, placementOptions, profilePlacement, runSubjectReference } from '@podium/client-core/viewmodels'
import type { ExecutionProfileWire, WorkflowRunWire } from '@podium/protocol'
import type { MobxPool } from '../src/pool'
import { workflowMachines, workflowSubject } from '../src/workflow-views'
import { LOADING } from '../src/worklist/rollup'
import { compareSidebarSnapshots, type SidebarSnapshot } from './sidebar-check'

/** RPC rows are borrowed from the caller's sole service. No query, subscription
 * or retained RPC replica is installed by this on-demand comparison. */
export interface WorkflowCheckInputs {
  profiles: readonly ExecutionProfileWire[]
  runs: readonly WorkflowRunWire[]
}
export type WorkflowCheckStore = Pick<Store, 'machines' | 'issueProjections' | 'sessions'>

export function legacyWorkflowSnapshot(state: WorkflowCheckStore, inputs: WorkflowCheckInputs): SidebarSnapshot {
  const views = machineViewsFromWire(state.machines)
  return { pending: 0, sections: [
    { key: 'placement', fields: placementOptions(views), rows: [] },
    { key: 'profiles', fields: {}, rows: inputs.profiles.map(profile => ({ id: profile.id, fields: profilePlacement(profile, views) })) },
    { key: 'subjects', fields: {}, rows: inputs.runs.map(run => {
      const subject = runSubjectReference(run, id => run.subjectKind === 'issue'
        ? state.issueProjections.find(issue => issue.id === id)
        : state.sessions.find(session => session.sessionId === id))
      return { id: run.id, fields: { id: subject.id, state: subject.state } }
    }) },
  ] }
}

export function poolWorkflowSnapshot(pool: MobxPool, inputs: WorkflowCheckInputs): SidebarSnapshot {
  const { views, pending: machinesPending } = workflowMachines(pool)
  let pending = machinesPending
  const options = placementOptions(views)
  return { sections: [
    { key: 'placement', fields: options, pendingFields: machinesPending ? Object.keys(options) : [], rows: [] },
    { key: 'profiles', fields: {}, rows: inputs.profiles.map(profile => ({ id: profile.id, pending: machinesPending > 0, fields: profilePlacement(profile, views) })) },
    { key: 'subjects', fields: {}, rows: inputs.runs.map(run => {
      const subject = workflowSubject(pool, run)
      if (subject === LOADING) pending++
      return { id: run.id, pending: subject === LOADING,
        fields: subject === LOADING ? {} : { id: subject.id, state: subject.state } }
    }) },
  ], get pending() { return pending } }
}

export function checkWorkflows(pool: MobxPool, state: WorkflowCheckStore, inputs: WorkflowCheckInputs) {
  const result = compareSidebarSnapshots(legacyWorkflowSnapshot(state, inputs), poolWorkflowSnapshot(pool, inputs))
  // The machine option payload may contain hostnames: report positions only.
  return { differences: result.differences, pending: result.pending, sections: result.sections, positions: result.rows,
    first: result.first ? { section: result.first.sectionIndex, row: result.first.rowIndex, field: result.first.field } : null }
}
