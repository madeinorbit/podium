import type { BoardFilter, filterChips } from '@podium/client-core/values'
import type { MobileTaskIssue, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { type IssueBoardStage, machinePathBasename } from '@podium/model'
import type { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import type { useRefreshableTab } from '../hooks/useRefreshableTab'
import type { WorkMenuActionId } from '../lib/work-menu'

/**
 * What both Tasks list surfaces take. The screen owns the board, the sheets and
 * every write; a surface only draws the board and reports what was asked.
 * `TasksSurface.ios.tsx` is a SwiftUI list, `TasksSurface.tsx` the React Native
 * one the web build and Android draw.
 */
export interface TasksSurfaceProps {
  board: MobileTasksBoard | null
  booting: boolean
  chips: ReturnType<typeof filterChips>
  refresh: ReturnType<typeof useRefreshableTab>
  minimizeOnScroll: ReturnType<typeof useMinimizeTabBarOnScroll>
  bottomInset: number
  onOpen: (id: string) => void
  onScreenProposals: () => void
  onRemoveFilter: (key: keyof BoardFilter) => void
  /** Long press on a row the surface cannot give a native menu. */
  onOpenActions: (issue: MobileTaskIssue) => void
  /** One of Work's long-press acts, picked from a native context menu. */
  onAction: (id: string, action: WorkMenuActionId) => void
  /** A status menu value (`issueStatusMenuEntries`). */
  onStatus: (id: string, value: string) => void
  /** The swipe's Close: closes the task as done, behind the close guard. */
  onClose: (id: string) => void
  onFilters: () => void
  onNewTask: () => void
}

/**
 * The Tasks subtitle: the project scope, then the In Progress and Review
 * counts from the board's own `stageCounts`. Presentation only.
 */
export function tasksSubtitle(
  projectPaths: readonly string[] | undefined,
  counts: Readonly<Record<IssueBoardStage, number>> | null,
): { project: string; counts: string } {
  const project = !projectPaths?.length
    ? 'All projects'
    : projectPaths.length === 1
      ? machinePathBasename(projectPaths[0]!)
      : `${projectPaths.length} projects`
  return {
    project,
    counts: counts ? `${counts.in_progress} in progress · ${counts.review} in review` : '',
  }
}

/** The trailing figure on a task row: child progress for a parent, else its age. */
export function taskRowFigure(
  issue: Pick<MobileTaskIssue, 'childCount' | 'childDoneCount'>,
  age: string | null | undefined,
): string {
  if (issue.childCount > 0) return `${issue.childDoneCount}/${issue.childCount}`
  return compactAge(age)
}

/**
 * The row's status mark, the board's three shapes: a filled dot when the task
 * waits on the operator (review, or an open question), a blue ring while it is
 * in progress, a quiet ring for resting work, and a tick once it is finished.
 */
export type TaskRowMark = 'needs' | 'working' | 'resting' | 'done'

export function taskRowMark(
  issue: Pick<MobileTaskIssue, 'stage' | 'needsHuman'>,
  finished: boolean,
): TaskRowMark {
  if (finished) return 'done'
  if (issue.needsHuman || issue.stage === 'review') return 'needs'
  if (issue.stage === 'in_progress') return 'working'
  return 'resting'
}

/** "5 minutes ago" style stamps, cut to the row's width: "now", "6m", "3d". */
export function compactAge(age: string | null | undefined): string {
  if (!age) return ''
  return age.replace(/ ago$/, '').replace('just now', 'now')
}
