import type { BoardFilter, IssuesOrdering } from '@podium/client-core/values'
import type { IssueBoardStage } from '@podium/model/browser'

export interface MobileTasksOptions {
  showDone: boolean
  expanded: readonly string[]
  filter: BoardFilter
  /** Omit display options to follow the shared issues.display preference. */
  ordering?: IssuesOrdering
  showAgentTasks?: boolean
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
/** Stages the phone board opens folded until the operator unfolds them: it
 * leads with live work, and Proposed is a screening queue, not a list. */
export const MOBILE_TASK_FOLDED_BY_DEFAULT: Readonly<Record<IssueBoardStage, boolean>> = {
  in_progress: false,
  review: false,
  planning: false,
  backlog: true,
  proposed: true,
  done: true,
}
