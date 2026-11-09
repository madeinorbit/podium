import { workflowMachines, workflowSubject } from '@podium/client-graph/workflow-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { WorkflowRunWire } from '@podium/protocol'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

const EMPTY_MACHINES: ReturnType<typeof workflowMachines> = { views: [], pending: 1 }
export function useWorkflowMachines() {
  return useWorklistPoolProjection(workflowMachines, EMPTY_MACHINES)
}
export function useWorkflowSubject(run: Pick<WorkflowRunWire, 'id' | 'subjectKind' | 'subjectId'>) {
  const read = useCallback(
    (pool: Parameters<typeof workflowSubject>[0]) =>
      workflowSubject(pool, { subjectKind: run.subjectKind, subjectId: run.subjectId }),
    [run.subjectKind, run.subjectId],
  )
  return useWorklistPoolProjection(read, LOADING)
}
