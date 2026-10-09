import type { IssueId } from '@podium/model/browser'
import { useEffect, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { useTabVisible } from '@/lib/use-polled-query'
import { TaskCostModel } from './task-cost-model'

export type TaskCostFeed = TaskCostModel

/** A new request owner per opening/address. Close drops its answer and ignores
 * any late response; the broad usage/telemetry caches remain out of scope. */
export function useTaskComparison(
  trpc: Trpc,
  issueId: string | null,
  enabled = true,
  includeSessions = true,
): TaskCostFeed {
  const model = useMemo(() => new TaskCostModel(
    (input) => trpc.cost.taskComparison.query(input), issueId, includeSessions,
  ), [trpc, issueId, enabled, includeSessions])
  const visible = useTabVisible()
  useEffect(() => {
    if (enabled) model.open()
    return () => model.close()
  }, [model, enabled])
  useEffect(() => { model.setVisible(visible) }, [model, visible])
  return model
}

export function useTaskCost(trpc: Trpc, issueId: IssueId | null): TaskCostFeed {
  return useTaskComparison(trpc, issueId)
}
