import type { MobxPool } from '@podium/client-graph'
import type { PoolExplorerData } from '@podium/client-graph/issue-board-schema'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useBoardPoolProjection } from '../board-pool-projection'
import type { ExplorerTab } from './explorer-list'

const EMPTY: PoolExplorerData = {
  counts: {
    needs: 0,
    proposed: 0,
    backlog: 0,
    planning: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
  },
  tab: 'in_progress',
  total: 0,
  ids: [],
  rows: [],
  sessions: [],
  byId: new Map(),
  rowSessions: new Map(),
}
export function useExplorerData(tab: ExplorerTab | null, query: string): PoolExplorerData {
  const key = JSON.stringify({ tab, query, windowed: true })
  const value = useBoardPoolProjection<PoolExplorerData | symbol>('issueExplorerModel', key)
  return value && typeof value !== 'symbol' ? value : EMPTY
}
export function useExplorerCrumbs(ids: readonly string[]): IssueViewModel[] {
  const key = JSON.stringify(ids)
  const read = useCallback(
    (pool: MobxPool) =>
      (JSON.parse(key) as string[]).flatMap((id) => {
        const row = pool.row('issueBoardRow', id)
        return row && typeof row !== 'symbol' ? [row] : []
      }),
    [key],
  )
  return useWorklistPoolProjection(read, [])
}
