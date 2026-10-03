import { useStoreHandle } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/store'
import { lastUsedMaps, reposToViews, spawnTargetForRepo, type RepoNavView } from '@podium/client-core/viewmodels'
import type { CommandLaunchData } from '@podium/client-graph/command-launch-views'
import { EMPTY_SESSIONS, EMPTY_FILES, readLaunch, readPalette, readGuardSessions, readOpen, readFiles } from './command-launch-readers'
import { LOADING } from '@podium/client-graph'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import { useSidebarProjectSections } from '@/features/worklist/use-sidebar-projects'
import { commandLaunchDataLayer, commandLaunchReadStats } from '@/lib/command-launch-data-layer'
import { useReplicaIssues, useStoreSelector, type Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Only identity-stable handles/actions are acquired here. No live field is
 * borrowed from a snapshot on the pool branch. The mutation owner is unchanged. */
const ACTION_KEYS = ['trpc', 'setPaletteOpen', 'closeIssue', 'markIssueRead', 'markIssueUnread', 'updateIssue', 'deleteIssue',
  'deferIssue', 'undeferIssue', 'setIssueLabels', 'restoreIssue', 'markSessionRead', 'markSessionUnread', 'setPane', 'setView',
  'setSettingsTab', 'setSelectedWorktree', 'setSelectedIssueId', 'setOpenIssueId', 'setSnooze', 'clearSnooze', 'hibernateSession',
  'resurrectSession', 'startBtw', 'spawnDraftAgent', 'setPanelMode', 'openFileInWorktree', 'openArtifact'] as const satisfies readonly (keyof Store)[]
type CommandLaunchActions = Pick<Store, typeof ACTION_KEYS[number]>
const statics = (s: Store): CommandLaunchActions => Object.fromEntries(ACTION_KEYS.map(key => [key, s[key]])) as CommandLaunchActions
export function useCommandLaunchActions(): CommandLaunchActions {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => statics(owner.getSnapshot()), [owner])
}
function usePoolLaunch() { return useWorklistPoolProjection(readLaunch, LOADING) }
function usePoolPalette() { return useWorklistPoolProjection(readPalette, LOADING) }
function useLegacyLaunch() {
  const owner = useStoreHandle<Trpc>()
  return useStoreSelector(s => { commandLaunchReadStats.legacy(owner); return { repos: s.repos, sessions: s.sessions ?? [], machines: s.machines ?? [] } }, shallowEqual)
}
export function useCommandLaunchData(): Loaded<CommandLaunchData> | ReturnType<typeof useLegacyLaunch> {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolLaunch : useLegacyLaunch
  return useRead()
}
function useLegacyPalette() {
  const owner = useStoreHandle<Trpc>()
  const data = useStoreSelector(s => { commandLaunchReadStats.legacy(owner); return { repos: s.repos, sessions: s.sessions,
    machines: s.machines, pins: s.pins, paneA: s.paneA, openIssueId: s.openIssueId, selectedIssueId: s.selectedIssueId, selectedWorktree: s.selectedWorktree } }, shallowEqual)
  const issues = useReplicaIssues(), sections = useSidebarProjectSections()
  const spawnTargets = useMemo(() => {
    const current = reposToViews(data.repos).flatMap(repo => repo.worktrees).find(tree => tree.path === data.selectedWorktree)
    const { byRepo } = lastUsedMaps(sections, data.sessions)
    const navs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
    const repo = navs.reduce<RepoNavView | undefined>((best, r) => !best || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best, undefined)
    const primary = repo ? spawnTargetForRepo(repo).worktree : undefined
    return [...(current ? [current] : []), ...(primary && primary.path !== current?.path ? [primary] : [])]
  }, [data.repos, data.sessions, sections, data.selectedWorktree])
  return { ...data, issues, spawnTargets }
}
export function useCommandPaletteData(): Loaded<CommandLaunchData> | ReturnType<typeof useLegacyPalette> {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolPalette : useLegacyPalette
  return useRead()
}
function usePoolOpen() { return useWorklistPoolProjection(readOpen, false) }
function useLegacyOpen() { return useStoreSelector(s => s.paletteOpen) }
export function useCommandPaletteOpen() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolOpen : useLegacyOpen
  return useRead()
}
function usePoolGuardSessions() { return useWorklistPoolProjection(readGuardSessions, EMPTY_SESSIONS) }
function useLegacyGuardSessions() { return undefined }
export function useCommandGuardSessions() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolGuardSessions : useLegacyGuardSessions
  return useRead()
}
function usePoolFiles() { return useWorklistPoolProjection(readFiles, EMPTY_FILES) }
function useLegacyFiles() { return useStoreSelector(s => s.recentFiles) }
export function useCommandRecentFiles() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolFiles : useLegacyFiles
  return useRead()
}
