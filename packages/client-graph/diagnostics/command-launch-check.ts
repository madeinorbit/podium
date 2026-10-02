/** Explicit side-by-side diagnostic. Row values stay in process; reports
 * contain counts and positions. Never imported by a product pool reader. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import type { PodiumClientApi } from '@podium/client-core/api'
import { beginSidebarCheck } from '@podium/client-core/perf'
import { lastUsedMaps, reposToViews, repoUsageAt, spawnTargetForRepo, type RepoNavView } from '@podium/client-core/viewmodels'
import { runInAction } from 'mobx'
import type { MobxPool } from '../src/pool'
import { commandLaunchViews, type CommandLaunchData } from '../src/command-launch-views'
import { COMMAND_SUMMARIES } from '../src/command-launch-schema'
import { LOADING } from '../src/worklist/rollup'
import { legacyDerivationFromStore } from './legacy'
import { compareSidebarSnapshots, type SidebarSnapshot, type CheckRow } from './sidebar-check'

const fields = (value: object, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key] ?? null]))
const issueFields = COMMAND_SUMMARIES.issue.filter(key => key !== 'displayRef')
function snapshot(data: Pick<CommandLaunchData, 'repos' | 'repoViews' | 'machines' | 'sessions' | 'issues' | 'repoChoices' | 'initialRepoPath' | 'spawnTargets'> & Partial<CommandLaunchData>): SidebarSnapshot {
  const issueRows: CheckRow[] = data.issues.map(issue => ({ id: issue.id, fields: { ...fields(issue, issueFields), displayRef: issue.displayRef ?? `#${issue.seq}` } }))
  const selected = data.issues.find(issue => issue.id === (data.openIssueId ?? data.selectedIssueId))
  return { pending: data.pending ?? 0, sections: [
    { key: 'window', fields: fields(data, ['paletteOpen', 'pins', 'selectedIssueId', 'openIssueId', 'selectedWorktree', 'paneA', 'recentFiles', 'sidebarSettings']), rows: [] },
    { key: 'repos', fields: {}, rows: data.repoViews.map(repo => ({ id: repo.path, fields: { value: repo } })) },
    { key: 'machines', fields: {}, rows: data.machines.map(machine => ({ id: machine.id, fields: { value: machine } })) },
    { key: 'sessions', fields: {}, rows: data.sessions.map(session => ({ id: session.sessionId, fields: fields(session, [...COMMAND_SUMMARIES.session, 'agentState']) })) },
    { key: 'issues', fields: {}, rows: issueRows },
    { key: 'selected', fields: selected ? fields(selected, ['id', 'unread', 'readAt', 'memberSessionIds', 'childCount', 'childDoneCount', 'gitState', 'needsHuman', 'blocked', 'stage', 'closedReason']) : { id: null }, rows: [] },
    { key: 'repoChoices', fields: { initialRepoPath: data.initialRepoPath }, rows: data.repoChoices.map(repo => ({ id: JSON.stringify([repo.machineId ?? '', repo.path]), fields: {} })) },
    { key: 'spawn', fields: {}, rows: data.spawnTargets.map(tree => ({ id: tree.path, fields: { value: tree } })) },
  ] }
}
export function poolCommandLaunchSnapshot(pool: MobxPool): SidebarSnapshot {
  const data = commandLaunchViews(pool).palette()
  if (!data || data === LOADING) return { pending: 1, sections: [] }
  return snapshot(data)
}
export function legacyCommandLaunchSnapshot(store: Store<PodiumClientApi>): SidebarSnapshot {
  const legacy = legacyDerivationFromStore(store), repos = store.repos, sessions = store.sessions, sections = legacy.slice.sections
  const repoViews = reposToViews(repos), current = repoViews.flatMap(repo => repo.worktrees).find(tree => tree.path === store.selectedWorktree)
  const { byRepo } = lastUsedMaps(sections, sessions)
  const navs: RepoNavView[] = [...sections.pinnedRepos, ...sections.repos]
  const repo = navs.reduce<RepoNavView | undefined>((best, r) => !best || (byRepo.get(r.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? r : best, undefined)
  const primary = repo ? spawnTargetForRepo(repo).worktree : undefined
  const choices = repos.filter(repo => repo.kind !== 'worktree')
  const initialRepoPath = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))[0]?.path ?? repos[0]?.path ?? ''
  const label = (path: string) => path.split('/').filter(Boolean).pop() ?? path
  const repoChoices = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions) || label(a.path).localeCompare(label(b.path), undefined, { sensitivity: 'base' }))
  return snapshot({ ...store, repoViews, repos, sessions, issues: legacy.models as CommandLaunchData['issues'], repoChoices, initialRepoPath,
    spawnTargets: [...(current ? [current] : []), ...(primary && primary.path !== current?.path ? [primary] : [])] })
}
export function checkCommandLaunch(pool: MobxPool, store: Store<PodiumClientApi>) {
  return compareSidebarSnapshots(legacyCommandLaunchSnapshot(store), poolCommandLaunchSnapshot(pool))
}
export function startCommandLaunchCheck(runtime: ClientRuntime<PodiumClientApi>, pool: MobxPool, intervalMs = 5000): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Command check interval must be positive')
  let checks = 0
  const timer = setInterval(() => {
    const finish = beginSidebarCheck(runtime)
    try {
      const result = runInAction(() => checkCommandLaunch(pool, runtime.getSnapshot()))
      if (typeof window !== 'undefined') Object.assign(window, { __commandLaunchCheck: { checks: ++checks, differences: result.differences, pending: result.pending,
        first: result.first ? { sectionIndex: result.first.sectionIndex, rowIndex: result.first.rowIndex, field: result.first.field } : null } })
    } finally { finish() }
  }, intervalMs)
  return () => clearInterval(timer)
}
