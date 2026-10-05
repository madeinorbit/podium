import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type {
  BoardFilter,
  IssueRow,
  IssuesOrdering,
  TaskProgress,
} from '@podium/client-core/values'
import type { IssueBoardStage, IssueId, IssueStage } from '@podium/model/browser'
import type { BoardProjection } from './issue-board-projection'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import type { MissionActionInputs } from './mission-view'
import { mergePoolSummaries } from './source-registry'

export type BoardExplorerTab =
  | 'needs'
  | 'proposed'
  | 'backlog'
  | 'planning'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled'
export const BOARD_EXPLORER_TABS: readonly BoardExplorerTab[] = [
  'needs',
  'in_progress',
  'review',
  'planning',
  'backlog',
  'proposed',
  'done',
  'cancelled',
]
export interface BoardOptions {
  display: { layout: 'board' | 'list'; ordering: IssuesOrdering; showAgentTasks: boolean }
  filter: BoardFilter
  expanded: readonly string[]
  isMobile: boolean
  openIssueId?: IssueId | null
  now?: number
  menu?: boolean
  windowed?: boolean
  addressed?: readonly string[]
}
/** Data keys contain only layout/filter state. Addressed actions and details
 * are separate readers; card payloads never enter the column ID lists. */
export interface BoardColumnOptions {
  filter: BoardFilter
  ordering: IssuesOrdering
  showAgentTasks: boolean
  stage: IssueBoardStage
}
export interface BoardListRow {
  id: IssueId
  depth: number
  childCount: number
  expanded: boolean
}
export interface PoolBoardData {
  activeIds: IssueId[]
  rootIds: IssueId[]
  view: {
    chips: { key: keyof BoardFilter; label: string }[]
    layout: 'board' | 'list'
    orderedByStage: { stage: IssueBoardStage; ids: IssueId[] }[]
    rowGroups: { stage: IssueBoardStage; rows: BoardListRow[]; count: number }[]
    listIds: IssueId[]
    nav: { kind: 'rows'; ids: IssueId[] } | { kind: 'columns'; columns: IssueId[][] }
    presentIds: Set<string>
  }
}
/** Rich snapshots are diagnostic evidence only, never a screen subscription. */
export interface BoardSnapshotData {
  issues: IssueViewModel[]
  sessions: SessionView[]
  projectPaths: string[]
  menuInputs?: MissionActionInputs
  view: {
    nonArchived: IssueViewModel[]
    scope: IssueViewModel[]
    active: IssueViewModel[]
    assignees: string[]
    labels: string[]
    chips: { key: keyof BoardFilter; label: string }[]
    layout: 'board' | 'list'
    boardIssues: IssueViewModel[]
    stageCounts: Map<string, { stage: IssueStage; count: number }[]>
    epicProgress: Map<string, TaskProgress | null>
    orderedByStage: { stage: IssueStage; issues: IssueViewModel[] }[]
    rowGroups: { stage: IssueStage; rows: IssueRow<IssueViewModel>[] }[]
    listIds: IssueId[]
    nav: { kind: 'rows'; ids: IssueId[] } | { kind: 'columns'; columns: IssueId[][] }
    presentIds: Set<string>
    open?: IssueViewModel
    orderedIdsForOpen: IssueId[]
  }
}
export interface PoolExplorerData {
  counts: Record<BoardExplorerTab, number>
  tab: BoardExplorerTab
  total: number
  rows: IssueViewModel[]
  sessions: SessionView[]
  byId: Map<string, IssueViewModel>
  rowSessions: Map<string, SessionView[]>
}
export interface BoardCatalog {
  scope: string[]
  projectPaths: string[]
  assignees: string[]
  labels: string[]
}
export interface BoardQuery {
  kind: 'board' | 'explorer'
  filter?: BoardFilter
  showAgentTasks?: boolean
  tab?: BoardExplorerTab
  query?: string
}
export interface BoardCardData {
  issue: IssueViewModel
  sessions: SessionView[]
  fleet: SessionView[]
  byId: Map<string, IssueViewModel>
  stageCounts: { stage: IssueStage; count: number }[]
  progress: TaskProgress | null
}
export interface IssueBoardSourceRows {
  issueBoardWindow: { openIssueId: IssueId | null }
  issueBoardQuery: { ids: string[] }
  issueBoardCatalog: BoardCatalog
  issueBoardModel: PoolBoardData
  issueBoardColumn: IssueId[]
  issueBoardOpenIds: IssueId[]
  issueBoardMenu: MissionActionInputs
  issueBoardDropIndex: number
  issueExplorerModel: PoolExplorerData
  issueBoardRow: IssueViewModel
  issueBoardProjection: BoardProjection
  issueBoardCard: BoardCardData
  issueBoardSessions: SessionView[]
}
declare module './source-registry' {
  interface PoolSourceRows extends IssueBoardSourceRows {}
}
export const ISSUE_BOARD_SOURCE_KEY = 'issue-board'
export const ISSUE_BOARD_ENTITIES = [
  'issueBoardWindow',
  'issueBoardQuery',
  'issueBoardCatalog',
  'issueBoardModel',
  'issueBoardColumn',
  'issueBoardOpenIds',
  'issueBoardMenu',
  'issueBoardDropIndex',
  'issueExplorerModel',
  'issueBoardRow',
  'issueBoardProjection',
  'issueBoardCard',
  'issueBoardSessions',
] as const
export const ISSUE_BOARD_SOURCE_SCHEMA = {
  issueBoardWindow: {
    key: 'windowId',
    source: 'runtime:openIssueId',
    fields: ['openIssueId'],
    residency: 'window-scalar',
  },
  issueBoardQuery: {
    key: 'serializedFilter',
    source: 'pool:resident-index+declared-cold-summaries',
    fields: ['ids'],
    residency: 'mounted-demand-ids',
  },
  issueBoardCatalog: {
    key: 'showAgentTasks',
    source: 'pool:issue-summaries+treeParent',
    fields: ['scope', 'projectPaths', 'assignees', 'labels'],
    residency: 'mounted-demand',
  },
  issueBoardModel: {
    key: 'serializedDisplayAndFilter',
    source: 'pool:issueBoardColumn+issue-tree',
    residency: 'mounted-view',
  },
  issueBoardColumn: {
    key: 'serializedColumnAndFilter',
    source: 'pool:boardIssues+issue-scope+issue-sort-key',
    fields: ['ids'],
    residency: 'mounted-column-ids',
  },
  issueBoardOpenIds: {
    key: 'serializedFilterAndOpenedId',
    source: 'pool:issueBoardQuery+issue-tree',
    residency: 'open-detail-navigation',
  },
  issueBoardMenu: {
    key: 'addressedIdsAndScope',
    source: 'pool:issueBoardRow+issueBoardSessions+issueBoardCatalog',
    residency: 'open-menu',
  },
  issueBoardDropIndex: {
    key: 'serializedColumnAndMovedId',
    source: 'pool:issueBoardColumn+issue-sort-key',
    residency: 'drag-gesture',
  },
  issueExplorerModel: {
    key: 'serializedTabAndQuery',
    source: 'pool:issueBoardQuery+issue-relations+session-summaries',
    residency: 'mounted-view',
  },
  issueBoardRow: {
    key: 'issueId',
    source: 'pool:issue-summary+repo+treeChildren+pageDependents+pageSessions',
    residency: 'observed-row',
  },
  issueBoardProjection: {
    key: 'entityAndDemandKey',
    source: 'pool:issueBoardModel|issueExplorerModel',
    residency: 'mounted-observation',
  },
  issueBoardCard: {
    key: 'issueIdAndDisplay',
    source: 'pool:issueBoardRow+issue-relations+session-summaries',
    residency: 'virtual-row',
  },
  issueBoardSessions: {
    key: 'issueId',
    source: 'pool:missionSessions+session-summaries',
    residency: 'addressed-read',
  },
} as const
/** Core already declares repo, treeParent/treeChildren, pageDependencies,
 * pageDependents and pageSessions. This screen uses those exact relations.
 * Cold cards/filtering need these projection fields, never a document panel. */
export const ISSUE_BOARD_SUMMARIES = mergePoolSummaries(ISSUE_PAGE_SUMMARIES, {
  issue: [
    'priority',
    'createdAt',
    'type',
    'description',
    'estimateMin',
    'dueAt',
    'intentOrigin',
    'closedAt',
    'branch',
    'pinned',
    'tuckedAt',
    'defaultAgent',
  ],
  session: [
    'refIssueId',
    'createdAt',
    'agentColor',
    'displayRef',
    'stopReason',
    'readAt',
    'unread',
    'snoozedUntil',
    'createdBy',
    'machineId',
    'resumable',
    'harnessHandoff',
  ],
}) as { readonly issue: readonly string[]; readonly session: readonly string[] }
