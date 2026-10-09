import type { TaskCostView } from '@podium/client-core/values'
import type { IssueId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { useEffect, useMemo, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { useTabVisible } from '@/lib/use-polled-query'
import { TaskCostModel } from './task-cost-model'

export interface TaskCostFeed {
  view: TaskCostView | null
  failed: boolean
  loading: boolean
  error: string | null
  refresh: () => void
}

/** A new request owner per opening/address. Close drops its answer and ignores
 * any late response; the broad usage/telemetry caches remain out of scope. */
export function useTaskComparison(
  trpc: Trpc,
  issueId: string | null,
  enabled = true,
  includeSessions = true,
): TaskCostFeed {
  const model = useMemo(() => issueId !== null && enabled
    ? new TaskCostModel((input) => trpc.cost.taskComparison.query(input), issueId, includeSessions)
    : null, [trpc, issueId, enabled, includeSessions])
  const visible = useTabVisible()
  const [, changed] = useState(0)
  useEffect(() => {
    if (!model) return
    const release = autorun(() => {
      void model.view
      void model.loading
      void model.error
      changed((n) => n + 1)
    })
    model.open()
    return () => { release(); model.close() }
  }, [model])
  useEffect(() => { model?.setVisible(visible) }, [model, visible])
  return {
    view: model?.view ?? null,
    failed: model?.error != null,
    loading: model?.loading ?? false,
    error: model?.error ?? null,
    refresh: model?.refresh ?? (() => {}),
  }
}

export function useTaskCost(trpc: Trpc, issueId: IssueId | null): TaskCostFeed {
  return useTaskComparison(trpc, issueId)
}
