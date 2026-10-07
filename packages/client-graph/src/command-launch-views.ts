import type { SpawnTarget } from '@podium/client-core'
import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/values'
import { lazy, keyedComputed } from '@podium/mobx-helpers'
import { machinePathBasename, machinePathKey, machinePathsEqual, normalizeOriginUrl, repoNameFromOrigin } from '@podium/model/browser'
import {
  action, observable, observableRef, when, runInAction,
  compareStructural,
  computed,
  untracked,
} from 'mobx'
import { COMMAND_SUMMARIES, type CommandLaunchRows } from './command-launch-schema'
import type { MobxPool } from './pool'
import { isFinished } from './shared/predicates'
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
  const machines = computed(() => {
    const catalog = read('commandCatalog', 'catalog')
    if (!catalog || catalog === LOADING) return []
    return catalog.machines.flatMap(id => {
      const row = read('commandMachine', id)
      return row && row !== LOADING ? [row] : []
    })
  })
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
          name: repoNameFromOrigin(originUrl) ?? (machinePathBasename(first.path) || first.path),
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
        usage[JSON.stringify([repo.machineId ?? '', machinePathKey(repo.path)])] = pool.queries.activity({
          kind: 'commandRootActivity',
          roots: [repo.path, ...repo.worktrees.map((tree) => tree.path)],
        })
      }
      const repoTime = (repo: Store['repos'][number]) =>
        usage[JSON.stringify([repo.machineId ?? '', machinePathKey(repo.path)])] ?? 0
      const choices = repos.filter((repo) => repo.kind !== 'worktree')
      const initialRepoPath =
        [...choices].sort((a, b) => repoTime(b) - repoTime(a))[0]?.path ?? repos[0]?.path ?? ''
      const repoChoices = [...choices].sort(
        (a, b) =>
          repoTime(b) - repoTime(a) ||
          (machinePathBasename(a.path) || a.path).localeCompare(
            machinePathBasename(b.path) || b.path,
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
      const current = selectedWorktree == null ? undefined : trees.find((tree) => machinePathsEqual(tree.path, selectedWorktree))
      const pinPaths = pins.worktrees ?? [],
        pinnedRepos = pins.repos ?? []
      const navRepos = [
        ...pinnedRepos.flatMap((path) => repoViews.filter((repo) => machinePathsEqual(repo.path, path))),
        ...repoViews.filter(
          (repo) =>
            !pinnedRepos.some(path => machinePathsEqual(path, repo.path)) &&
            repo.worktrees.some((tree) => !pinPaths.some(path => machinePathsEqual(path, tree.path))),
        ),
      ]
      const byRepo = new Map<string, number>()
      const pathToRepo = new Map(trees.map((tree) => [machinePathKey(tree.path), machinePathKey(tree.repoPath)]))
      for (const repo of repoViews)
        for (const tree of repo.worktrees)
          if (!pinPaths.some(path => machinePathsEqual(path, tree.path))) pathToRepo.set(machinePathKey(tree.path), machinePathKey(repo.path))
      for (const repo of navRepos) {
        const roots = [...pathToRepo].filter(([, path]) => path === machinePathKey(repo.path)).map(([path]) => path)
        if (!pathToRepo.has(machinePathKey(repo.path))) roots.push(repo.path)
        byRepo.set(
          machinePathKey(repo.path),
          pool.queries.activity({ kind: 'commandRootActivity', roots, match: 'exact' }),
        )
      }
      const defaultRepo = navRepos.reduce<RepoView | undefined>(
        (best, repo) =>
          !best || (byRepo.get(machinePathKey(repo.path)) ?? 0) > (byRepo.get(machinePathKey(best.path)) ?? 0) ? repo : best,
        undefined,
      )
      const primary = defaultRepo
        ? (defaultRepo.worktrees.find(
            (tree) =>
              !pinPaths.some(path => machinePathsEqual(path, tree.path)) && tree.isMain && machinePathsEqual(tree.path, defaultRepo.path),
          ) ??
          defaultRepo.worktrees.find(
            (tree) => !pinPaths.some(path => machinePathsEqual(path, tree.path)) && machinePathsEqual(tree.path, defaultRepo.path),
          ) ?? {
            path: defaultRepo.path,
            repoPath: defaultRepo.path,
            isMain: true,
            ...(defaultRepo.repoId ? { repoId: defaultRepo.repoId } : {}),
          })
        : undefined
      return [
        ...(current ? [current] : []),
        ...(primary && (!current || !machinePathsEqual(primary.path, current.path)) ? [primary] : []),
      ]
    },
    { equals: compareStructural },
  )
  function memberSessionIds(id: string) {
    const membership = sessionMembership.get()
    return pool.queries.ids({ kind: 'commandIssueSessions', issueId: id })
      .filter(sid => {
        if (pool.queries.collapsed(sid) || !membership || membership === LOADING || !membership.has(sid)) return false
        // untracked-read: launch-session-presence
        if (untracked(() => !pool.tables.session.has(sid))) return true
        return pool.queries.has({ kind: 'commandIssueSessions', issueId: id, includeShells: false }, sid)
      })
      .sort((a, b) => {
        const left = pool.queries.orderKey(a), right = pool.queries.orderKey(b)
        return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0
      })
  }
  function projection(snapshot?: CommandLaunchData, memberIds?: string[]): Loaded<CommandLaunchData> {
    const data = snapshot ?? common.get(),
      ids = snapshot?.sessionIds ?? sessionIds.get(),
      window = read('commandWindow', 'window'),
      spawnTargets = snapshot?.spawnTargets ?? placement.get()
    if (
      data === LOADING ||
      ids === LOADING ||
      window === LOADING ||
      spawnTargets === LOADING
    )
      return LOADING
    if (!data || !ids || !window || !spawnTargets) return undefined
    const { issueIds: _issueIds, ...values } = data as Common
    let pending = data.pending,
      issues: IssueViewModel[] = []
    {
      const list = snapshot ? { issues: snapshot.issues, pending: 0 } : browsing.get()
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
            else if (detail && isFinished(detail)) childDoneCount++
          }
          const members = memberIds ?? memberSessionIds(id)
          issues[position] = {
            ...full,
            // The addressed command summary already resolved the birth ref.
            // Reading the model again would demand its cold loaded group.
            displayRef: row.displayRef ?? `#${row.seq}`,
            readAt: pool.readCursor(id) ?? null,
            unread: node?.unread ?? false,
            memberSessionIds: members,
            childCount: children.length,
            childDoneCount,
          } as unknown as IssueViewModel
        }
      }
    }
    return { ...values, ...window, sessionIds: ids, issues, spawnTargets, pending }
  }
  const palette = computed(() => projection(), { equals: compareStructural })
  return {
    palette: () => palette.get(),
    selected: (snapshot: CommandLaunchData, memberIds: string[]) => projection(snapshot, memberIds),
    memberSessionIds,
    window: windowField,
    machines: () => machines.get(),
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

export type RecentCommand = { kind: 'session' | 'issue'; id: string }
export type CommandPaletteData = CommandLaunchData & { selectedIssue?: IssueViewModel }

/** A palette mount owns its ordering. Catalog demand lives only in open(). */
export class CommandPaletteView {
  @observableRef accessor snapshot: Loaded<CommandLaunchData> = LOADING
  @observableRef accessor sessions: SessionView[] = []
  @observableRef accessor recent: RecentCommand[] = []
  @observableRef accessor issueSummaries = new Map<string, IssueViewModel>()
  private stopLoading: (() => void) | undefined

  constructor(private readonly pool: MobxPool) {}

  @action open() {
    this.close()
    const views = commandLaunchViews(this.pool)
    const take = () => {
      this.snapshot = views.palette()
      this.issueSummaries = new Map(this.snapshot && this.snapshot !== LOADING
        ? this.snapshot.issues.map(issue => [issue.id, issue]) : [])
      const sessions = views.sessions()
      this.sessions = sessions && sessions !== LOADING ? sessions : []
      const stamp = (iso: string | undefined) => iso ? Date.parse(iso) || 0 : 0
      const recent: { at: number; command: RecentCommand }[] = []
      for (const s of this.sessions)
        if (!s.archived) recent.push({ at: stamp(s.lastActiveAt), command: { kind: 'session', id: s.sessionId } })
      if (this.snapshot && this.snapshot !== LOADING)
        for (const i of this.snapshot.issues)
          if (!i.archived && !i.deletedAt && !i.isDraftVessel)
            recent.push({ at: stamp(i.updatedAt), command: { kind: 'issue', id: i.id } })
      recent.sort((a, b) => b.at - a.at)
      this.recent = recent.slice(0, 6).map(value => value.command)
    }
    take()
    if (this.snapshot === LOADING || this.snapshot === undefined || this.snapshot.pending > 0)
      this.stopLoading = when(() => {
        const value = views.palette()
        return !!value && value !== LOADING && value.pending === 0
      }, take)
  }

  @lazy({ equals: compareStructural })
  get selection(): Loaded<CommandLaunchData> {
    if (!this.snapshot || this.snapshot === LOADING) return this.snapshot
    const views = commandLaunchViews(this.pool)
    const id = views.window('openIssueId') ?? views.window('selectedIssueId')
    const issue = id && id !== LOADING ? this.issueSummaries.get(id) : undefined
    return views.selected({ ...this.snapshot, issues: issue ? [issue] : [] }, this.memberIds)
  }
  @lazy get memberIds(): string[] {
    const views = commandLaunchViews(this.pool)
    const id = views.window('openIssueId') ?? views.window('selectedIssueId')
    return id && id !== LOADING ? views.memberSessionIds(id) : []
  }
  @lazy({ equals: compareStructural })
  get data(): Loaded<CommandPaletteData> {
    const selected = this.selection
    if (!selected || selected === LOADING) return selected
    const snapshot = this.snapshot
    const issue = selected.issues[0]
    // The menu consumes live eligibility, not the cursor stamp or embedded
    // session activity. Its session actions use their addressed row readers.
    const { readAt: _cursor, sessionFacts: _activity, ...issueFields } =
      (issue ?? {}) as Partial<IssueViewModel & { sessionFacts?: unknown }>
    return snapshot && snapshot !== LOADING ? {
      ...selected, issues: snapshot.issues,
      selectedIssue: issue ? issueFields as IssueViewModel : undefined,
      machines: commandLaunchViews(this.pool).machines(),
    } : snapshot
  }
  @lazy get selectedRows() {
    const views = commandLaunchViews(this.pool)
    const id = views.window('openIssueId') ?? views.window('selectedIssueId')
    if (!id || id === LOADING) return []
    return this.pool.queries.ids({ kind: 'commandIssueSessions', issueId: id })
      .map(id => new CommandSessionRow(this.pool, id))
  }
  @lazy({ equals: compareStructural }) get selectedSessions(): SessionView[] {
    return this.selectedRows.flatMap(row => {
      const session = row.presentation
      return session && session !== LOADING ? [session] : []
    })
  }
  palette(): Loaded<CommandPaletteData> { return this.data }
  session(id: string) { return commandLaunchViews(this.pool).session(id) }
  @action close() { this.stopLoading?.(); this.stopLoading = undefined }
}
export const createCommandPalette = (pool: MobxPool) => new CommandPaletteView(pool)

/** The palette row's small live answer. Recency belongs to the open order. */
export class CommandSessionRow {
  private readonly openedAt: string
  constructor(private readonly pool: MobxPool, readonly id: string) {
    this.openedAt = runInAction(() => {
      const session = commandLaunchViews(pool).session(id)
      return session && session !== LOADING ? session.lastActiveAt : ''
    })
  }
  @lazy({ equals: compareStructural }) get presentation(): Loaded<SessionView> {
    const row = commandLaunchViews(this.pool).session(this.id)
    if (!row || row === LOADING) return row
    return { ...row, lastActiveAt: this.openedAt }
  }
}
