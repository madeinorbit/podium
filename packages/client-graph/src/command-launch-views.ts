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
export function createCommandLaunchViews(pool: MobxPool) {
  const read = <E extends keyof CommandLaunchRows>(entity: E, id: string) =>
    pool.row(entity, id) as Loaded<CommandLaunchRows[E]>
  const counts = {
    catalogBuilds: 0,
    issueBuilds: 0,
    coldSessionVisits: 0,
    usageQueries: 0,
    addressedSessionReads: 0,
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
        ).map(({ repositoryId: _scan, groupId: _group, ...tree }) => tree)
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
  const placement = computed(
    (): Loaded<SpawnTarget[]> => {
      const data = common.get(),
        pins = windowField('pins'),
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
    },
    { equals: compareStructural },
  )
  function projection(palette: boolean): Loaded<CommandLaunchData> {
    const data = common.get(),
      ids = sessionIds.get(),
      window = read('commandWindow', 'window'),
      spawnTargets = placement.get()
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
  const launch = computed(() => projection(false), { equals: compareStructural }),
    palette = computed(() => projection(true), { equals: compareStructural })
  return {
    launch: () => launch.get(),
    palette: () => palette.get(),
    window: windowField,
    sessionIds: () => sessionIds.get(),
    session,
    sessions: () => sessions.get(),
    counts,
    dispose() { session.clear(); issueSummary.clear() },
  }
}
export function commandLaunchViews(pool: MobxPool) {
  return pool.sources.view('commands', () => createCommandLaunchViews(pool))
}
