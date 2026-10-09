import { type TaskCostView, taskCostView } from '@podium/client-core/values'
import type { TaskCostWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { usePolledQuery } from '@/lib/use-polled-query'
import { useTaskComparison } from './useTaskCost'

export interface MissionCost {
  view: TaskCostView | null
}

export function useMissionCost(
  trpc: Trpc,
  issueId: string | null,
  popoverOpen: boolean,
): MissionCost {
  // Existing chip telemetry stays in its current home pending the LiveStore.
  const task = usePolledQuery<TaskCostWire>({
    key: `cost.task:${issueId ?? 'none'}`,
    intervalMs: 90_000,
    enabled: issueId !== null,
    read: () => trpc.cost.task.query({ issueId: issueId as string }),
  })
  const comparison = useTaskComparison(trpc, issueId, popoverOpen, false)
  const chip = useMemo(() => task.data === null ? null
    : taskCostView({ ...task.data, sessions: [] }), [task.data])
  return { view: comparison.view ?? chip }
}
