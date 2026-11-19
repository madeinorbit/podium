import type { BoardFilter, IssuesOrdering } from '@podium/client-core/values'
import type { IssueBoardStage } from '@podium/model/browser'

export interface MobileTasksOptions {
  showDone: boolean
  expanded: readonly string[]
  filter: BoardFilter
  ordering: IssuesOrdering
  showAgentTasks: boolean
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
