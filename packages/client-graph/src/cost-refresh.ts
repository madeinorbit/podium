import { reaction } from 'mobx'
import type { AnswerSignal } from './answer-refresh'
import { focusRefresh } from './answer-refresh'
import { here } from './lookup'
import type { MobxPool } from './pool'

/** Costs change at turn end and issue-stage transitions. Consume addressed pool
 * changes, so no reaction walks the task's historical sessions or the corpus. */
export function costRefresh(pool: MobxPool | null, root: string | null): AnswerSignal {
  return (changed) => {
    const related = (id: string | undefined | null): boolean => {
      if (root === null) return true
      const seen = new Set<string>()
      while (id && !seen.has(id)) {
        if (id === root) return true
        seen.add(id)
        id = pool ? here(pool.row('issue', id, 'summary-fields'))?.parentId : undefined
      }
      return false
    }
    const stop = pool
      ? reaction(
          () => [pool.sessionPhaseChanges.get(), pool.issueStageChanges] as const,
          ([phases, stages], previous) => {
            if (stages !== previous[1] && stages.some((id) => related(id))) {
              changed()
              return
            }
            if (
              phases !== previous[0] &&
              phases.some((change) => {
                if (
                  change.previous?.agentState?.phase !== 'working' ||
                  change.current?.agentState?.phase === 'working'
                )
                  return false
                const issue = here(pool.row('session', change.sessionId, 'summary-fields'))?.issueId
                return related(issue)
              })
            )
              changed()
          },
        )
      : () => {}
    const unfocus = focusRefresh(changed)
    return () => {
      stop()
      unfocus()
    }
  }
}
