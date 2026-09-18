import type { IssueId } from '@podium/model'
import { type MainView, type RouteState, routeDefaults } from '../ui-state'
import { type FileTab, type RecentFileEntry, allTabIds, leafPaneIds, openTab } from '../viewmodels'
import {
  type EngineState, foregroundIssue, workspaceFor, workspaceKeyForState,
  workspaceMirrorPatch, workspaceWritePatch,
} from './state'

export interface NavigationIntent {
  view: MainView
  selectedIssueId?: IssueId | null
  selectedWorktree?: string | null
  tabId?: string | null
  firstPane?: boolean
  permanent?: boolean
  retireOrphanFiles?: boolean
  fileTab?: FileTab
  recentFile?: Omit<RecentFileEntry, 'openedAt'>
  /** Worklist/view changes replace workspace coordinates; explicit jumps push. */
  history?: 'view' | 'push'
}

/** Compute everything before touching state, history, timers or commands. */
export function planNavigation(
  state: Readonly<EngineState>, current: RouteState, intent: NavigationIntent,
  context: { visible: boolean; now: string },
) {
  const selection = {
    ...(intent.selectedIssueId !== undefined ? { selectedIssueId: intent.selectedIssueId } : {}),
    ...(intent.selectedWorktree !== undefined ? { selectedWorktree: intent.selectedWorktree } : {}),
  }
  const landing = { ...state, ...selection }
  const key = workspaceKeyForState(landing)
  const workspace = workspaceFor(landing, key)
  const next = intent.tabId ? openTab(workspace, intent.tabId, {
    permanent: intent.permanent !== false,
    ...(intent.firstPane ? { paneId: leafPaneIds(workspace.root)[0] } : {}),
  }) : workspace
  const patch: Partial<EngineState> = {
    ...selection,
    ...(intent.tabId ? workspaceWritePatch(landing, key, next) : workspaceMirrorPatch(next)),
    view: intent.view,
    settingsTab: null,
    openIssueId: null,
  }
  const route: RouteState = {
    ...routeDefaults(intent.view),
    worktree: intent.view === 'workspace' ? landing.selectedWorktree : current.worktree,
    pane: intent.view === 'workspace' ? patch.paneA ?? null : current.pane,
  }
  // setView of the current surface is inert, including an open issue/settings tab.
  if (intent.view === current.view) {
    patch.settingsTab = state.settingsTab
    patch.openIssueId = state.openIssueId
    route.settingsTab = current.settingsTab
    route.issueId = current.issueId
  }
  if (intent.fileTab && !state.fileTabs.some((tab) => tab.id === intent.fileTab!.id)) {
    patch.fileTabs = [...state.fileTabs, intent.fileTab]
  }
  if (intent.retireOrphanFiles) {
    const live = new Set(Object.values(patch.workspaces ?? state.workspaces).flatMap(allTabIds))
    const files = patch.fileTabs ?? state.fileTabs
    const kept = files.filter((tab) => live.has(tab.id))
    if (kept.length !== files.length) patch.fileTabs = kept
  }
  if (intent.recentFile) {
    const entry = intent.recentFile
    const same = (candidate: Omit<RecentFileEntry, 'openedAt'>) =>
      candidate.worktreePath === entry.worktreePath && candidate.path === entry.path &&
      candidate.artifact?.artifactId === entry.artifact?.artifactId
    if (!state.recentFiles[0] || !same(state.recentFiles[0])) {
      patch.recentFiles = [{ ...entry, openedAt: Date.parse(context.now) },
        ...state.recentFiles.filter((candidate) => !same(candidate))].slice(0, 30)
    }
  }
  const issue = context.visible ? foregroundIssue({ ...landing, ...patch }) : undefined
  patch.issueVisitBaseline = !issue ? null : state.issueVisitBaseline?.issueId === issue.id
    ? state.issueVisitBaseline
    : { issueId: issue.id, readAt: issue.readAt, openedAt: context.now }
  return { patch, route, key, replace: intent.history !== 'push' && current.view === intent.view }
}
