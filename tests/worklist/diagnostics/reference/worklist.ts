import { allIssueViewModels } from './issue-view-models'
import { reposVisibleOnMachines, splitPinnedWork, orderedSidebarProjects, orderProjectGroups } from '@podium/client-core/values'
import { sidebarSections, unifiedWorkList, groupUnifiedWorkRows } from '../../legacy-values/index'
import type { ReferenceState } from '../reference-state'

export function deriveWorklist(store: ReferenceState) {
  const issues = allIssueViewModels(store.replica, store.issueProjections, store.issueUserStates)
  const sections = sidebarSections(reposVisibleOnMachines(store.repos, store.machines), store.sessions, store.pins, store.coarseNow, issues)
  const allWorktreePaths = [...sections.pinnedRepos, ...sections.repos].flatMap(repo => repo.worktrees.map(tree => tree.path))
  const work = unifiedWorkList(sections, issues, store.sessions, allWorktreePaths, store.coarseNow)
  const { pinned, rest } = splitPinnedWork(work)
  const groups = groupUnifiedWorkRows(rest, null, false, store.coarseNow)
  const projects = orderedSidebarProjects(sections, groups, store.sidebarSettings?.repoSort === 'custom' ? store.sidebarSettings.repoOrder : [])
  return { sections, allWorktreePaths, work, pinned, projects, groups: orderProjectGroups(groups, projects), now: store.coarseNow }
}
export const worklistSlice = { derive: deriveWorklist }
export type WorklistSlice = ReturnType<typeof deriveWorklist>
