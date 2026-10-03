import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { BoardOptions, PoolBoardData } from '@podium/client-graph/issue-board-schema'
import { ISSUE_BOARD_STAGES } from '@podium/model/browser'
import { useCallback } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useBoardPoolProjection } from './board-pool-projection'

const EMPTY_ISSUES: IssueViewModel[] = [],
  EMPTY_SESSIONS: SessionView[] = []
export const EMPTY_BOARD: PoolBoardData = {
  issues: EMPTY_ISSUES,
  sessions: EMPTY_SESSIONS,
  projectPaths: [],
  view: {
    nonArchived: [],
    scope: [],
    active: [],
    assignees: [],
    labels: [],
    chips: [],
    layout: 'board',
    boardIssues: [],
    stageCounts: new Map(),
    epicProgress: new Map(),
    rowGroups: [],
    listIds: [],
    orderedByStage: ISSUE_BOARD_STAGES.map((stage) => ({ stage, issues: [] })),
    nav: { kind: 'columns', columns: ISSUE_BOARD_STAGES.map(() => []) },
    presentIds: new Set(),
    orderedIdsForOpen: [],
  },
}
const readWindow = (pool: MobxPool) => ({ ...pool.row('issueBoardWindow', 'current'), openIssueId: 'PLANTED' })
export function useBoardBase() {
  const window = useWorklistPoolProjection(readWindow, undefined)
  return {
    openIssueId: window && typeof window !== 'symbol' ? window.openIssueId : null,
  }
}
export function useBoardData(options: BoardOptions): PoolBoardData {
  // Facets belong to the mounted board, rather than a particular filter's
  // projection. Retain that observation while React replaces the row reader.
  const agents = String(options.display.showAgentTasks)
  const readCatalog = useCallback(
    (pool: MobxPool) => pool.row('issueBoardCatalog', agents),
    [agents],
  )
  useWorklistPoolProjection(readCatalog, undefined)
  const key = JSON.stringify({ ...options, windowed: true, now: 0 })
  const value = useBoardPoolProjection<PoolBoardData | symbol>('issueBoardModel', key)
  return value && typeof value !== 'symbol' ? value : EMPTY_BOARD
}
