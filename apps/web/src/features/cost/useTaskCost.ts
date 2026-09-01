/**
 * WHAT ONE TASK COST, FETCHED (POD-1859).
 *
 * Two reads, deliberately on two different cadences, folded into one priced
 * view:
 *
 *   `cost.task`   this task's own and rolled-up token totals. A pure DB read on
 *                 indexed columns — it opens no transcript — so a panel may call
 *                 it on first paint. Repeats, because a live task's figure moves.
 *
 *   `cost.tasks`  every task with a stored figure, read ONLY for the cohort the
 *                 "× median" multiple is measured against. Read once per tab: a
 *                 median over ~200 tasks does not move inside a session, and
 *                 re-fetching every task's model totals every 90 s to re-derive
 *                 a number that has not changed would be the most expensive read
 *                 in the app in service of one decimal place.
 *
 * BOTH SURFACES CALL `costCohort`, and neither computes a rate. The review on
 * POD-1869 caught the same task reading 1.97× in the panel and 2.51× in the
 * sheet, because two surfaces each divided their own two numbers. The median is
 * built from OWN cost over OWN replies (one row per task, so an epic does not
 * count the same work once per ancestor) and the displayed rate from ROLLUP over
 * ROLLUP (so it matches the headline beside it) — that asymmetry is the
 * viewmodel's, and it is why nothing here does arithmetic.
 *
 * It polls rather than riding the feed for the same reason `usage.summary` does:
 * this is a measurement of a host's transcripts, not a row anyone replicates.
 * See {@link usePolledQuery}.
 */

import { costCohort, type TaskCostView, taskCostView } from '@podium/client-core/viewmodels'
import type { IssueId, TaskCostRowWire, TaskCostWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { usePolledQuery } from '@/lib/use-polled-query'

/** The design's stated cadence for every cost readout in the app. */
const TASK_REFRESH_MS = 90_000

/**
 * A panel reopened inside this window opens on the figures it already had and
 * asks the server for nothing. The explorer re-mounts this panel on every
 * navigation step, which is the cheapest gesture in the shell.
 */
const TASK_FRESH_MS = 15_000

/** Read once per tab (see above); this only keeps a remount from re-reading. */
const COHORT_FRESH_MS = 5 * 60_000

export interface TaskCostFeed {
  /**
   * Null only while this tab has never had an answer for this task — the one
   * genuinely COLD state, and the only one the section draws unfilled slots for
   * on account of the network. Every other absence is a state ON the view.
   */
  view: TaskCostView | null
  /** The last attempt failed. With `view` set, what is on screen is merely old. */
  failed: boolean
  refresh: () => void
}

export function useTaskCost(trpc: Trpc, issueId: IssueId | null): TaskCostFeed {
  const task = usePolledQuery<TaskCostWire | null>({
    // The task id is IN the key: a cache keyed only by `cost.task` would paint
    // one task's money under another task's heading for a whole interval after
    // a step through the explorer.
    key: `cost.task:${issueId ?? 'none'}`,
    intervalMs: TASK_REFRESH_MS,
    freshForMs: TASK_FRESH_MS,
    enabled: issueId !== null,
    read: async () => (issueId === null ? null : await trpc.cost.task.query({ issueId })),
  })

  const rows = usePolledQuery<TaskCostRowWire[]>({
    // `intervalMs: 0` is this utility's "read once per key" — the cohort is a
    // property of the corpus, not a reading of this task.
    key: 'cost.tasks',
    intervalMs: 0,
    freshForMs: COHORT_FRESH_MS,
    // `async` is load-bearing, not style: `usePolledQuery` attaches its handlers
    // to the returned promise, so a SYNCHRONOUS throw in here escapes into the
    // render instead of settling as a failed read. A server that cannot answer
    // must leave this section unfilled, never take the panel down with it.
    read: async () => await trpc.cost.tasks.query(),
  })

  const cohort = useMemo(
    () => (rows.data === null ? undefined : costCohort(rows.data)),
    [rows.data],
  )

  const view = useMemo(
    // The cohort is optional on purpose: a task's own figure is worth showing
    // the moment it lands, and it must not wait on the corpus read behind it.
    // Without a cohort `rateVsMedian` is null and the Rate row simply does not
    // draw — one absent row, not an absent section.
    () => (task.data ? taskCostView(task.data, cohort) : null),
    [task.data, cohort],
  )

  return { view, failed: task.failed, refresh: task.refresh }
}
