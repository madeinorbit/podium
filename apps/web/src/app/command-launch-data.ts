import { useStoreHandle } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/store'
import { lastUsedMaps, reposToViews, spawnTargetForRepo, type RepoNavView } from '@podium/client-core/viewmodels'
import { commandLaunchViews, type CommandLaunchData } from '@podium/client-graph/command-launch-views'
import { LOADING, type MobxPool } from '@podium/client-graph'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import { useSidebarProjectSections } from '@/features/worklist/use-sidebar-projects'
import { commandLaunchDataLayer, commandLaunchReadStats } from '@/lib/command-launch-data-layer'
import { useReplicaIssues, useStoreSelector, type Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Only identity-stable handles/actions are acquired here. No live field is
 * borrowed from a snapshot on the pool branch. The mutation owner is unchanged. */
const statics = (s: Store) => ({ trpc: s.trpc, setPaletteOpen: s.setPaletteOpen, closeIssue: s.closeIssue,
  markIssueRead: s.markIssueRead, markIssueUnread: s.markIssueUnread, updateIssue: s.updateIssue, deleteIssue: s.deleteIssue,
  deferIssue: s.deferIssue, undeferIssue: s.undeferIssue, setIssueLabels: s.setIssueLabels, restoreIssue: s.restoreIssue,
  markSessionRead: s.markSessionRead, markSessionUnread: s.markSessionUnread, setPane: s.setPane, setView: s.setView,
  setSettingsTab: s.setSettingsTab, setSelectedWorktree: s.setSelectedWorktree, setSelectedIssueId: s.setSelectedIssueId,
  setOpenIssueId: s.setOpenIssueId, setSnooze: s.setSnooze, clearSnooze: s.clearSnooze, hibernateSession: s.hibernateSession,
  resurrectSession: s.resurrectSession, startBtw: s.startBtw, spawnDraftAgent: s.spawnDraftAgent,
  setPanelMode: s.setPanelMode, openFileInWorktree: s.openFileInWorktree, openArtifact: s.openArtifact })
export function useCommandLaunchActions() {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => statics(owner.getSnapshot()), [owner])
}
const readLaunch = (pool: MobxPool) => commandLaunchViews(pool).launch()
const readPalette = (pool: MobxPool) => commandLaunchViews(pool).palette()
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
const readOpen = (pool: MobxPool) => { const row = pool.row('commandWindow', 'window'); return row && row !== LOADING ? row.paletteOpen : false }
function usePoolOpen() { return useWorklistPoolProjection(readOpen, false) }
function useLegacyOpen() { return useStoreSelector(s => s.paletteOpen) }
export function useCommandPaletteOpen() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolOpen : useLegacyOpen
  return useRead()
}
const EMPTY_SESSIONS: CommandLaunchData['sessions'] = []
const readSessions = (pool: MobxPool) => { const data = readLaunch(pool); return data && data !== LOADING ? data.sessions : EMPTY_SESSIONS }
function usePoolGuardSessions() { return useWorklistPoolProjection(readSessions, EMPTY_SESSIONS) }
function useLegacyGuardSessions() { return undefined }
export function useCommandGuardSessions() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolGuardSessions : useLegacyGuardSessions
  return useRead()
}
const EMPTY_FILES: Store['recentFiles'] = []
const readFiles = (pool: MobxPool) => { const row = pool.row('commandWindow', 'window'); return row && row !== LOADING ? row.recentFiles : EMPTY_FILES }
function usePoolFiles() { return useWorklistPoolProjection(readFiles, EMPTY_FILES) }
function useLegacyFiles() { return useStoreSelector(s => s.recentFiles) }
export function useCommandRecentFiles() {
  const useRead = commandLaunchDataLayer() === 'pool' ? usePoolFiles : useLegacyFiles
  return useRead()
}
