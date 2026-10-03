/** Values stay in the check process; reports contain counts/positions only. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { PoolBoardData, PoolExplorerData } from '../src/issue-board-schema'
import { issuePageFirstDifference } from './issue-page-check'
import { runInAction } from 'mobx'
export const inBoardCheck = <T>(read: () => T): T => runInAction(read)

export const BOARD_CHECK_FIELDS = ['id', 'seq', 'title', 'displayRef', 'prefix', 'description', 'stage', 'closedReason',
  'priority', 'type', 'assignee', 'labels', 'repoPath', 'createdAt', 'updatedAt', 'archived', 'deletedAt',
  'parentId', 'worktreePath', 'branch', 'estimateMin', 'dueAt', 'deferUntil', 'blocked', 'deferred', 'ready',
  'needsHuman', 'color', 'gitState', 'deps', 'dependents', 'childIds', 'childCount', 'childDoneCount',
  'memberSessionIds', 'readAt', 'tuckedAt', 'pinned', 'defaultAgent', 'unread', 'sessionSummary'] as const
const fields = (row: IssueViewModel) => Object.fromEntries(BOARD_CHECK_FIELDS.map(key => [key, row[key]]))
export function boardSnapshot(data: PoolBoardData) {
  const view = data.view
  const shown = new Map([...view.boardIssues, ...view.rowGroups.flatMap(group => group.rows.map(row => row.issue))].map(row => [row.id, row]))
  return { active: view.active.map(row => row.id), assignees: view.assignees, labels: view.labels,
    projectPaths: data.projectPaths, chips: view.chips, layout: view.layout,
    columns: view.orderedByStage.map(column => ({ stage: column.stage, ids: column.issues.map(row => row.id) })),
    rows: view.rowGroups.map(group => ({ stage: group.stage, rows: group.rows.map(row => ({ id: row.issue.id, depth: row.depth, expanded: row.expanded, childCount: row.childCount })) })),
    nav: view.nav, listIds: view.listIds, open: view.open ? fields(view.open) : null, orderedIdsForOpen: view.orderedIdsForOpen,
    values: [...shown.values()].map(row => ({ fields: fields(row), counts: view.stageCounts.get(row.id) ?? [], progress: view.epicProgress.get(row.id) ?? null })) }
}
export function explorerSnapshot(data: PoolExplorerData) {
  return { counts: data.counts, tab: data.tab, total: data.total, rows: data.rows.map(row => ({ fields: fields(row),
    sessions: (data.rowSessions.get(row.id) ?? []).map(seat => ({ sessionId: seat.sessionId, issueId: seat.issueId,
      status: seat.status, agentKind: seat.agentKind, archived: seat.archived, agentState: seat.agentState, offer: seat.offer })) })) }
}
export function compareBoardValues(expected: unknown, actual: unknown) {
  const field = issuePageFirstDifference(expected, actual)
  return { differences: field ? 1 : 0, first: field, pending: 0 }
}
