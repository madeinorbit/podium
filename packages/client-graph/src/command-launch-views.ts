import type { SpawnTarget } from '@podium/client-core'
import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/values'
import { normalizeOriginUrl, repoNameFromOrigin } from '@podium/model/browser'
import { compareStructural, computed, observable, runInAction, untracked } from 'mobx'
import { COMMAND_SUMMARIES, type CommandLaunchRows } from './command-launch-schema'
import type { MobxPool } from './pool'
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
    addressedIssueReads: 0,
  }
  type Window = CommandLaunchRows['commandWindow']
  function windowField<K extends keyof Window>(key: K): Loaded<Window[K]> {
    const window = read('commandWindow', 'window')
    return window && window !== LOADING ? window[key] : window
  }
  // Session metadata (notably mark-read) changes one value, not the global
  // catalog or repository activity. Keep the ordered projection current from
  // addressed publications, and still obtain every value through pool.row.
  type SessionRows = { sessions: SessionView[]; pending: number; sessionIds: ReadonlySet<string> }
  let sessionOrder: readonly string[] | undefined
  let sessionSlots: Loaded<SessionView>[] = []
  const sessionPositions = new Map<string, number>()
  const sessionValuePositions = new Map<string, number>()
  const sessionVersion = observable.box(0)
  let sessionSnapshot: SessionRows = { sessions: [], pending: 0, sessionIds: new Set() }
  const readSession = (id: string) =>
    pool.row('session', id, 'summary-fields') as Loaded<SessionView>
  function sessionSnapshotFromSlots(): SessionRows {
    const sessions: SessionView[] = []
    sessionValuePositions.clear()
    for (const value of sessionSlots) {
      if (!value || value === LOADING) continue
      sessionValuePositions.set(value.sessionId, sessions.length)
      sessions.push(value)
    }
    return {
      sessions,
      pending: sessionSlots.filter((value) => value === LOADING).length,
      sessionIds: new Set(sessions.map((value) => value.sessionId)),
    }
  }
  const sessionRows = computed(
    (): Loaded<SessionRows> => {
      sessionVersion.get()
      const catalog = read('commandCatalog', 'catalog')
      if (!catalog || catalog === LOADING) return catalog
      if (!sessionOrder || !compareStructural(sessionOrder, catalog.sessions)) {
        sessionOrder = catalog.sessions
        sessionPositions.clear()
        sessionSlots = untracked(() =>
          catalog.sessions.map((id, position) => {
            sessionPositions.set(id, position)
            if (!pool.tables.session.has(id)) counts.coldSessionVisits++
            return readSession(id)
          }),
        )
        sessionSnapshot = sessionSnapshotFromSlots()
      }
      return sessionSnapshot
    },
    { equals: compareStructural },
  )
  const stopSessions = pool.queries.onChange((event) => {
    if (!sessionOrder) return
    if (event.type === 'replace') {
      sessionOrder = undefined
      runInAction(() => sessionVersion.set(sessionVersion.get() + 1))
      return
    }
    let changed = false,
      membershipChanged = false
    let sessions: SessionView[] | undefined
    for (const row of event.rows) {
      if (row.kind !== 'session') continue
      const position = sessionPositions.get(row.id)
      if (position === undefined) continue
      counts.addressedSessionReads++
      const value = untracked(() => readSession(row.id))
      const previous = sessionSlots[position]
      if (compareStructural(previous, value)) continue
      sessionSlots[position] = value
      changed = true
      if (previous && previous !== LOADING && value && value !== LOADING) {
        sessions ??= sessionSnapshot.sessions.slice()
        sessions[sessionValuePositions.get(row.id)!] = value
      } else membershipChanged = true
    }
    if (changed) {
      sessionSnapshot = membershipChanged
        ? sessionSnapshotFromSlots()
        : { ...sessionSnapshot, sessions: sessions! }
      runInAction(() => sessionVersion.set(sessionVersion.get() + 1))
    }
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
  // The dialog releases its reactions when it closes. Retain only its small
  // browsing values, with addressed invalidation, so reopening does not rebuild
  // every cold summary or keep hidden issue derivations observed.
  type IssueRows = { issues: IssueViewModel[]; pending: number }
  let issueOrder: readonly string[] | undefined
  let issueSlots: Loaded<IssueViewModel>[] = []
  let issueSnapshot: IssueRows = { issues: [], pending: 0 }
  const issuePositions = new Map<string, number>()
  const dirtyIssues = new Set<string>()
  const issueVersion = observable.box(0)
  const issueRepos = new Map<string, string>()
  const repoIssues = new Map<string, Set<string>>()
  const repoPrefixes = new Map<string, string | undefined>()
  function issueSummary(id: string): Loaded<IssueViewModel> {
    const value = pool.row('commandIssue', id)
    const previousRepo = issueRepos.get(id)
    if (previousRepo) repoIssues.get(previousRepo)?.delete(id)
    issueRepos.delete(id)
    if (!value || value === LOADING) return value
    const row = Object.fromEntries(
      COMMAND_SUMMARIES.issue.map((field) => [
        field,
        (value as unknown as Record<string, unknown>)[field],
      ]),
    ) as unknown as IssueViewModel
    const repoId = pool.graph.one('issue', id, 'repo')
    const repo = repoId ? (pool.row('repo', repoId) as { prefix?: string } | undefined) : undefined
    if (repoId) {
      issueRepos.set(id, repoId)
      let members = repoIssues.get(repoId)
      if (!members) repoIssues.set(repoId, (members = new Set()))
      members.add(id)
      repoPrefixes.set(repoId, repo?.prefix)
    }
    return {
      ...row,
      displayRef: row.displayRef ?? (repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`),
    } as IssueViewModel
  }
  function issueSnapshotFromSlots(): IssueRows {
    const issues: IssueViewModel[] = []
    let pending = 0
    for (const value of issueSlots) {
      if (value === LOADING) pending++
      else if (value) issues.push(value)
    }
    return { issues, pending }
  }
  const stopIssues = pool.queries.onChange((event) => {
    if (!issueOrder) return
    if (event.type === 'replace') {
      issueOrder = undefined
      dirtyIssues.clear()
      runInAction(() => issueVersion.set(issueVersion.get() + 1))
      return
    }
    let changed = false
    for (const row of event.rows) {
      if (row.kind === 'issue' && issuePositions.has(row.id)) {
        dirtyIssues.add(row.id)
        changed = true
      } else if (row.kind === 'repo' && repoIssues.has(row.id)) {
        const prefix = untracked(
          () => (pool.row('repo', row.id) as { prefix?: string } | undefined)?.prefix,
        )
        if (prefix === repoPrefixes.get(row.id)) continue
        repoPrefixes.set(row.id, prefix)
        for (const id of repoIssues.get(row.id)!) dirtyIssues.add(id)
        changed = true
      }
    }
    if (changed) runInAction(() => issueVersion.set(issueVersion.get() + 1))
  })
  const browsing = computed(
    (): Loaded<IssueRows> => {
      issueVersion.get()
      const data = common.get()
      if (!data || data === LOADING) return data
      if (!issueOrder || !compareStructural(issueOrder, data.issueIds)) {
        counts.issueBuilds++
        issueOrder = data.issueIds
        issuePositions.clear()
        issueRepos.clear()
        repoIssues.clear()
        repoPrefixes.clear()
        issueSlots = untracked(() =>
          data.issueIds.map((id, position) => {
            issuePositions.set(id, position)
            return issueSummary(id)
          }),
        )
        issueSnapshot = issueSnapshotFromSlots()
      } else if (dirtyIssues.size) {
        let changed = false
        for (const id of dirtyIssues) {
          counts.addressedIssueReads++
          const position = issuePositions.get(id)!
          const value = untracked(() => issueSummary(id))
          if (compareStructural(issueSlots[position], value)) continue
          issueSlots[position] = value
          changed = true
        }
        if (changed) issueSnapshot = issueSnapshotFromSlots()
      }
      dirtyIssues.clear()
      return issueSnapshot
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
      sessionData = sessionRows.get(),
      window = read('commandWindow', 'window'),
      spawnTargets = placement.get()
    if (
      data === LOADING ||
      sessionData === LOADING ||
      window === LOADING ||
      spawnTargets === LOADING
    )
      return LOADING
    if (!data || !sessionData || !window || !spawnTargets) return undefined
    const { issueIds: _issueIds, ...values } = data
    const { sessionIds, sessions } = sessionData
    let pending = data.pending + sessionData.pending,
      issues: IssueViewModel[] = []
    if (palette) {
      const list = browsing.get()
      if (list === LOADING || !list) return list
      issues = list.issues
      pending += list.pending
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
            else if (detail && (detail as { stage: string }).stage === 'done') childDoneCount++
          }
          const members = pool.queries
            .ids({ kind: 'commandIssueSessions', issueId: id })
            .filter((sid) => {
              if (pool.queries.collapsed(sid) || !sessionIds.has(sid)) return false
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
    return { ...window, ...values, sessions, issues, spawnTargets, pending }
  }
  const launch = computed(() => projection(false), { equals: compareStructural }),
    palette = computed(() => projection(true), { equals: compareStructural })
  return {
    launch: () => launch.get(),
    palette: () => palette.get(),
    window: windowField,
    sessions: () => {
      const data = sessionRows.get()
      return data && data !== LOADING ? data.sessions : data
    },
    counts,
    dispose: () => {
      stopSessions()
      stopIssues()
    },
  }
}
export function commandLaunchViews(pool: MobxPool) {
  return pool.sources.view('commands', () => createCommandLaunchViews(pool))
}
