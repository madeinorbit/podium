import { recordSliceDerivation } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { shallowEqual } from '@podium/client-core/store'
import type { IssueViewModel } from '@podium/client-core/replica'
import { cwdInWorktree, issueForCwd, reposToViews, resolveActiveWorktree, selectedMissionRoot } from '@podium/client-core/viewmodels'
import { shellViews, type ShellDockData } from '@podium/client-graph/shell-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import { shellDataLayer } from './shell-pool-screen'
import { type Store, useReplicaIssues, useStoreSelector } from './store'
import { useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Identity-stable actions/transports only; the existing runtime remains the
 * mutation owner. Live values never come from this one-time acquisition. */
const ACTIONS = ['trpc', 'hub', 'httpOrigin', 'uiState', 'navigateToSession', 'closeAutoContinuePrompt',
  'setSelectedIssueId', 'setView', 'setSuperOpen', 'setPaletteOpen', 'setOpenIssueId', 'openArtifact',
  'openFileInWorktree', 'closeFileTab', 'closeWorkspaceTab', 'setSettingsTab'] as const satisfies readonly (keyof Store)[]
export function useShellActions(): Pick<Store, typeof ACTIONS[number]> {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => {
    const state = owner.getSnapshot()
    return Object.fromEntries(ACTIONS.map(key => [key, state[key]])) as Pick<Store, typeof ACTIONS[number]>
  }, [owner])
}
const legacy = (owner: object, name: string) => recordSliceDerivation(owner, `shell.${name}`)
const EMPTY_DOCK: ShellDockData = { active: null, scope: null, gitIssue: undefined, mailIssueId: undefined,
  issues: [], shipOrders: [], shipLanes: [], coarseNow: 0, shipping: { unfinishedCount: 0, decisionCount: 0 } }
function usePoolDock(): ShellDockData {
  const pool = useWorklistPool(), value = pool ? shellViews(pool).dock() : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK
}
function useLegacyDock(): ShellDockData {
  const owner = useStoreHandle<Trpc>()
  const data = useStoreSelector(state => {
    legacy(owner, 'dock.read')
    return { paneA: state.paneA, fileTabs: state.fileTabs, sessions: state.sessions, repos: state.repos,
      shipOrders: state.shipOrders, shipLanes: state.shipLanes, coarseNow: state.coarseNow }
  }, shallowEqual)
  const issues = useReplicaIssues()
  return useMemo(() => {
    legacy(owner, 'dock.derive')
    const { paneA, fileTabs, sessions, repos, shipOrders, shipLanes, coarseNow } = data
    const active = resolveActiveWorktree({ paneA, fileTabs, sessions })
    let scope: ShellDockData['scope'] = null
    if (active) {
      for (const repo of reposToViews(repos)) {
        const worktree = repo.worktrees.filter(candidate => (!active.machineId || !candidate.machineId || candidate.machineId === active.machineId) && cwdInWorktree(active.cwd, candidate.path))
          .sort((a, b) => b.path.length - a.path.length)[0]
        if (worktree) { scope = { repoId: repo.repoId ?? worktree.repoId ?? null, repoPath: worktree.repoPath }; break }
      }
      if (!scope) {
        const id = active.issueId ?? sessions.find(session => session.sessionId === active.sessionId)?.issueId
        const task = id ? issues.find(issue => issue.id === id) : issueForCwd(issues, active.cwd)
        if (task) scope = { repoId: task.repoId ?? null, repoPath: task.repoPath }
      }
    }
    return { active, scope, issues, shipOrders, shipLanes, coarseNow,
      gitIssue: active ? (active.issueId ? issues.find(issue => issue.id === active.issueId) : undefined) ?? issueForCwd(issues, active.cwd) ?? undefined : undefined,
      mailIssueId: active ? sessions.find(session => session.sessionId === active.sessionId)?.issueId ?? issueForCwd(issues, active.cwd)?.id : undefined,
      shipping: { unfinishedCount: 0, decisionCount: 0 } }
  }, [owner, data, issues])
}
/** Large pool reads run inside their consumer's MobX observer. The startup
 * choice never depends on whether a pool happens to be attached yet. */
export function useShellDock(): ShellDockData { const useRead = shellDataLayer() === 'pool' ? usePoolDock : useLegacyDock; return useRead() }
export function useShellShipping() {
  const pool = useWorklistPool(), value = pool ? shellViews(pool).shipping() : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK.shipping
}

function usePoolWindow() { const pool = useWorklistPool(); const value = pool?.row('shellWindow', 'window'); return value === LOADING ? undefined : value }
function useLegacyWindow() {
  const owner = useStoreHandle<Trpc>()
  return useStoreSelector(state => { legacy(owner, 'window.read'); return { view: state.view, paneA: state.paneA, selectedIssueId: state.selectedIssueId,
    selectedWorktree: state.selectedWorktree, reposLoaded: state.reposLoaded, superOpen: state.superOpen, paletteOpen: state.paletteOpen, autoContinuePromptSessionId: state.autoContinuePromptSessionId, coarseNow: state.coarseNow } }, shallowEqual)
}
export function useShellWindow() { const useRead = shellDataLayer() === 'pool' ? usePoolWindow : useLegacyWindow; return useRead() }
function usePoolApprovals() { const pool = useWorklistPool(), rows = pool ? shellViews(pool).approvals() : LOADING; return rows && rows !== LOADING ? rows : EMPTY_APPROVALS }
const EMPTY_APPROVALS: Store['approvals'] = []
function useLegacyApprovals() { const owner = useStoreHandle<Trpc>(); return useStoreSelector(state => { legacy(owner, 'approvals.read'); return state.approvals }) }
export function useShellApprovals() { const useRead = shellDataLayer() === 'pool' ? usePoolApprovals : useLegacyApprovals; return useRead() }

const EMPTY_SESSIONS: Store['sessions'] = []
const EMPTY_ISSUES: Store['issueProjections'] = []
function usePoolLinks() {
  const pool = useWorklistPool(), views = pool ? shellViews(pool) : null
  const sessions = views?.sessions(), issues = views?.issues()
  return { sessions: sessions && sessions !== LOADING ? sessions : EMPTY_SESSIONS, issues: issues && issues !== LOADING ? issues : EMPTY_ISSUES as unknown as IssueViewModel[],
    artifactIssue: (id: string) => { const row = views?.issue(id, true); return row && row !== LOADING ? row as IssueViewModel : undefined }, pool }
}
function useLegacyLinks() {
  const owner = useStoreHandle<Trpc>()
  const sessions = useStoreSelector(state => { legacy(owner, 'links.read'); return state.sessions })
  const issues = useReplicaIssues()
  return { sessions, issues, artifactIssue: (id: string) => issues.find(issue => issue.id === id), pool: null }
}
export function useShellLinks() { const useRead = shellDataLayer() === 'pool' ? usePoolLinks : useLegacyLinks; return useRead() }
function usePoolSessions() { const pool = useWorklistPool(), value = pool ? shellViews(pool).sessions() : LOADING; return value && value !== LOADING ? value : EMPTY_SESSIONS }
function useLegacySessions() { const owner = useStoreHandle<Trpc>(); return useStoreSelector(state => { legacy(owner, 'browser.read'); return state.sessions }) }
export function useShellSessions() { const useRead = shellDataLayer() === 'pool' ? usePoolSessions : useLegacySessions; return useRead() }

function usePoolClose() { const pool = useWorklistPool(), value = pool ? shellViews(pool).close() : LOADING; return value && value !== LOADING ? value : undefined }
function useLegacyClose() {
  const owner = useStoreHandle<Trpc>()
  return useStoreSelector(state => { legacy(owner, 'close.read'); const workspaceKey = state.workspaceKey(); return { workspaceKey, layout: state.workspaces[workspaceKey], fileTabs: state.fileTabs } }, shallowEqual)
}
export function useShellClose() { const useRead = shellDataLayer() === 'pool' ? usePoolClose : useLegacyClose; return useRead() }
const EMPTY_MACHINES: Store['machines'] = []
function usePoolMachines() { const pool = useWorklistPool(); return pool ? shellViews(pool).machines() : EMPTY_MACHINES }
function useLegacyMachines() { const owner = useStoreHandle<Trpc>(); return useStoreSelector(state => { legacy(owner, 'machines.read'); return state.machines }) }
export function useShellMachines() { const useRead = shellDataLayer() === 'pool' ? usePoolMachines : useLegacyMachines; return useRead() }

const EMPTY_CHROME = { view: 'workspace' as Store['view'], reposLoaded: false, superOpen: false, paletteOpen: false, repoCount: 0, worktreeCount: 0, sessionCount: 0,
  selectedIssueId: null as Store['selectedIssueId'], missionRoot: undefined as ReturnType<typeof selectedMissionRoot>, colorIssue: undefined as IssueViewModel | undefined, colors: [] as IssueViewModel[] }
function usePoolChrome() { const pool = useWorklistPool(), value = pool ? shellViews(pool).chrome() : LOADING; return value && value !== LOADING ? value : EMPTY_CHROME }
function useLegacyChrome() {
  const owner = useStoreHandle<Trpc>()
  const state = useStoreSelector(s => { legacy(owner, 'chrome.read'); return { view: s.view, repos: s.repos, reposLoaded: s.reposLoaded, superOpen: s.superOpen, paletteOpen: s.paletteOpen, sessions: s.sessions, selectedIssueId: s.selectedIssueId } }, shallowEqual)
  const issues = useReplicaIssues()
  const { sessions, selectedIssueId } = state
  legacy(owner, 'mission.derive')
  const flightDeckMission = selectedMissionRoot(issues, sessions, selectedIssueId)
  return { ...state, repoCount: state.repos.length, worktreeCount: state.repos.reduce((n, repo) => n + repo.worktrees.length, 0), sessionCount: state.sessions.length,
    colorIssue: issues.find(issue => issue.id === state.selectedIssueId && !issue.archived && !issue.deletedAt), colors: issues, missionRoot: flightDeckMission }
}
export function useShellChrome() { const useRead = shellDataLayer() === 'pool' ? usePoolChrome : useLegacyChrome; return useRead() }
