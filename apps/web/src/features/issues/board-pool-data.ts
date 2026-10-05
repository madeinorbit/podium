import type { MobxPool } from '@podium/client-graph'
import type { BoardCatalog, BoardColumnOptions, BoardOptions, PoolBoardData } from '@podium/client-graph/issue-board-schema'
import { ISSUE_BOARD_STAGES, type IssueId } from '@podium/model/browser'
import { useCallback } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useBoardPoolProjection } from './board-pool-projection'
import { readBoardCatalog } from './board-pool-reader'

export { readBoardCatalog } from './board-pool-reader'

export const EMPTY_BOARD: PoolBoardData = {
  activeIds: [],
  rootIds: [],
  view: {
    chips: [],
    layout: 'board',
    rowGroups: [],
    listIds: [],
    orderedByStage: ISSUE_BOARD_STAGES.map((stage) => ({ stage, ids: [] })),
    nav: { kind: 'columns', columns: ISSUE_BOARD_STAGES.map(() => []) },
    presentIds: new Set(),
  },
}
const EMPTY_IDS: IssueId[] = []
const EMPTY_CATALOG: BoardCatalog = { scope: [], projectPaths: [], assignees: [], labels: [] }
const readWindow = (pool: MobxPool) => pool.row('issueBoardWindow', 'current')
export function useBoardBase() {
  const window = useWorklistPoolProjection(readWindow, undefined)
  return {
    openIssueId: window && typeof window !== 'symbol' ? window.openIssueId : null,
  }
}
export function useBoardData(options: BoardOptions): PoolBoardData {
  const key = JSON.stringify({
    display: { layout: options.display.layout, ordering: options.display.ordering, showAgentTasks: options.display.showAgentTasks },
    filter: options.filter, isMobile: options.isMobile,
    expanded: options.isMobile || options.display.layout === 'list' ? options.expanded : [],
  })
  const value = useBoardPoolProjection<PoolBoardData | symbol>('issueBoardModel', key)
  return value && typeof value !== 'symbol' ? value : EMPTY_BOARD
}
export function useBoardColumn(options: BoardColumnOptions, fallback: IssueId[]) {
  const key = JSON.stringify(options)
  const read = useCallback((pool: MobxPool) => pool.row('issueBoardColumn', key), [key])
  const ids = useWorklistPoolProjection(read, undefined)
  return ids && typeof ids !== 'symbol' ? ids : fallback
}
export function useBoardCatalog(open: boolean, agents: boolean) {
  const read = useCallback((pool: MobxPool) => readBoardCatalog(pool, open, agents), [open, agents])
  const value = useWorklistPoolProjection(read, undefined)
  return value && typeof value !== 'symbol' ? value : EMPTY_CATALOG
}
export function useBoardOpenIds(options: BoardOptions, id: IssueId | null) {
  const key = JSON.stringify({ ...options, id })
  const read = useCallback((pool: MobxPool) => id ? pool.row('issueBoardOpenIds', key) : undefined, [id, key])
  const value = useWorklistPoolProjection(read, undefined)
  return value && typeof value !== 'symbol' ? value : EMPTY_IDS
}
export function useBoardMenu(ids: string[] | undefined, agents: boolean) {
  const key = JSON.stringify({ ids, agents })
  const active = !!ids
  const read = useCallback((pool: MobxPool) => active ? pool.row('issueBoardMenu', key) : undefined, [active, key])
  const value = useWorklistPoolProjection(read, undefined)
  return value && typeof value !== 'symbol' ? value : undefined
}
export function useBoardDropIndex() {
  const pool = useWorklistPool()
  return useCallback((options: BoardColumnOptions & { id: string }) => {
    const value = pool?.row('issueBoardDropIndex', JSON.stringify(options))
    return value && typeof value !== 'symbol' ? value.index ?? 0 : 0
  }, [pool])
}
