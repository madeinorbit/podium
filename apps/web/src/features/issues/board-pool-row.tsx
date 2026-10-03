import { blockingCloseConcerns, issueCloseConcerns } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph'
import type { BoardCardData } from '@podium/client-graph/issue-board-schema'
import type { SessionView } from '@podium/client-core/session-values'
import type { JSX } from 'react'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { boardDataLayer } from './board-data-layer'
import { issueMemberSessions, useIssueCloseGuard } from './issue-lifecycle'

function usePoolCard(id: string, now: number, agents: boolean) {
  const key = JSON.stringify({ id, now, agents })
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardCard', key), [key])
  return useWorklistPoolProjection(read, undefined)
}
function useLegacyCard(_id: string, _now: number, _agents: boolean) { return undefined }
export function useBoardCard(id: string, now: number, agents = false): BoardCardData | symbol | undefined {
  const useRead = boardDataLayer() === 'pool' ? usePoolCard : useLegacyCard
  return useRead(id, now, agents)
}
function usePoolRow(issue: IssueViewModel) {
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardRow', issue.id), [issue.id])
  return useWorklistPoolProjection(read, undefined)
}
function useLegacyRow(issue: IssueViewModel) { return issue }
export function BoardPoolRow({ issue, children }: { issue: IssueViewModel; children: (issue: IssueViewModel) => JSX.Element }) {
  const useRead = boardDataLayer() === 'pool' ? usePoolRow : useLegacyRow
  const value = useRead(issue)
  return value && typeof value !== 'symbol' ? children(value) : null
}
function usePoolSessions() {
  const pool = useWorklistPool()
  return useCallback((issue: IssueViewModel) => pool?.row('issueBoardSessions', issue.id), [pool])
}
function useLegacySessions() { return undefined }
export function useBoardSessionReader() {
  const useRead = boardDataLayer() === 'pool' ? usePoolSessions : useLegacySessions
  return useRead()
}
function usePoolGuard(_sessions: readonly SessionView[]) {
  const pool = useWorklistPool()
  return useCallback((issue: IssueViewModel) => {
    const row = pool?.row('issueBoardRow', issue.id), seats = pool?.row('issueBoardSessions', issue.id)
    if (!row || !seats || typeof row === 'symbol' || typeof seats === 'symbol') return true
    return blockingCloseConcerns(issueCloseConcerns(row, issueMemberSessions(row, seats))).length > 0
  }, [pool])
}
function useLegacyGuard(_sessions: readonly SessionView[]) { return useIssueCloseGuard() }
export function useBoardCloseGuard(sessions: readonly SessionView[]) {
  const useRead = boardDataLayer() === 'pool' ? usePoolGuard : useLegacyGuard
  return useRead(sessions)
}
