import type { ReferenceState as Store } from './reference-state'
import { machineViewsFromWire, placementOptions, profilePlacement, runSubjectReference } from '@podium/client-core/values'
import type { ExecutionProfileWire, WorkflowRunWire } from '@podium/protocol'
import { getObserverTree, Reaction, runInAction } from 'mobx'
import type { MobxPool } from '../../../packages/client-graph/src/pool'
import { workflowMachines, workflowSubject } from '../../../packages/client-graph/src/workflow-views'
import { LOADING } from '../../../packages/client-graph/src/worklist/rollup'
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
    { key: 'placement', fields: { ...placementOptions(views) }, rows: [] },
    { key: 'profiles', fields: {}, rows: inputs.profiles.map(profile => ({ id: profile.id, fields: { ...profilePlacement(profile, views) } })) },
    { key: 'subjects', fields: {}, rows: inputs.runs.map(run => {
      const subject = runSubjectReference<object>(run, id => run.subjectKind === 'issue'
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
  const sections: SidebarSnapshot['sections'] = [
    { key: 'placement', fields: { ...options }, pendingFields: machinesPending ? Object.keys(options) : [], rows: [] },
    { key: 'profiles', fields: {}, rows: inputs.profiles.map(profile => ({ id: profile.id, pending: machinesPending > 0, fields: { ...profilePlacement(profile, views) } })) },
    { key: 'subjects', fields: {}, rows: inputs.runs.map(run => {
      const subject = workflowSubject(pool, run)
      if (subject === LOADING) pending++
      return { id: run.id, pending: subject === LOADING,
        fields: subject === LOADING ? {} : { id: subject.id, state: subject.state } }
    }) },
  ]
  return { sections, pending }
}

export function checkWorkflows(pool: MobxPool, state: WorkflowCheckStore, inputs: WorkflowCheckInputs) {
  // A synchronous observed scope shares the session-summary computation across
  // this snapshot's run targets. Disposing immediately releases every observer;
  // the diagnostic keeps no source, computed cache or second row collection.
  let actual!: SidebarSnapshot
  let failure: unknown
  const scope = new Reaction('workflow-check', () => {}, error => { failure = error })
  try { scope.track(() => { actual = poolWorkflowSnapshot(pool, inputs) }) }
  finally { scope.dispose() }
  if (failure) throw failure
  const result = compareSidebarSnapshots(legacyWorkflowSnapshot(state, inputs), actual)
  // The machine option payload may contain hostnames: report positions only.
  return { differences: result.differences, pending: result.pending, sections: result.sections, positions: result.rows,
    first: result.first ? { section: result.first.sectionIndex, row: result.first.rowIndex, field: result.first.field } : null }
}

/** Probe the synchronous check and observer lifetime at the graph's MobX boundary. */
export function probeWorkflowCheckScope(pool: MobxPool, state: WorkflowCheckStore, inputs: WorkflowCheckInputs, sessionId: string) {
  const before = getObserverTree(pool.tables.session, sessionId)
  const result = runInAction(() => checkWorkflows(pool, state, inputs))
  return { result, before, after: getObserverTree(pool.tables.session, sessionId) }
}
