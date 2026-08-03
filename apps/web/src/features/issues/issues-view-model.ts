import { filterBoardScope } from '@podium/client-core/viewmodels'
import type { IssueId, IssueStage } from '@podium/model'
import type { IssueViewModel } from '@/app/store'
import { type BoardFilter, filterBoardIssues, filterChips } from './issue-board-filter'
import {
  childStageCounts,
  flattenRowGroups,
  issuePageOrderIds,
  issueRowsByStage,
  partitionIssueTree,
} from './issue-hierarchy'
import { groupIssuesByStage } from './issue-list'
import {
  computeEpicProgressMap,
  type EpicProgress,
  type IssuesDisplay,
  type IssuesLayout,
} from './issues-display'
import type { IssuesNav } from './issues-keys'

export type IssuesDisplayPatch = Partial<Omit<IssuesDisplay, 'badges'>> & {
  badges?: Partial<IssuesDisplay['badges']>
}

export interface IssuesViewModel {
  readonly nonArchived: IssueViewModel[]
  readonly scope: IssueViewModel[]
  readonly active: IssueViewModel[]
  readonly assignees: string[]
  readonly labels: string[]
  readonly chips: ReturnType<typeof filterChips>
  readonly layout: IssuesLayout
  readonly boardIssues: IssueViewModel[]
  readonly stageCounts: Map<string, { stage: IssueStage; count: number }[]>
  readonly epicProgress: Map<string, EpicProgress | null>
  readonly orderedByStage: { stage: IssueStage; issues: IssueViewModel[] }[]
  readonly rowGroups: ReturnType<typeof issueRowsByStage>
  readonly listIds: IssueId[]
  readonly nav: IssuesNav
  readonly presentIds: Set<string>
  readonly open?: IssueViewModel
  readonly orderedIdsForOpen: IssueId[]
}

/**
 * The Issues surface's complete render model. This is deliberately pure: the
 * composer supplies the published issue view models and local display/filter
 * state, while every board/list consumer reads one coherent answer. The
 * cross-surface scope gate comes from client-core's published issues slice.
 */
export function deriveIssuesViewModel({
  issues,
  display,
  filter,
  expanded,
  isMobile,
  openIssueId,
}: {
  issues: IssueViewModel[]
  display: IssuesDisplay
  filter: BoardFilter
  expanded: ReadonlySet<string>
  isMobile: boolean
  openIssueId: string | null
}): IssuesViewModel {
  const nonArchived = issues.filter((issue) => !issue.archived && !issue.deletedAt)
  const scope = filterBoardScope(nonArchived, display.showAgentTasks)
  const active = filterBoardIssues(filterBoardScope(issues, display.showAgentTasks), filter)
  const assignees = [
    ...new Set(scope.map((issue) => issue.assignee).filter(Boolean)),
  ].sort() as string[]
  const labels = [...new Set(scope.flatMap((issue) => issue.labels))].sort()
  const boardIssues = display.flatten ? active : partitionIssueTree(active).roots
  const stageCounts = display.flatten
    ? new Map<string, { stage: IssueStage; count: number }[]>()
    : childStageCounts(scope)
  const epicProgress = computeEpicProgressMap(
    nonArchived,
    boardIssues.map((issue) => issue.id),
  )
  const orderedByStage = groupIssuesByStage(boardIssues, display.ordering)
  const rowGroups = issueRowsByStage(active, display.ordering, {
    flatten: display.flatten,
    expanded,
  })
  const listIds = flattenRowGroups(rowGroups)
  const layout: IssuesLayout = isMobile ? 'list' : display.layout
  const nav: IssuesNav =
    layout === 'list'
      ? { kind: 'rows', ids: listIds }
      : { kind: 'columns', columns: orderedByStage.map((column) => column.issues.map((i) => i.id)) }
  const presentIds = new Set(nav.kind === 'rows' ? nav.ids : nav.columns.flat())
  const open = openIssueId ? issues.find((issue) => issue.id === openIssueId) : undefined
  const flatRows = issueRowsByStage(active, display.ordering, {
    flatten: true,
    expanded,
  })
  const orderedIdsForOpen = open
    ? issuePageOrderIds(listIds, flattenRowGroups(flatRows), open.id)
    : []

  return {
    nonArchived,
    scope,
    active,
    assignees,
    labels,
    chips: filterChips(filter),
    layout,
    boardIssues,
    stageCounts,
    epicProgress,
    orderedByStage,
    rowGroups,
    listIds,
    nav,
    presentIds,
    ...(open ? { open } : {}),
    orderedIdsForOpen,
  }
}
