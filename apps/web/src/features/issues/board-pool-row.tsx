import type { SessionView } from '@podium/client-core/session-values'
import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import type { JSX } from 'react'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { issueMemberSessions } from './issue-lifecycle'

export function useBoardCard(id: string, now: number, agents = false) {
  const key = JSON.stringify({ id, now, agents })
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardCard', key), [key])
  return useWorklistPoolProjection(read, undefined)
}
function useBoardRow(issue: IssueViewModel) {
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardRow', issue.id), [issue.id])
  return useWorklistPoolProjection(read, undefined)
}
export function BoardPoolRow({
  issue,
  children,
}: {
  issue: IssueViewModel
  children: (issue: IssueViewModel) => JSX.Element
}) {
  const value = useBoardRow(issue)
  return value && typeof value !== 'symbol' ? children(value) : null
}
export function useBoardSessionReader() {
  const pool = useWorklistPool()
  return useCallback((issue: IssueViewModel) => pool?.row('issueBoardSessions', issue.id), [pool])
}
export function useBoardCloseGuard(_sessions: readonly SessionView[]) {
  const pool = useWorklistPool()
  return useCallback(
    (issue: IssueViewModel) => {
      const row = pool?.row('issueBoardRow', issue.id),
        seats = pool?.row('issueBoardSessions', issue.id)
      if (!row || !seats || typeof row === 'symbol' || typeof seats === 'symbol') return true
      return (
        blockingCloseConcerns(issueCloseConcerns(row, issueMemberSessions(row, seats))).length > 0
      )
    },
    [pool],
  )
}
