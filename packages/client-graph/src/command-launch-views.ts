import type { SpawnTarget } from '@podium/client-core'
import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/viewmodels'
import { normalizeOriginUrl, repoNameFromOrigin } from '@podium/model/browser'
import { computed, compareStructural } from 'mobx'
import type { MobxPool } from './pool'
import { COMMAND_SUMMARIES, type CommandLaunchRows } from './command-launch-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export type CommandLaunchData = CommandLaunchRows['commandWindow'] & {
  repos: Store['repos']
  repoViews: RepoView[]
  machines: CommandLaunchRows['commandMachine'][]
  sessions: SessionView[]
  issues: IssueViewModel[]
  repoChoices: Store['repos']
  initialRepoPath: string
  spawnTargets: SpawnTarget[]
  usage: Readonly<Record<string, number>>
  pending: number
}

/** Projection owns no rows, runtime or outbox. Every value read is through
 * pool.row; declared relation buckets contain resident IDs only. */
export function createCommandLaunchViews(pool: MobxPool) {
  const read = <E extends keyof CommandLaunchRows>(entity: E, id: string) => pool.row(entity, id) as Loaded<CommandLaunchRows[E]>
  function projection(palette: boolean): Loaded<CommandLaunchData> {
    const catalog = read('commandCatalog', 'catalog'), window = read('commandWindow', 'window')
    if (catalog === LOADING || window === LOADING) return LOADING
    if (!catalog || !window) return undefined
    let pending = 0
    const rows = <E extends keyof CommandLaunchRows>(entity: E, ids: readonly string[]): CommandLaunchRows[E][] => ids.flatMap(id => {
      const row = read(entity, id)
      if (row === LOADING) { pending++; return [] }
      return row ? [row] : []
    })
    const repos = rows('commandRepository', catalog.repositories), machines = rows('commandMachine', catalog.machines)
    const repoViews: RepoView[] = []
    for (const id of catalog.repos) {
      if (!read('commandRepo', id)) continue
      const memberIds = pool.sources.related('commandRepo', id, 'repositories')
      const scans = rows('commandRepository', catalog.repositories.filter(key => memberIds.includes(key))).filter(scan => !scan.linked)
      const first = scans[0]
      if (!first) continue
      const treeIds = pool.sources.related('commandRepo', id, 'worktrees')
      const worktrees = rows('commandWorktree', catalog.worktrees.filter(key => treeIds.includes(key))).map(({ repositoryId: _scan, groupId: _group, ...tree }) => tree)
      const originUrl = scans.map(scan => normalizeOriginUrl(scan.originUrl)).find(Boolean)
      const repoId = scans.find(scan => scan.repoId !== undefined)?.repoId
      repoViews.push({ path: first.path, name: repoNameFromOrigin(originUrl) ?? (first.path.split('/').pop() || first.path), worktrees,
        machines: scans.flatMap(scan => scan.machineId ? [{ machineId: scan.machineId, path: scan.path }] : []),
        ...(originUrl !== undefined ? { originUrl } : {}), ...(repoId !== undefined ? { repoId } : {}) })
    }
    // No cold index. Declared summaries suffice for menu labels and placement;
    // only selected contextual commands require full rows and batched loads.
    const sessions = catalog.sessions.flatMap(id => {
      const value = pool.row('session', id, 'summary')
      if (value === LOADING) { pending++; return [] }
      return value ? [value as SessionView] : []
    })
    const usage: Record<string, number> = {}, visibleSessions = new Set(catalog.sessions)
    const coldSessions = sessions.filter(session => !pool.resident('session', session.sessionId))
    for (let index = 0; index < repos.length; index++) {
      const repo = repos[index]!, key = JSON.stringify([repo.machineId ?? '', repo.path])
      let at = 0
      for (const id of pool.sources.related('commandRepository', key, 'sessions')) {
        if (!visibleSessions.has(id)) continue
        const session = pool.row('session', id, 'summary') as Loaded<SessionView>
        if (session && session !== LOADING) at = Math.max(at, Date.parse(session.lastActiveAt) || 0)
      }
      for (const session of coldSessions) {
        // Cold summaries are intentionally not inserted in resident buckets.
        if (![repo.path, ...repo.worktrees.map(tree => tree.path)].some(root => session.cwd === root || session.cwd.startsWith(`${root}/`))) continue
        at = Math.max(at, Date.parse(session.lastActiveAt) || 0)
      }
      usage[key] = at
    }
    const repoTime = (repo: Store['repos'][number]) => usage[JSON.stringify([repo.machineId ?? '', repo.path])] ?? 0
    const choices = repos.filter(repo => repo.kind !== 'worktree')
    const initialRepoPath = [...choices].sort((a, b) => repoTime(b) - repoTime(a))[0]?.path ?? repos[0]?.path ?? ''
    const repoChoices = [...choices].sort((a, b) => repoTime(b) - repoTime(a) ||
      (a.path.split('/').filter(Boolean).pop() ?? a.path).localeCompare(b.path.split('/').filter(Boolean).pop() ?? b.path, undefined, { sensitivity: 'base' }))
    const issues: IssueViewModel[] = []
    if (palette) for (const id of catalog.issues) {
      const value = pool.row('commandIssue', id)
      if (value === LOADING) { pending++; continue }
      if (!value) continue
      const row = Object.fromEntries(COMMAND_SUMMARIES.issue.map(field => [field,
        (value as unknown as Record<string, unknown>)[field]])) as unknown as IssueViewModel
      // Full selected detail is requested through the existing batch window.
      const selected = id === (window.openIssueId ?? window.selectedIssueId)
      if (selected) {
        const full = pool.row('issue', id)
        if (full === LOADING) { pending++; continue }
        if (!full) continue
        const node = pool.issue(id), children = [...pool.graph.many('issue', id, 'treeChildren')]
        let childDoneCount = 0
        for (const child of children) {
          const detail = pool.row('issue', child, 'summary')
          if (detail === LOADING) pending++
          else if (detail && (detail as { stage: string }).stage === 'done') childDoneCount++
        }
        const members = new Set(pool.sources.related('commandIssue', id, 'sessions'))
        for (const session of coldSessions) if (session.issueId === id && session.agentKind !== 'shell') members.add(session.sessionId)
        issues.push({ ...full, displayRef: node?.displayRef ?? row.displayRef ?? `#${row.seq}`,
          readAt: pool.readCursor(id) ?? null, unread: node?.unread ?? false,
          memberSessionIds: catalog.sessions.filter(sid => members.has(sid)), childCount: children.length, childDoneCount } as unknown as IssueViewModel)
      } else {
        const repoId = pool.graph.one('issue', id, 'repo'), repo = repoId ? pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
        issues.push({ ...row, displayRef: row.displayRef ?? (repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`) } as IssueViewModel)
      }
    }
    const trees = repoViews.flatMap(repo => repo.worktrees)
    const current = trees.find(tree => tree.path === window.selectedWorktree)
    const pinPaths = window.pins.worktrees ?? [], pinnedRepos = window.pins.repos ?? []
    const navRepos = [...pinnedRepos.flatMap(path => repoViews.filter(repo => repo.path === path)),
      ...repoViews.filter(repo => !pinnedRepos.includes(repo.path) && repo.worktrees.some(tree => !pinPaths.includes(tree.path)))]
    const byRepo = new Map<string, number>()
    const pathToRepo = new Map(trees.map(tree => [tree.path, tree.repoPath]))
    // Worktrees under grouped clones aggregate to the canonical path unless
    // separately pinned, which retains its original repoPath (today's rule).
    for (const repo of repoViews) for (const tree of repo.worktrees) if (!pinPaths.includes(tree.path)) pathToRepo.set(tree.path, repo.path)
    for (const session of sessions) {
      const path = pathToRepo.get(session.cwd) ?? session.cwd, at = Date.parse(session.lastActiveAt) || 0
      byRepo.set(path, Math.max(at, byRepo.get(path) ?? 0))
    }
    const defaultRepo = navRepos.reduce<RepoView | undefined>((best, repo) => !best || (byRepo.get(repo.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? repo : best, undefined)
    const primary = defaultRepo ? defaultRepo.worktrees.find(tree => !pinPaths.includes(tree.path) && tree.isMain && tree.path === defaultRepo.path)
      ?? defaultRepo.worktrees.find(tree => !pinPaths.includes(tree.path) && tree.path === defaultRepo.path)
      ?? { path: defaultRepo.path, repoPath: defaultRepo.path, isMain: true, ...(defaultRepo.repoId ? { repoId: defaultRepo.repoId } : {}) } : undefined
    const spawnTargets = [...(current ? [current] : []), ...(primary && primary.path !== current?.path ? [primary] : [])]
    return { ...window, repos, repoViews, machines, sessions, issues, usage, repoChoices, initialRepoPath, spawnTargets, pending }
  }
  const launch = computed(() => projection(false), { equals: compareStructural }), palette = computed(() => projection(true), { equals: compareStructural })
  return { launch: () => launch.get(), palette: () => palette.get() }
}
const views = new WeakMap<MobxPool, ReturnType<typeof createCommandLaunchViews>>()
export function commandLaunchViews(pool: MobxPool) {
  let value = views.get(pool)
  if (!value) { value = createCommandLaunchViews(pool); views.set(pool, value) }
  return value
}
