import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type {
  BoardFilter,
  IssueRow,
  IssuesOrdering,
  MissionProgress,
  TaskProgress,
} from '@podium/client-core/viewmodels'
import type { IssueBoardStage } from '@podium/model/browser'
import { ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { MISSION_SUMMARIES } from './mission-schema'
import { MISSION_VIEW_SUMMARIES } from './mission-view-schema'
import { MOBILE_SESSION_SUMMARIES } from './mobile-session-schema'
import { mergePoolSummaries } from './source-registry'

export interface MobileTasksOptions {
  showDone: boolean
  expanded: readonly string[]
  filter: BoardFilter
  ordering: IssuesOrdering
  showAgentTasks: boolean
}
export interface MobileTaskSection {
  stage: IssueBoardStage
  title: string
  rows: IssueRow<IssueViewModel>[]
}
export interface MobileTasksData {
  issues: IssueViewModel[]
  sessions: SessionView[]
  board: MobileTaskSection[]
  workingByIssue: Map<string, number>
  progressByIssue: Map<string, TaskProgress | null>
  proposals: number
}
export interface MobileMissionData {
  root: IssueViewModel | undefined
  issues: IssueViewModel[]
  sessions: SessionView[]
  missionSessions: SessionView[]
  progress: MissionProgress
}
export const EMPTY_MOBILE_TASKS: MobileTasksData = {
  issues: [],
  sessions: [],
  board: [],
  workingByIssue: new Map(),
  progressByIssue: new Map(),
  proposals: 0,
}
export const EMPTY_MOBILE_MISSION: MobileMissionData = {
  root: undefined,
  issues: [],
  sessions: [],
  missionSessions: [],
  progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
}
export interface MobileScreenRows {
  mobileScreenReader: ReturnType<typeof import('./mobile-screens').createMobileScreenReader>
}
declare module './source-registry' {
  interface PoolSourceRows extends MobileScreenRows {}
}
export const MOBILE_SCREEN_SOURCE_KEY = 'mobile-screens'
export const MOBILE_SCREEN_ENTITIES = ['mobileScreenReader'] as const
export const MOBILE_TASK_STAGES: readonly IssueBoardStage[] = [
  'in_progress',
  'review',
  'planning',
  'backlog',
  'proposed',
  'done',
]

/** All relationships already belong to shared/schema.ts. This screen adds no
 * relation index: query results and presentation maps live only while observed. */
export const MOBILE_SCREEN_SCHEMA = {
  mobileScreenReader: { key: 'reader', source: 'existing pool', residency: 'principal' },
  tasks: {
    candidates: 'issueBoardQuery: boardIssues declared cold question + resident index',
    rows: 'issueBoardRow',
    cards: 'issueBoardCard',
    parent: 'treeParent',
    children: 'treeChildren',
    proposals: 'issueBoardQuery: proposed, then declared ancestor summaries',
  },
  mission: {
    root: 'mission.rootFor',
    members: 'mission.members',
    rows: 'mission-view reader',
    sessions: 'missionSessions',
    provenance: 'missionStartedIssues',
    context: ['pageDependencies', 'pageDependents', 'supersedingIssue', 'canonicalIssue'],
  },
  writes: 'existing runtime actions and outbox',
} as const
export const MOBILE_SCREEN_SUMMARIES = mergePoolSummaries(
  ISSUE_BOARD_SUMMARIES,
  MISSION_SUMMARIES,
  MISSION_VIEW_SUMMARIES,
  MOBILE_SESSION_SUMMARIES,
  { issue: ['sortKey', 'startedBySession'] },
)
