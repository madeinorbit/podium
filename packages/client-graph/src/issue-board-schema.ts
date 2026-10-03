import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { BoardFilter, IssueRow, IssuesOrdering, TaskProgress } from '@podium/client-core/viewmodels'
import type { IssueId, IssueStage } from '@podium/model/browser'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import type { MissionActionInputs } from './mission-view'

export type BoardExplorerTab = 'needs' | 'proposed' | 'backlog' | 'planning' | 'in_progress' | 'review' | 'done' | 'cancelled'
export const BOARD_EXPLORER_TABS: readonly BoardExplorerTab[] = ['needs', 'in_progress', 'review', 'planning', 'backlog', 'proposed', 'done', 'cancelled']
export interface BoardOptions {
  display: { layout: 'board' | 'list'; ordering: IssuesOrdering; showAgentTasks: boolean }
  filter: BoardFilter
  expanded: readonly string[]
  isMobile: boolean
  openIssueId: IssueId | null
  now: number
  menu?: boolean
}
export interface PoolBoardData {
  issues: IssueViewModel[]
  sessions: SessionView[]
  projectPaths: string[]
  menuInputs?: MissionActionInputs
  view: {
    nonArchived: IssueViewModel[]; scope: IssueViewModel[]; active: IssueViewModel[]
    assignees: string[]; labels: string[]; chips: { key: keyof BoardFilter; label: string }[]
    layout: 'board' | 'list'; boardIssues: IssueViewModel[]
    stageCounts: Map<string, { stage: IssueStage; count: number }[]>
    epicProgress: Map<string, TaskProgress | null>
    orderedByStage: { stage: IssueStage; issues: IssueViewModel[] }[]
    rowGroups: { stage: IssueStage; rows: IssueRow<IssueViewModel>[] }[]
    listIds: IssueId[]
    nav: { kind: 'rows'; ids: IssueId[] } | { kind: 'columns'; columns: IssueId[][] }
    presentIds: Set<string>; open?: IssueViewModel; orderedIdsForOpen: IssueId[]
  }
}
export interface PoolExplorerData {
  counts: Record<BoardExplorerTab, number>; tab: BoardExplorerTab; total: number
  rows: IssueViewModel[]; sessions: SessionView[]
  byId: Map<string, IssueViewModel>; rowSessions: Map<string, SessionView[]>
}
export interface BoardCatalog {
  scope: string[]; projectPaths: string[]; assignees: string[]; labels: string[]
}
export interface BoardQuery {
  kind: 'board' | 'explorer'; filter?: BoardFilter; showAgentTasks?: boolean
  tab?: BoardExplorerTab; query?: string
}
export interface IssueBoardSourceRows {
  issueBoardWindow: { openIssueId: IssueId | null }
  issueBoardQuery: { ids: string[] }
  issueBoardCatalog: BoardCatalog
  issueBoardModel: PoolBoardData
  issueExplorerModel: PoolExplorerData
  issueBoardRow: IssueViewModel
}
declare module './source-registry' { interface PoolSourceRows extends IssueBoardSourceRows {} }
export const ISSUE_BOARD_SOURCE_KEY = 'issue-board'
export const ISSUE_BOARD_ENTITIES = ['issueBoardWindow', 'issueBoardQuery', 'issueBoardCatalog', 'issueBoardModel', 'issueExplorerModel', 'issueBoardRow'] as const
/** Core already declares repo, treeParent/treeChildren, pageDependencies,
 * pageDependents and pageSessions. This screen uses those exact relations.
 * Cold cards/filtering need these projection fields, never a document panel. */
export const ISSUE_BOARD_SUMMARIES = {
  issue: [...ISSUE_PAGE_SUMMARIES.issue, 'priority', 'createdAt', 'type', 'description',
    'estimateMin', 'dueAt', 'intentOrigin', 'closedAt', 'branch', 'pinned', 'tuckedAt'],
  session: [...ISSUE_PAGE_SUMMARIES.session, 'refIssueId', 'createdAt', 'agentColor', 'displayRef',
    'stopReason', 'readAt', 'unread', 'snoozedUntil', 'createdBy', 'machineId', 'resumable'],
} as const
