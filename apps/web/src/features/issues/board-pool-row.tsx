import type { SessionView } from '@podium/client-core/session-values'
import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { type BoardIssue, boardCards } from '@podium/client-graph/issue-board-cards'
import type { JSX } from 'react'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { issueObserver as observer } from './issue-page/issue-observer'
import { issueMemberSessions } from './issue-lifecycle'

export function useBoardIssueReader() {
  const pool = useWorklistPool()
  return useCallback((id: string) => {
    const value = pool?.row('issueBoardRow', id)
    return value && typeof value !== 'symbol' ? value : undefined
  }, [pool])
}
export function useBoardAddressed(ids: readonly string[]) {
  const key = JSON.stringify(ids)
  const read = useCallback((pool: MobxPool) => {
    const rows: IssueViewModel[] = []
    for (const id of JSON.parse(key) as string[]) {
      const row = pool.row('issueBoardRow', id)
      if (row && typeof row !== 'symbol') rows.push(row)
    }
    return rows
  }, [key])
  return useWorklistPoolProjection(read, undefined) ?? []
}
/** One mounted list row over the shared issue model. The row's reads run in
 *  this observer, so it redraws when a field it shows changes. */
export const BoardPoolRow = observer(function BoardPoolRow({
  id,
  children,
}: {
  id: string
  children: (issue: BoardIssue) => JSX.Element
}): JSX.Element | null {
  const pool = useWorklistPool()
  if (!pool) return null
  const issue = boardCards(pool).issue(id)
  return issue.finished === undefined ? null : children(issue)
})
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
