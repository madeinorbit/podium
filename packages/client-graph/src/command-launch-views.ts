import { keyedComputed } from '@podium/mobx-helpers'
import { isFinished } from './shared/predicates'
import type { SpawnTarget } from '@podium/client-core'
import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/values'
import { normalizeOriginUrl, repoNameFromOrigin } from '@podium/model/browser'
import {
  compareStructural,
  computed,
  untracked,
} from 'mobx'
import { COMMAND_SUMMARIES, type CommandLaunchRows } from './command-launch-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

export type CommandLaunchData = CommandLaunchRows['commandWindow'] & {
  repos: Store['repos']
  repoViews: RepoView[]
  machines: CommandLaunchRows['commandMachine'][]
  sessionIds: readonly string[]
  issues: IssueViewModel[]
  repoChoices: Store['repos']
  initialRepoPath: string
  spawnTargets: SpawnTarget[]
  usage: Readonly<Record<string, number>>
  pending: number
}

type Common = Pick<
  CommandLaunchData,
  'repos' | 'repoViews' | 'machines' | 'usage' | 'repoChoices' | 'initialRepoPath' | 'pending'
> & {
  issueIds: readonly string[]
}

/** Global browsing values have no selection dependency. Only the small
 * placement and selected-context overlays read their window fields. */
function createCommandLaunchViews(pool: MobxPool) {
  const read = <E extends keyof CommandLaunchRows>(entity: E, id: string) =>
    pool.row(entity, id) as Loaded<CommandLaunchRows[E]>
  const counts = {
    catalogBuilds: 0,
    issueBuilds: 0,
    coldSessionVisits: 0,
    usageQueries: 0,
    addressedSessionReads: 0,
    repositoryBuilds: 0,
    optionUsageQueries: 0,
  }
  type Window = CommandLaunchRows['commandWindow']
  function windowField<K extends keyof Window>(key: K): Loaded<Window[K]> {
    const window = read('commandWindow', 'window')
    return window && window !== LOADING ? window[key] : window
  }
  // Membership observes only the declared catalog. Each displayed row owns
  // its keyed value; metadata never needs a hand-maintained projection clock.
  const sessionIds = computed((): Loaded<readonly string[]> => {
    const catalog = read('commandCatalog', 'catalog')
    return catalog && catalog !== LOADING ? catalog.sessions : catalog
  }, { equals: compareStructural })
  const session = keyedComputed('commands.session', (id: string): Loaded<SessionView> => {
    counts.addressedSessionReads++
    // untracked-read: launch-session-seed
    if (untracked(() => !pool.tables.session.has(id))) counts.coldSessionVisits++
    const row = pool.row('session', id, 'summary-fields') as Loaded<SessionView>
    // Snapshot joined getter fields inside this addressed derivation.
    return row && row !== LOADING ? { ...row } : row
  }, { equals: compareStructural })
  // Search and launch choices explicitly license browsing summaries while the
  // menu is open. The shared launch/window projection carries only their ids.
  const sessions = computed(() => {
    const ids = sessionIds.get()
    if (!ids || ids === LOADING) return ids
    const sessions: SessionView[] = []
    for (const id of ids) {
      const row = session(id)
      if (row && row !== LOADING) sessions.push(row)
    }
    return sessions
  }, { equals: compareStructural })
  const sessionMembership = computed(() => {
    const ids = sessionIds.get()
    return ids && ids !== LOADING ? new Set(ids) : ids
  })
  const common = computed(
    (): Loaded<Common> => {
      const catalog = read('commandCatalog', 'catalog')
      if (catalog === LOADING || !catalog) return catalog
      counts.catalogBuilds++
      let pending = 0
      const rows = <E extends keyof CommandLaunchRows>(
        entity: E,
        ids: readonly string[],
      ): CommandLaunchRows[E][] =>
        ids.flatMap((id) => {
          const row = read(entity, id)
          if (row === LOADING) {
            pending++
            return []
          }
          return row ? [row] : []
        })
      const repos = rows('commandRepository', catalog.repositories),
        machines = rows('commandMachine', catalog.machines)
      const repoViews: RepoView[] = []
      for (const id of catalog.repos) {
        if (!read('commandRepo', id)) continue
        const memberIds = pool.sources.related('commandRepo', id, 'repositories')
        const scans = rows(
          'commandRepository',
          catalog.repositories.filter((key) => memberIds.includes(key)),
        ).filter((scan) => !scan.linked)
        const first = scans[0]
        if (!first) continue
        const treeIds = pool.sources.related('commandRepo', id, 'worktrees')
        const worktrees = rows(
          'commandWorktree',
          catalog.worktrees.filter((key) => treeIds.includes(key)),
        ).map(({ repositoryId: _scan, groupId: _group, order: _order, ...tree }) => tree)
        const originUrl = scans.map((scan) => normalizeOriginUrl(scan.originUrl)).find(Boolean)
        const repoId = scans.find((scan) => scan.repoId !== undefined)?.repoId
        repoViews.push({
          path: first.path,
          name: repoNameFromOrigin(originUrl) ?? (first.path.split('/').pop() || first.path),
          worktrees,
          machines: scans.flatMap((scan) =>
            scan.machineId ? [{ machineId: scan.machineId, path: scan.path }] : [],
          ),
          ...(originUrl !== undefined ? { originUrl } : {}),
          ...(repoId !== undefined ? { repoId } : {}),
        })
      }
      const usage: Record<string, number> = {}
      for (const repo of repos) {
        counts.usageQueries++
        usage[JSON.stringify([repo.machineId ?? '', repo.path])] = pool.queries.activity({
          kind: 'commandRootActivity',
          roots: [repo.path, ...repo.worktrees.map((tree) => tree.path)],
        })
      }
      const repoTime = (repo: Store['repos'][number]) =>
        usage[JSON.stringify([repo.machineId ?? '', repo.path])] ?? 0
      const choices = repos.filter((repo) => repo.kind !== 'worktree')
      const initialRepoPath =
        [...choices].sort((a, b) => repoTime(b) - repoTime(a))[0]?.path ?? repos[0]?.path ?? ''
      const repoChoices = [...choices].sort(
        (a, b) =>
          repoTime(b) - repoTime(a) ||
          (a.path.split('/').filter(Boolean).pop() ?? a.path).localeCompare(
            b.path.split('/').filter(Boolean).pop() ?? b.path,
            undefined,
            { sensitivity: 'base' },
          ),
      )
      return {
        repos,
        repoViews,
        machines,
        usage,
        repoChoices,
        initialRepoPath,
        pending,
        issueIds: catalog.issues,
      }
    },
    { equals: compareStructural },
  )
  // Supported launch option lists. Each displayed repository owns its group
  // payload and scalar usage, independently of machine and session catalogs.
  const optionRepository = keyedComputed('commands.optionRepository', (id: string) => {
    counts.repositoryBuilds++
    let pending = 0
    const members = pool.sources.related('commandRepo', id, 'repositories')
      .flatMap(key => {
        const row = read('commandRepository', key)
        if (row === LOADING) pending++
        return row && row !== LOADING && !row.linked ? [row] : []
      }).sort((a, b) => a.order - b.order)
    const first = members[0]
    if (!first) return { repo: undefined, pending }
    const worktrees = pool.sources.related('commandRepo', id, 'worktrees')
      .flatMap(key => {
        const row = read('commandWorktree', key)
        if (row === LOADING) pending++
        return row && row !== LOADING ? [row] : []
      }).sort((a, b) => a.order - b.order)
      .map(({ repositoryId: _scan, groupId: _group, order: _order, ...tree }) => tree)
    const originUrl = members.map(scan => normalizeOriginUrl(scan.originUrl)).find(Boolean)
    const repoId = members.find(scan => scan.repoId !== undefined)?.repoId
    const repo: RepoView = {
      path: first.path,
      name: repoNameFromOrigin(originUrl) ?? (first.path.split('/').pop() || first.path),
      worktrees,
      machines: members.flatMap(scan => scan.machineId
        ? [{ machineId: scan.machineId, path: scan.path }] : []),
      ...(originUrl !== undefined ? { originUrl } : {}),
      ...(repoId !== undefined ? { repoId } : {}),
    }
    return { repo, pending }
  })
  const optionScan = keyedComputed('commands.optionScan', (id: string) => read('commandRepository', id))
  const optionMachine = keyedComputed('commands.optionMachine', (id: string) => read('commandMachine', id))
  const optionRepos = computed(() => {
    const catalog = read('commandCatalog', 'catalog')
    if (!catalog || catalog === LOADING) return catalog
    let pending = 0
    const repos = catalog.repositories.flatMap(id => {
      const row = optionScan(id)
      if (row === LOADING) pending++
      return row && row !== LOADING ? [row] : []
    })
    const repoViews = catalog.repos.flatMap(id => {
      const value = optionRepository(id)
      pending += value.pending
      return value.repo ? [value.repo] : []
    })
    return { repos, repoViews, pending }
  })
  const optionMachines = computed(() => {
    const catalog = read('commandCatalog', 'catalog')
    if (!catalog || catalog === LOADING) return catalog
    let pending = 0
    const machines = catalog.machines.flatMap(id => {
      const row = optionMachine(id)
      if (row === LOADING) pending++
      return row && row !== LOADING ? [row] : []
    })
    return { machines, pending }
  })
  const optionRoots = keyedComputed('commands.optionRoots', (id: string) => {
    const row = optionScan(id)
    return JSON.stringify(row && row !== LOADING ? [row.path, ...row.worktrees.map(tree => tree.path)] : [])
  })
  const optionUsage = keyedComputed('commands.optionUsage', (id: string) => {
    counts.optionUsageQueries++
    return pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(optionRoots(id)) as string[] })
  })
  const launchCommon = computed((): Loaded<Common> => {
    const data = optionRepos.get(), hosts = optionMachines.get()
    if (data === LOADING || hosts === LOADING) return LOADING
    if (!data || !hosts) return undefined
    const usage: Record<string, number> = {}
    for (const repo of data.repos) {
      const id = JSON.stringify([repo.machineId ?? '', repo.path])
      usage[id] = optionUsage(id)
    }
    const time = (repo: Store['repos'][number]) => usage[JSON.stringify([repo.machineId ?? '', repo.path])] ?? 0
    const choices = data.repos.filter(repo => repo.kind !== 'worktree')
    // The initial choice retains discovery order for equal usage; the displayed
    // list additionally breaks ties by its existing path label.
    const initialRepoPath = [...choices].sort((a, b) => time(b) - time(a))[0]?.path ?? data.repos[0]?.path ?? ''
    const repoChoices = choices.sort((a, b) => time(b) - time(a) ||
      (a.path.split('/').filter(Boolean).pop() ?? a.path).localeCompare(
        b.path.split('/').filter(Boolean).pop() ?? b.path, undefined, { sensitivity: 'base' }))
    return { ...data, machines: hosts.machines, usage, repoChoices, initialRepoPath,
      pending: data.pending + hosts.pending, issueIds: [] }
  })
  // Addressed summary objects are fresh; compare their values explicitly.
  const issueSummary = keyedComputed(() => undefined, (id: string): Loaded<IssueViewModel> => {
          const value = pool.row('commandIssue', id)
          if (!value || value === LOADING) return value
          const row = Object.fromEntries(
            COMMAND_SUMMARIES.issue.map((field) => [
              field,
              (value as unknown as Record<string, unknown>)[field],
            ]),
          ) as unknown as IssueViewModel
          const repoId = pool.graph.one('issue', id, 'repo'),
            repo = repoId
              ? (pool.row('repo', repoId) as { prefix?: string } | undefined)
              : undefined
          return {
            ...row,
            displayRef:
              row.displayRef ?? (repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`),
          } as IssueViewModel
  }, { equals: compareStructural })
  const browsing = computed(
    (): Loaded<{ issues: IssueViewModel[]; pending: number }> => {
      const data = common.get()
      if (!data || data === LOADING) return data
      counts.issueBuilds++
      let pending = 0
      const issues: IssueViewModel[] = []
      for (const id of data.issueIds) {
        const value = issueSummary(id)
        if (value === LOADING) {
          pending++
          continue
        }
        if (!value) continue
        issues.push(value)
      }
      return { issues, pending }
    },
    { equals: compareStructural },
  )
  function placementFor(data: Loaded<Pick<Common, 'repoViews'>>): Loaded<SpawnTarget[]> {
      const pins = windowField('pins'),
        selectedWorktree = windowField('selectedWorktree')
      if (data === LOADING || pins === LOADING || selectedWorktree === LOADING) return LOADING
      if (!data || !pins) return undefined
      const { repoViews } = data
      const trees = repoViews.flatMap((repo) => repo.worktrees)
      const current = trees.find((tree) => tree.path === selectedWorktree)
      const pinPaths = pins.worktrees ?? [],
        pinnedRepos = pins.repos ?? []
      const navRepos = [
        ...pinnedRepos.flatMap((path) => repoViews.filter((repo) => repo.path === path)),
        ...repoViews.filter(
          (repo) =>
            !pinnedRepos.includes(repo.path) &&
            repo.worktrees.some((tree) => !pinPaths.includes(tree.path)),
        ),
      ]
      const byRepo = new Map<string, number>()
      const pathToRepo = new Map(trees.map((tree) => [tree.path, tree.repoPath]))
      for (const repo of repoViews)
        for (const tree of repo.worktrees)
          if (!pinPaths.includes(tree.path)) pathToRepo.set(tree.path, repo.path)
      for (const repo of navRepos) {
        const roots = [...pathToRepo].filter(([, path]) => path === repo.path).map(([path]) => path)
        if (!pathToRepo.has(repo.path)) roots.push(repo.path)
        byRepo.set(
          repo.path,
          pool.queries.activity({ kind: 'commandRootActivity', roots, match: 'exact' }),
        )
      }
      const defaultRepo = navRepos.reduce<RepoView | undefined>(
        (best, repo) =>
          !best || (byRepo.get(repo.path) ?? 0) > (byRepo.get(best.path) ?? 0) ? repo : best,
        undefined,
      )
      const primary = defaultRepo
        ? (defaultRepo.worktrees.find(
            (tree) =>
              !pinPaths.includes(tree.path) && tree.isMain && tree.path === defaultRepo.path,
          ) ??
          defaultRepo.worktrees.find(
            (tree) => !pinPaths.includes(tree.path) && tree.path === defaultRepo.path,
          ) ?? {
            path: defaultRepo.path,
            repoPath: defaultRepo.path,
            isMain: true,
            ...(defaultRepo.repoId ? { repoId: defaultRepo.repoId } : {}),
          })
        : undefined
      return [
        ...(current ? [current] : []),
        ...(primary && primary.path !== current?.path ? [primary] : []),
      ]
  }
  const placement = computed(() => placementFor(common.get()), { equals: compareStructural })
  const launchTopology = computed(() => {
    const data = optionRepos.get(), pins = windowField('pins')
    if (data === LOADING || pins === LOADING) return LOADING
    if (!data || !pins) return undefined
    const trees = data.repoViews.flatMap(repo => repo.worktrees)
    const pathToRepo = new Map(trees.map(tree => [tree.path, tree.repoPath]))
    for (const repo of data.repoViews) for (const tree of repo.worktrees)
      if (!pins.worktrees.includes(tree.path)) pathToRepo.set(tree.path, repo.path)
    const roots = new Map<string, string[]>()
    for (const [path, repo] of pathToRepo) {
      const members = roots.get(repo) ?? []
      members.push(path)
      roots.set(repo, members)
    }
    const navRepos = [
      ...pins.repos.flatMap(path => data.repoViews.filter(repo => repo.path === path)),
      ...data.repoViews.filter(repo => !pins.repos.includes(repo.path) &&
        repo.worktrees.some(tree => !pins.worktrees.includes(tree.path))),
    ]
    for (const repo of navRepos) if (!pathToRepo.has(repo.path)) {
      const members = roots.get(repo.path) ?? []
      members.push(repo.path)
      roots.set(repo.path, members)
    }
    const treesByPath = new Map<string, (typeof trees)[number]>()
    for (const tree of trees) if (!treesByPath.has(tree.path)) treesByPath.set(tree.path, tree)
    return { navRepos, roots, treesByPath, pins }
  })
  const placementRoots = keyedComputed('commands.placementRoots', (path: string) => {
    const topology = launchTopology.get()
    return JSON.stringify(topology && topology !== LOADING ? topology.roots.get(path) ?? [] : [])
  })
  const placementUsage = keyedComputed('commands.placementUsage', (path: string) =>
    pool.queries.activity({ kind: 'commandRootActivity', roots: JSON.parse(placementRoots(path)) as string[], match: 'exact' }))
  const launchPlacement = computed((): Loaded<SpawnTarget[]> => {
    const topology = launchTopology.get(), selected = windowField('selectedWorktree')
    if (topology === LOADING || selected === LOADING) return LOADING
    if (!topology) return undefined
    const current = selected ? topology.treesByPath.get(selected) : undefined
    let best: RepoView | undefined, bestTime = 0
    for (const repo of topology.navRepos) {
      const time = placementUsage(repo.path)
      if (!best || time > bestTime) { best = repo; bestTime = time }
    }
    const primary = best ? best.worktrees.find(tree =>
      !topology.pins.worktrees.includes(tree.path) && tree.isMain && tree.path === best.path) ??
      best.worktrees.find(tree => !topology.pins.worktrees.includes(tree.path) && tree.path === best.path) ??
      { path: best.path, repoPath: best.path, isMain: true, ...(best.repoId ? { repoId: best.repoId } : {}) }
      : undefined
    return [...(current ? [current] : []), ...(primary && primary.path !== current?.path ? [primary] : [])]
  })
  function projection(palette: boolean): Loaded<CommandLaunchData> {
    const data = palette ? common.get() : launchCommon.get(),
      ids = sessionIds.get(),
      window = read('commandWindow', 'window'),
      spawnTargets = palette ? placement.get() : launchPlacement.get()
    if (
      data === LOADING ||
      ids === LOADING ||
      window === LOADING ||
      spawnTargets === LOADING
    )
      return LOADING
    if (!data || !ids || !window || !spawnTargets) return undefined
    const { issueIds: _issueIds, ...values } = data
    let pending = data.pending,
      issues: IssueViewModel[] = []
    if (palette) {
      const list = browsing.get()
      if (list === LOADING || !list) return list
      issues = list.issues
      pending += list.pending
      const membership = sessionMembership.get()
      const id = window.openIssueId ?? window.selectedIssueId,
        position = issues.findIndex((issue) => issue.id === id)
      if (id && position >= 0) {
        const row = issues[position]!,
          full = pool.row('issue', id)
        issues = [...issues]
        if (full === LOADING) {
          pending++
          issues.splice(position, 1)
        } else if (!full) issues.splice(position, 1)
        else {
          const node = pool.issue(id),
            children = [...pool.graph.many('issue', id, 'treeChildren')]
          let childDoneCount = 0
          for (const child of children) {
            const detail = pool.row('issue', child, 'summary')
            if (detail === LOADING) pending++
            else if (detail && isFinished(detail)) childDoneCount++
          }
          const members = pool.queries
            .ids({ kind: 'commandIssueSessions', issueId: id })
            .filter((sid) => {
              if (pool.queries.collapsed(sid) || !membership || membership === LOADING || !membership.has(sid)) return false
              // untracked-read: launch-session-presence
              if (untracked(() => !pool.tables.session.has(sid))) return true
              const session = pool.row('session', sid, 'summary') as Loaded<SessionView>
              return (
                !!session &&
                session !== LOADING &&
                session.issueId === id &&
                session.agentKind !== 'shell'
              )
            })
            .sort((a, b) => {
              const left = pool.queries.orderKey(a),
                right = pool.queries.orderKey(b)
              return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0
            })
          issues[position] = {
            ...full,
            displayRef: node?.displayRef ?? row.displayRef ?? `#${row.seq}`,
            readAt: pool.readCursor(id) ?? null,
            unread: node?.unread ?? false,
            memberSessionIds: members,
            childCount: children.length,
            childDoneCount,
          } as unknown as IssueViewModel
        }
      }
    }
    return { ...window, ...values, sessionIds: ids, issues, spawnTargets, pending }
  }
  const launch = computed(() => projection(false)),
    palette = computed(() => projection(true), { equals: compareStructural })
  return {
    launch: () => launch.get(),
    palette: () => palette.get(),
    window: windowField,
    sessionIds: () => sessionIds.get(),
    session,
    sessions: () => sessions.get(),
    counts,
    dispose() { session.clear(); issueSummary.clear(); optionRepository.clear(); optionRoots.clear(); optionUsage.clear(); optionScan.clear(); optionMachine.clear(); placementRoots.clear(); placementUsage.clear() },
  }
}
export function commandLaunchViews(pool: MobxPool) {
  return pool.sources.view('commands', () => createCommandLaunchViews(pool))
}
