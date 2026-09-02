import { costCohort, type TaskCostView, taskCostView } from '@podium/client-core/viewmodels'
import type { TaskCostRowWire, TaskCostWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { usePolledQuery } from '@/lib/use-polled-query'

/**
 * WHAT THE MISSION ON SCREEN HAS COST (POD-1862).
 *
 * ---------------------------------------------------------------------------
 * TWO READS, AND THE SECOND ONE IS LAZY ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * `cost.task` answers the chip: one row-shaped DB read for the mission root,
 * own and rollup. `cost.tasks` answers only the `2.3x median` LINE INSIDE THE
 * POPOVER — it returns every task with a figure (226 of them on this machine)
 * to build the cohort the multiple is measured against.
 *
 * So the cohort is not fetched until the popover is opened. The flight deck is
 * the one surface in the app that is ALWAYS mounted, and paying for the whole
 * corpus every ninety seconds to supply a line nobody has asked to see is the
 * opposite of what the design asks for: the cheap answer must stay cheap
 * (POD-1604 §03). Opened once, it is held for the tab — the cohort is a median
 * over hundreds of tasks and does not move on the timescale of a popover.
 *
 * Both reads poll through the ONE polling utility, which owns the tab-visibility
 * gate, the per-key cache across mounts, and the rule that a failed refresh
 * keeps the last answer. The deck remounts this hook whenever the operator
 * picks a different mission, so the cache is what stops that being a fetch.
 *
 * NOTHING HERE PRICES ANYTHING. The wire is tokens; `taskCostView` applies the
 * one price table, and computes the rate the same way every other cost surface
 * computes it — rollup cost over rollup replies, against a cohort median taken
 * over OWN cost per task. That function is shared rather than reimplemented
 * because the review of the read path caught one task reading 1.97x on one
 * surface and 2.51x on another, and a comparative number that disagrees with
 * itself is worse than no comparative number.
 */

const TASK_REFRESH_MS = 90_000
/** The cohort is read ONCE per tab: `intervalMs: 0` in the polling utility. */
const COHORT_READ_ONCE = 0
/** A cohort younger than this is not re-read when a popover opens again. */
const COHORT_FRESH_MS = 5 * 60_000

export interface MissionCost {
  /**
   * Null while this tab has never had an answer for this mission. The chip
   * renders NOTHING in that case rather than a slot — see `MissionCostChip`.
   */
  view: TaskCostView | null
}

export function useMissionCost(
  trpc: Trpc,
  issueId: string | null,
  /** True once the popover has been opened — the gate on the cohort read. */
  wantCohort: boolean,
): MissionCost {
  const task = usePolledQuery<TaskCostWire>({
    key: `cost.task:${issueId ?? 'none'}`,
    intervalMs: TASK_REFRESH_MS,
    enabled: issueId !== null,
    read: () => trpc.cost.task.query({ issueId: issueId as string }),
  })
  const cohortRows = usePolledQuery<TaskCostRowWire[]>({
    key: 'cost.tasks',
    intervalMs: COHORT_READ_ONCE,
    enabled: wantCohort,
    freshForMs: COHORT_FRESH_MS,
    read: () => trpc.cost.tasks.query(),
  })
  const cohort = useMemo(
    () => (cohortRows.data === null ? undefined : costCohort(cohortRows.data)),
    [cohortRows.data],
  )
  return useMemo(
    () => ({ view: task.data === null ? null : taskCostView(task.data, cohort) }),
    [task.data, cohort],
  )
}
