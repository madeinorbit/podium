import type { BoardFilter, filterChips, MissionProgress } from '@podium/client-core/values'
import type { MobileTaskIssue, MobileTasksBoard } from '@podium/client-graph/mobile-tasks'
import { LOADING } from '@podium/client-graph/worklist/rollup'
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
  /** Filters that differ from Reset, saved member filters included. */
  filterCount: number
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

/** Format the shared mission count, or the age of a task without children. */
export function taskRowFigure(
  progress: Pick<MissionProgress, 'done' | 'total'> | typeof LOADING | null | undefined,
  age: string | null | undefined,
): string {
  if (progress === LOADING) return ''
  if (progress) return `${progress.done}/${progress.total}`
  return compactAge(age)
}

/** "5 minutes ago" style stamps, cut to the row's width: "now", "6m", "3d". */
export function compactAge(age: string | null | undefined): string {
  if (!age) return ''
  return age.replace(/ ago$/, '').replace('just now', 'now')
}
