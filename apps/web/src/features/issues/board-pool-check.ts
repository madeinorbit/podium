import type { ClientRuntime } from '@podium/client-core/engine'
import { allIssueViewModels } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { boardSnapshot, compareBoardValues, explorerSnapshot, inBoardCheck } from '@podium/client-graph/diagnostics/issue-board-check'
import type { BoardOptions, PoolBoardData, PoolExplorerData } from '@podium/client-graph/issue-board-schema'
import { deriveIssuesViewModel } from './issues-view-model'
import { DEFAULT_DISPLAY } from './issues-display'
import { defaultTab, EXPLORER_TABS, explorerCounts, explorerRows } from './explorer/explorer-list'

export function checkBoard(runtime: ClientRuntime, pool: MobxPool, options: BoardOptions) {
  const issues = allIssueViewModels(runtime.replica), sessions = runtime.getSnapshot().sessions
  const expected = deriveIssuesViewModel({ ...options, issues, sessions, display: { ...DEFAULT_DISPLAY, ...options.display }, expanded: new Set(options.expanded) })
  const paths = [...new Set(issues.map(row => row.repoPath).filter(Boolean))].sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b))
  const actual = pool.row('issueBoardModel', JSON.stringify(options))
  return !actual || typeof actual === 'symbol' ? { differences: 0, pending: 1, first: null }
    : compareBoardValues(boardSnapshot({ issues, sessions, projectPaths: paths, view: expected } as PoolBoardData), boardSnapshot(actual))
}
export function checkExplorer(runtime: ClientRuntime, pool: MobxPool, pickedTab: PoolExplorerData['tab'] | null, query: string) {
  const issues = allIssueViewModels(runtime.replica), sessions = runtime.getSnapshot().sessions
  const counts = explorerCounts(issues, sessions), tab = pickedTab ?? defaultTab(counts), rows = explorerRows(issues, sessions, { tab, query })
  const memberOf = new Map(issues.flatMap(row => row.memberSessionIds.map(id => [id as string, row.id as string] as const)))
  const rowSessions = new Map<string, typeof sessions>()
  for (const seat of sessions) { const id = seat.issueId ?? memberOf.get(seat.sessionId); if (id) { const bucket = rowSessions.get(id); if (bucket) bucket.push(seat); else rowSessions.set(id, [seat]) } }
  const expected: PoolExplorerData = { counts, tab, rows, sessions, rowSessions, byId: new Map(issues.map(row => [row.id, row])), total: EXPLORER_TABS.reduce((n, entry) => n + (entry.id === 'needs' ? 0 : counts[entry.id]), 0) }
  const actual = pool.row('issueExplorerModel', JSON.stringify({ tab: pickedTab, query }))
  return !actual || typeof actual === 'symbol' ? { differences: 0, pending: 1, first: null } : compareBoardValues(explorerSnapshot(expected), explorerSnapshot(actual))
}
export function installBoardCheck(runtime: ClientRuntime, pool: MobxPool) {
  const check = (options: BoardOptions = { display: DEFAULT_DISPLAY, filter: {}, expanded: [], isMobile: false, openIssueId: null, now: pool.clock.current }) =>
    inBoardCheck(() => checkBoard(runtime, pool, options))
  const explorer = (tab: PoolExplorerData['tab'] | null = null, query = '') => inBoardCheck(() => checkExplorer(runtime, pool, tab, query))
  Object.assign(window, { __boardCheck: check, __boardExplorerCheck: explorer })
  return () => { Reflect.deleteProperty(window, '__boardCheck'); Reflect.deleteProperty(window, '__boardExplorerCheck') }
}
