import type { SessionView } from '@podium/client-core/session-values'
import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import type { JSX } from 'react'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { issueMemberSessions } from './issue-lifecycle'

export function useBoardCard(id: string, _now: number, agents = false) {
  const key = JSON.stringify({ id, agents })
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardCard', key), [key])
  return useWorklistPoolProjection(read, undefined)
}
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
export function BoardPoolRow({
  issue,
  id,
  children,
}: {
  issue?: IssueViewModel
  id?: string
  children: (issue: IssueViewModel) => JSX.Element
}) {
  const key = id ?? issue!.id
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardRow', key), [key])
  const value = useWorklistPoolProjection(read, undefined)
  const row = value && typeof value !== 'symbol' ? value : issue
  return row ? children(row) : null
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
