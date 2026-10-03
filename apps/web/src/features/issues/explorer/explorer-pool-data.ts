import { legacyIssueBoard } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { PoolExplorerData } from '@podium/client-graph/issue-board-schema'
import { useCallback, useMemo } from 'react'
import { useReplicaIssues, type IssueViewModel } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { boardDataLayer } from '../board-data-layer'
import { useIssuePageIssues, useIssuePageSessions } from '../issue-page/issue-page-data'
import { defaultTab, EXPLORER_TABS, explorerCounts, explorerRows, type ExplorerTab } from './explorer-list'

const EMPTY: PoolExplorerData = { counts: { needs: 0, proposed: 0, backlog: 0, planning: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 },
  tab: 'in_progress', total: 0, rows: [], sessions: [], byId: new Map(), rowSessions: new Map() }
function useLegacyExplorer(pickedTab: ExplorerTab | null, query: string): PoolExplorerData {
  // Preserve POD-5091's inspector context when the board switch is off.
  const sessions = useIssuePageSessions(), issues = useIssuePageIssues(), owner = useStoreHandle()
  const counts = useMemo(() => legacyIssueBoard(owner, 'explorer', () => explorerCounts(issues, sessions)), [owner, issues, sessions])
  const tab = pickedTab ?? defaultTab(counts)
  const rows = useMemo(() => legacyIssueBoard(owner, 'explorer', () => explorerRows(issues, sessions, { tab, query })), [owner, issues, sessions, tab, query])
  const byId = useMemo(() => new Map(issues.map(row => [row.id as string, row])), [issues])
  const rowSessions = useMemo(() => {
    const map = new Map<string, SessionView[]>(), memberOf = new Map<string, string>()
    for (const issue of issues) for (const id of issue.memberSessionIds ?? []) memberOf.set(id, issue.id)
    for (const seat of sessions) {
      const owner = seat.issueId ?? memberOf.get(seat.sessionId)
      if (!owner) continue
      const bucket = map.get(owner)
      if (bucket) bucket.push(seat)
      else map.set(owner, [seat])
    }
    return map
  }, [issues, sessions])
  return { counts, tab, total: EXPLORER_TABS.reduce((n, entry) => n + (entry.id === 'needs' ? 0 : counts[entry.id]), 0), rows, sessions, byId, rowSessions }
}
function usePoolExplorer(tab: ExplorerTab | null, query: string): PoolExplorerData {
  const key = JSON.stringify({ tab, query })
  const read = useCallback((pool: MobxPool) => pool.row('issueExplorerModel', key), [key])
  const value = useWorklistPoolProjection(read, undefined)
  return value && typeof value !== 'symbol' ? value : EMPTY
}
export function useExplorerData(tab: ExplorerTab | null, query: string): PoolExplorerData {
  const useRead = boardDataLayer() === 'pool' ? usePoolExplorer : useLegacyExplorer
  return useRead(tab, query)
}
function useLegacyCrumbs(_ids: readonly string[]) { return useReplicaIssues() }
function usePoolCrumbs(ids: readonly string[]): IssueViewModel[] {
  const key = JSON.stringify(ids)
  const read = useCallback((pool: MobxPool) => (JSON.parse(key) as string[]).flatMap(id => {
    const row = pool.row('issueBoardRow', id)
    return row && typeof row !== 'symbol' ? [row] : []
  }), [key])
  return useWorklistPoolProjection(read, [])
}
export function useExplorerCrumbs(ids: readonly string[]) {
  const useRead = boardDataLayer() === 'pool' ? usePoolCrumbs : useLegacyCrumbs
  return useRead(ids)
}
