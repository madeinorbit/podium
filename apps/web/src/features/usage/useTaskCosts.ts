import { type CostCohort, type TaskCostRowView, taskCostRows } from '@podium/client-core/viewmodels'
import type { TaskCostRowWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { resetPolledQueryCache, usePolledQuery } from '@/lib/use-polled-query'

/**
 * The by-task section's feed — every task that has a stored figure, priced.
 *
 * SAME CADENCE AS THE TOKEN TRACE, and not by coincidence: `cost.tasks` reads
 * rows the `usage.summary` harvest itself writes (POD-1858), so a slower poll
 * here would leave the by-task section a window behind the total it is a
 * breakdown of — the one inconsistency this section cannot afford, since its
 * first reading is a share of that total. It is nonetheless its OWN poll rather
 * than a field on the usage answer: the sheet's regions each own their read, and
 * a ranked table of 226 tasks has no business travelling with the hour buckets
 * that the command bar's status strip also reads.
 *
 * Same RPC-poll reasoning as `useUsageFeed` beside it: host telemetry, no
 * server-side entity to replicate, nothing an optimistic overlay could apply to.
 * Tab-lifetime cache, never localStorage.
 */

const REFRESH_MS = 90_000
const CACHE_KEY = 'cost.tasks'

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetTaskCostsCache(): void {
  resetPolledQueryCache(CACHE_KEY)
}

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
  const query = usePolledQuery<TaskCostRowWire[]>({
    key: CACHE_KEY,
    intervalMs: REFRESH_MS,
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
