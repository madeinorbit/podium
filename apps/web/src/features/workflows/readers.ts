import { recordSliceDerivation } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { machineViewsFromWire, runSubjectReference } from '@podium/client-core/viewmodels'
import { workflowMachines, workflowSubject } from '@podium/client-graph/workflow-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asSessionId } from '@podium/model/browser'
import type { WorkflowRunWire } from '@podium/protocol'
import { useCallback } from 'react'
import { useReplicaIssues, useSession, useStoreSelector } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { workflowsDataLayer } from './data-layer'

const EMPTY_MACHINES: ReturnType<typeof workflowMachines> = { views: [], pending: 1 }
function useLegacyMachines() {
  const owner = useStoreHandle()
  const machines = useStoreSelector(state => {
    recordSliceDerivation(owner, 'workflows.machines')
    return state.machines
  })
  return { views: machineViewsFromWire(machines), pending: 0 }
}
function usePoolMachines() { return useWorklistPoolProjection(workflowMachines, EMPTY_MACHINES) }
export function useWorkflowMachines() {
  return workflowsDataLayer() === 'pool' ? usePoolMachines() : useLegacyMachines()
}

function useLegacySubject(run: WorkflowRunWire) {
  const owner = useStoreHandle()
  const issues = useReplicaIssues()
  const session = useSession(run.subjectKind === 'session' ? asSessionId(run.subjectId) : undefined)
  return runSubjectReference<object>(run, id => {
    recordSliceDerivation(owner, 'workflows.subject')
    return run.subjectKind === 'issue' ? issues.find(issue => issue.id === id)
      : session?.sessionId === id ? session : undefined
  })
}
function usePoolSubject(run: WorkflowRunWire) {
  const read = useCallback((pool: Parameters<typeof workflowSubject>[0]) => workflowSubject(pool, run), [run])
  return useWorklistPoolProjection(read, LOADING)
}
export function useWorkflowSubject(run: WorkflowRunWire) {
  return workflowsDataLayer() === 'pool' ? usePoolSubject(run) : useLegacySubject(run)
}
