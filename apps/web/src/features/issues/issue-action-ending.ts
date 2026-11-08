/**
 * HOW AN ISSUE ACTION ENDED, TOLD ON THE DEVICE THAT ASKED (POD-6526).
 *
 * Stopping an issue, cleaning it up, shipping it and refreshing its assistant
 * are effect records: the write resolves once the record is durably queued,
 * and the work answers on the record later (also hours later, when its machine
 * was offline). Every device shows the record's progress from the issue model
 * (`workPending`); only the device that asked says how it ended, once.
 */

import type { IssueWorkAction } from '@podium/client-core/spawn-agent'
import type { MobxPool } from '@podium/client-graph'
import { awaitEffect, effectShortfall } from '@podium/client-graph/write/await-effect'
import type { IssueId } from '@podium/model/browser'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'

const WHAT: Readonly<Record<IssueWorkAction, string>> = {
  stop: "Couldn't stop the task",
  cleanup: "Couldn't clean up the task",
  ship: "Couldn't ship the task",
  assistant: "Couldn't refresh the assistant",
}

/** Tell the ending of the issue action `effectId`, once, if it did not do its work. */
export function tellIssueActionEnding(
  pool: Pick<MobxPool, 'tables' | 'model'> | null | undefined,
  effectId: string,
  action: IssueWorkAction,
): void {
  if (!pool) return
  void awaitEffect(pool, effectId).then((effect) => {
    const why = effectShortfall(effect)
    if (why !== undefined) toast.error(`${WHAT[action]} — ${why}`)
  })
}

/**
 * For a caller that acts on the answer (the reclaim panel reads whether a stop
 * freed the checkout): ask for the action and resolve with its record's result
 * once it has ended; reject with why it did not do its work.
 */
export function useIssueActionOutcome(): (
  issueId: IssueId,
  action: IssueWorkAction,
  opts?: { force?: boolean },
) => Promise<unknown> {
  const issueAction = useRuntimeSelector((s) => s.issueAction)
  const pool = useWorklistPool()
  return useCallback(
    async (issueId, action, opts) => {
      const effectId = await issueAction(issueId, action, opts)
      if (!pool) throw new Error('This device cannot follow the action yet.')
      const effect = await awaitEffect(pool, effectId)
      const why = effectShortfall(effect)
      if (why !== undefined) throw new Error(why)
      if (effect.status !== 'succeeded') throw new Error(`The action was ${effect.status}.`)
      return effect.result
    },
    [issueAction, pool],
  )
}
