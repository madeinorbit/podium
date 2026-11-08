import { type CostCohort, type TaskCostRowView, taskCostRows } from '@podium/client-core/values'
import { costRefresh } from '@podium/client-graph/cost-refresh'
import type { TaskCostRowWire } from '@podium/model/browser'
import { useMemo } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { useAnswerQuery } from '@/lib/use-answer-query'

/** The open by-task answer follows turn ends and issue-stage changes in the pool. */
export function resetTaskCostsCache(): void {} // Kept for existing test callers; answers have no cache.

export interface TaskCostsFeed {
  /** Null only when this tab has never had an answer: the one cold state. */
  rows: TaskCostRowView[] | null
  /** The cohort the Rate column's multiple is measured against. */
  cohort: CostCohort | null
  waiting: boolean
  failed: boolean
  retry: () => void
}

export function useTaskCosts(trpc: Trpc): TaskCostsFeed {
  const pool = useWorklistPool()
  const signal = useMemo(() => costRefresh(pool, null), [pool])
  const query = useAnswerQuery<TaskCostRowWire[]>({
    key: 'cost.tasks',
    signal,
    read: () => trpc.cost.tasks.query(),
  })
  // THE RANKING AND THE COHORT COME OUT OF ONE CALL, deliberately: `taskCostRows`
  // computes the median from the same rows it ranks, so the "x median" multiple
  // and the order it sits in are one reading of one set. Computing the median
  // separately is how the same task came to read 1.97x on one surface and 2.51x
  // on another (POD-1869).
  const priced = useMemo(() => (query.data ? taskCostRows(query.data) : null), [query.data])
  return {
    rows: priced?.rows ?? null,
    cohort: priced?.cohort ?? null,
    waiting: query.pending,
    failed: query.failed,
    retry: query.refresh,
  }
}
