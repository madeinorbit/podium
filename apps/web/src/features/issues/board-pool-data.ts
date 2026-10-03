import { legacyIssueBoard } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { BoardOptions, PoolBoardData } from '@podium/client-graph/issue-board-schema'
import { ISSUE_BOARD_STAGES } from '@podium/model/browser'
import { useCallback, useMemo } from 'react'
import { useReplicaIssues, useStoreSelector, type IssueViewModel } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { boardDataLayer } from './board-data-layer'
import { deriveIssuesViewModel } from './issues-view-model'
import { useBoardPoolProjection } from './board-pool-projection'

const EMPTY_ISSUES: IssueViewModel[] = [], EMPTY_SESSIONS: SessionView[] = []
export const EMPTY_BOARD: PoolBoardData = {
  issues: EMPTY_ISSUES, sessions: EMPTY_SESSIONS, projectPaths: [],
  view: { nonArchived: [], scope: [], active: [], assignees: [], labels: [], chips: [], layout: 'board',
    boardIssues: [], stageCounts: new Map(), epicProgress: new Map(), rowGroups: [], listIds: [],
    orderedByStage: ISSUE_BOARD_STAGES.map(stage => ({ stage, issues: [] })),
    nav: { kind: 'columns', columns: ISSUE_BOARD_STAGES.map(() => []) }, presentIds: new Set(), orderedIdsForOpen: [] },
}
function useLegacyBase() {
  return { pool: false, issues: useReplicaIssues(), sessions: useStoreSelector(store => store.sessions), openIssueId: useStoreSelector(store => store.openIssueId) }
}
const readWindow = (pool: MobxPool) => pool.row('issueBoardWindow', 'current')
function usePoolBase() {
  const window = useWorklistPoolProjection(readWindow, undefined)
  return { pool: true, issues: EMPTY_ISSUES, sessions: EMPTY_SESSIONS, openIssueId: window && typeof window !== 'symbol' ? window.openIssueId : null }
}
/** The branch is fixed at startup. The pool branch never enters a legacy hook. */
export function useBoardBase() {
  const useRead = boardDataLayer() === 'pool' ? usePoolBase : useLegacyBase
  return useRead()
}
function useLegacyData(options: BoardOptions, base: ReturnType<typeof useBoardBase>): PoolBoardData {
  const owner = useStoreHandle()
  const { issues, sessions } = base
  const projectPaths = useMemo(() => [...new Set(issues.map(row => row.repoPath).filter(Boolean))].sort((a, b) =>
    (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b)), [issues])
  const view = useMemo(() => legacyIssueBoard(owner, 'board', () => deriveIssuesViewModel({
    ...options, issues, sessions, display: options.display as Parameters<typeof deriveIssuesViewModel>[0]['display'], expanded: new Set(options.expanded),
  })), [owner, issues, sessions, options])
  return { issues, sessions, projectPaths, view }
}
function usePoolData(options: BoardOptions): PoolBoardData {
  // Facets belong to the mounted board, rather than a particular filter's
  // projection. Retain that observation while React replaces the row reader.
  const agents = String(options.display.showAgentTasks)
  const readCatalog = useCallback((pool: MobxPool) => pool.row('issueBoardCatalog', agents), [agents])
  useWorklistPoolProjection(readCatalog, undefined)
  const key = JSON.stringify({ ...options, windowed: true, now: 0 })
  const value = useBoardPoolProjection<PoolBoardData | symbol>('issueBoardModel', key)
  return value && typeof value !== 'symbol' ? value : EMPTY_BOARD
}
export function useBoardData(options: BoardOptions, base: ReturnType<typeof useBoardBase>): PoolBoardData {
  const useRead = boardDataLayer() === 'pool' ? usePoolData : useLegacyData
  return useRead(options, base)
}
