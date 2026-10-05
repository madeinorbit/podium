/** Values stay in the check process; reports contain counts/positions only. */
import type { IssueViewModel } from '@podium/client-core/replica'
import { operationalState, type TaskProgress } from '@podium/client-core/values'
import { asIssueId } from '@podium/model/browser'
import { autorun } from 'mobx'
import type { BoardOptions, BoardSnapshotData, PoolExplorerData } from '../src/issue-board-schema'
import type { MobxPool } from '../src/pool'
import { LOADING } from '../src/worklist/rollup'
import { issuePageFirstDifference } from './issue-page-check'
/** Observe the same computed demand as the screen, then release it. A batch
 * alone is untracked and would repeatedly expand dependency-free ID answers. */
export function inBoardCheck<T>(read: () => T): T {
  let value!: T
  let failure: unknown
  let failed = false
  const stop = autorun(() => {
    try { value = read() }
    catch (error) { failed = true; failure = error }
  })
  stop()
  if (failed) throw failure
  return value
}

export const BOARD_CHECK_FIELDS = [
  'id',
  'seq',
  'title',
  'displayRef',
  'prefix',
  'description',
  'stage',
  'closedReason',
  'priority',
  'type',
  'assignee',
  'labels',
  'repoPath',
  'createdAt',
  'updatedAt',
  'archived',
  'deletedAt',
  'parentId',
  'worktreePath',
  'branch',
  'estimateMin',
  'dueAt',
  'deferUntil',
  'blocked',
  'deferred',
  'ready',
  'needsHuman',
  'color',
  'gitState',
  'deps',
  'dependents',
  'childIds',
  'childCount',
  'childDoneCount',
  'memberSessionIds',
  'readAt',
  'tuckedAt',
  'pinned',
  'defaultAgent',
  'unread',
  'sessionSummary',
] as const
const fields = (row: IssueViewModel) =>
  Object.fromEntries(BOARD_CHECK_FIELDS.map((key) => [key, row[key]]))
export function boardSnapshot(data: BoardSnapshotData) {
  const view = data.view
  const shown = new Map(
    [
      ...view.boardIssues,
      ...view.rowGroups.flatMap((group) => group.rows.map((row) => row.issue)),
    ].map((row) => [row.id, row]),
  )
  return {
    active: view.active.map((row) => row.id),
    assignees: view.assignees,
    labels: view.labels,
    projectPaths: data.projectPaths,
    chips: view.chips,
    layout: view.layout,
    columns: view.orderedByStage.map((column) => ({
      stage: column.stage,
      ids: column.issues.map((row) => row.id),
    })),
    rows: view.rowGroups.map((group) => ({
      stage: group.stage,
      rows: group.rows.map((row) => ({
        id: row.issue.id,
        depth: row.depth,
        expanded: row.expanded,
        childCount: row.childCount,
      })),
    })),
    nav: view.nav,
    listIds: view.listIds,
    open: view.open ? fields(view.open) : null,
    orderedIdsForOpen: view.orderedIdsForOpen,
    values: [...shown.values()].map((row) => ({
      fields: fields(row),
      counts: view.stageCounts.get(row.id) ?? [],
      progress: view.epicProgress.get(row.id) ?? null,
    })),
  }
}
/** The parity check explicitly asks for every drawn value. Production reads
 * only ID lists and each virtual card; this diagnostic preserves the frozen
 * rich-value oracle without putting it back on the interaction path. */
export function readBoardSnapshot(pool: MobxPool, options: BoardOptions) {
  const layout = pool.row('issueBoardModel', JSON.stringify(options))
  const catalog = pool.row('issueBoardCatalog', String(options.display.showAgentTasks))
  if (!layout || layout === LOADING || !catalog || catalog === LOADING) return LOADING
  const models = new Map<string, IssueViewModel>()
  const stageCounts: BoardSnapshotData['view']['stageCounts'] = new Map()
  const progress = new Map<string, TaskProgress | null>()
  const shown = new Set([...layout.rootIds, ...layout.view.rowGroups.flatMap(group => group.rows.map(row => row.id))])
  if (options.openIssueId) shown.add(options.openIssueId)
  for (const id of shown) {
    const card = pool.row('issueBoardCard', JSON.stringify({ id, agents: options.display.showAgentTasks }))
    if (!card || card === LOADING) return LOADING
    models.set(id, card.issue)
    stageCounts.set(id, card.stageCounts)
    if (layout.rootIds.includes(id)) progress.set(id, card.progress)
  }
  const rowGroups = layout.view.rowGroups.map(group => ({ stage: group.stage,
    rows: group.rows.map(({ id, ...row }) => ({ ...row, issue: models.get(id)! })),
  }))
  const openIds = options.openIssueId
    ? pool.row('issueBoardOpenIds', JSON.stringify({ ...options, id: options.openIssueId })) : []
  if (openIds === LOADING) return LOADING
  const data: BoardSnapshotData = {
    issues: [...models.values()], sessions: [], projectPaths: catalog.projectPaths,
    view: {
      nonArchived: [], scope: [], active: layout.activeIds.map(id => ({ id } as IssueViewModel)),
      assignees: catalog.assignees, labels: catalog.labels, chips: layout.view.chips, layout: layout.view.layout,
      boardIssues: layout.rootIds.map(id => models.get(id)!), stageCounts, epicProgress: progress,
      orderedByStage: layout.view.orderedByStage.map(column => ({ stage: column.stage, issues: column.ids.map(id => models.get(id)!) })),
      rowGroups, listIds: layout.view.listIds, nav: layout.view.nav, presentIds: layout.view.presentIds,
      ...(options.openIssueId ? { open: models.get(options.openIssueId) } : {}),
      orderedIdsForOpen: openIds ?? [],
    },
  }
  // The legacy board calculates nested navigation on an open even in board
  // layout. Keep that explicit diagnostic request distinct from the layout.
  if (options.openIssueId && data.view.layout === 'board') {
    const nested = pool.row('issueBoardModel', JSON.stringify({ ...options, display: { ...options.display, layout: 'list' } }))
    if (!nested || nested === LOADING) return LOADING
    data.view.listIds = nested.view.listIds
    data.view.rowGroups = nested.view.rowGroups.map(group => ({ stage: group.stage,
      rows: group.rows.map(({ id, ...row }) => ({ ...row, issue: models.get(asIssueId(id))! })),
    }))
  }
  return boardSnapshot(data)
}
export function explorerSnapshot(data: PoolExplorerData) {
  return {
    counts: data.counts,
    tab: data.tab,
    total: data.total,
    rows: data.rows.map((row) => ({
      fields: fields(row),
      state: operationalState(row, data.rowSessions.get(row.id) ?? [], data.byId),
      sessions: (data.rowSessions.get(row.id) ?? []).map((seat) => ({
        sessionId: seat.sessionId,
        issueId: seat.issueId,
        status: seat.status,
        agentKind: seat.agentKind,
        archived: seat.archived,
        agentState: seat.agentState,
        offer: seat.offer,
      })),
    })),
  }
}
export function compareBoardValues(expected: unknown, actual: unknown) {
  const field = issuePageFirstDifference(expected, actual)
  return { differences: field ? 1 : 0, first: field, pending: 0 }
}
