import { type TaskCostView, taskCostView } from '@podium/client-core/values'
import { costRefresh } from '@podium/client-graph/cost-refresh'
import type { TaskCostWire } from '@podium/model/browser'
import { useMemo } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { useAnswerQuery } from '@/lib/use-answer-query'
import { useTaskComparison } from './useTaskCost'

export interface MissionCost {
  view: TaskCostView | null
}

export function useMissionCost(
  trpc: Trpc,
  issueId: string | null,
  popoverOpen: boolean,
): MissionCost {
  const pool = useWorklistPool()
  const signal = useMemo(() => costRefresh(pool, issueId), [pool, issueId])
  const task = useAnswerQuery<TaskCostWire>({
    key: `cost.task:${issueId ?? 'none'}`,
    signal,
    enabled: issueId !== null,
    read: () => trpc.cost.task.query({ issueId: issueId as string }),
  })
  const comparison = useTaskComparison(trpc, issueId, popoverOpen, false)
  const chip = useMemo(
    () => (task.data === null ? null : taskCostView({ ...task.data, sessions: [] })),
    [task.data],
  )
  return { view: comparison.view ?? chip }
}
