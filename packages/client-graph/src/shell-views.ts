import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { ActiveWorktree, WorktreeView } from '@podium/client-core/values'
import { normalizeOriginUrl, type RepoId } from '@podium/model/browser'
import { compareStructural, computed } from 'mobx'
import { headerIds } from './enumerate'
import type { HeaderRows } from './header-schema'
import { missionView } from './mission-view'
import type { MobxPool } from './pool'
import { SHELL_SUMMARIES, type ShellIssue, type ShellRows } from './shell-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export interface ShellDockData {
  active: ActiveWorktree | null
  scope: { repoId: RepoId | null; repoPath: string } | null
  gitIssue: IssueViewModel | undefined
  mailIssueId: SessionView['issueId']
  issues: IssueViewModel[]
  shipOrders: import('@podium/model').ShipOrderProjection[]
  shipLanes: import('@podium/model').ShipLaneProjection[]
  coarseNow: number
  shipping: { unfinishedCount: number; decisionCount: number }
}
const contains = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Cached views over the pool's one reader. No replica, legacy array, peek or
 * cold-ID index lives here. A missing summary queues the existing batch. */
export function createShellViews(pool: MobxPool) {
  const cache = new Map<string, { get(): unknown }>()
  function memo<T>(key: string, read: () => T): T {
    let value = cache.get(key)
    if (!value) {
      value = computed(read, { equals: compareStructural })
      cache.set(key, value)
    }
    return value.get() as T
  }
  const window = () => pool.row('shellWindow', 'window')
  const catalog = () => pool.row('shellCatalog', 'catalog')
  function records<E extends 'shellApproval' | 'shellFile' | 'shellShipLane'>(
    entity: E,
    ids: readonly string[],
  ): Loaded<ShellRows[E][]> {
    const values: ShellRows[E][] = []
    for (const id of ids) {
      const value = pool.row(entity, id)
      if (value === LOADING) return LOADING
      if (value) values.push(value)
    }
    return values
  }
  function issue(id: string, full = false): Loaded<ShellIssue> {
    const value = pool.row('issue', id, full ? 'load' : 'summary')
    if (value === LOADING) {
      void pool.row('issue', id)
      return LOADING
    }
    if (!value) return undefined
    const input = value as Record<string, unknown>,
      repoId = input.repoId as string | undefined
    const repo = repoId ? (pool.row('repo', repoId) as { prefix?: string } | undefined) : undefined
    const prefix = repo?.prefix
    return {
      ...(full ? input : Object.fromEntries(SHELL_SUMMARIES.issue.map((key) => [key, input[key]]))),
      id,
      prefix,
      displayRef: prefix ? `${prefix}-${input.seq}` : `#${input.seq}`,
    } as unknown as ShellIssue
  }
  function sessions(): Loaded<SessionView[]> {
    return memo('sessions', () => {
      const values: SessionView[] = []
      const ids = pool.queries
        .ids({ kind: 'shellSessions' })
        .filter((id) => !pool.queries.collapsed(id))
        .sort((a, b) => {
          const left = pool.queries.orderKey(a),
            right = pool.queries.orderKey(b)
          return left < right ? -1 : left > right ? 1 : a.localeCompare(b)
        })
      for (const id of ids) {
        const row = pool.row('session', id, 'summary')
        if (row === LOADING) {
          void pool.row('session', id)
          return LOADING
        }
        if (row)
          values.push(
            Object.fromEntries(
              SHELL_SUMMARIES.session.map((key) => [key, (row as Record<string, unknown>)[key]]),
            ) as unknown as SessionView,
          )
      }
      return values
    })
  }
  function session(id: string): Loaded<SessionView> {
    if (pool.queries.collapsed(id)) return undefined
    const row = pool.row('session', id, 'summary')
    if (row === LOADING) {
      void pool.row('session', id)
      return LOADING
    }
    return row
      ? (Object.fromEntries(
          SHELL_SUMMARIES.session.map((key) => [key, (row as Record<string, unknown>)[key]]),
        ) as unknown as SessionView)
      : undefined
  }
  function sessionCount(): number {
    return memo(
      'sessionCount',
      () =>
        pool.queries.ids({ kind: 'shellSessions' }).filter((id) => !pool.queries.collapsed(id))
          .length,
    )
  }
  function issues(): Loaded<IssueViewModel[]> {
    return memo('issues', () => {
      const values: IssueViewModel[] = []
      for (const id of pool.queries.ids({ kind: 'shellIssues' }).sort()) {
        const row = issue(id)
        if (row === LOADING) return LOADING
        if (row) values.push(row as IssueViewModel)
      }
      return values
    })
  }
  function repositories(): HeaderRows['repository'][] {
    return memo('repositories', () =>
      headerIds(pool, 'repository').flatMap((id) => {
        const value = pool.row('repository', id) as HeaderRows['repository'] | undefined
        return value ? [value] : []
      }),
    )
  }
  function machines(): Store['machines'] {
    return memo('machines', () =>
      headerIds(pool, 'machine').flatMap((id) => {
        const value = pool.row('machine', id) as HeaderRows['machine'] | undefined
        return value ? [value] : []
      }),
    )
  }
  function worktrees(): WorktreeView[][] {
    return memo('worktrees', () => {
      const scans = repositories(),
        linked = new Set(scans.flatMap((scan) => scan.worktrees.map((tree) => tree.path)))
      const groups = new Map<string, HeaderRows['repository'][]>()
      for (const scan of scans) {
        if (linked.has(scan.path)) continue
        const key =
          scan.repoId ??
          (normalizeOriginUrl(scan.originUrl) ||
            `__no_remote__:${scan.machineId ?? ''}:${scan.path}`)
        groups.set(key, [...(groups.get(key) ?? []), scan])
      }
      return [...groups.values()].map((group) => {
        const repoId = group.find((scan) => scan.repoId !== undefined)?.repoId
        return group.flatMap((scan) =>
          [
            { path: scan.path, branch: scan.branch, isMain: true },
            ...scan.worktrees.map((tree) => ({ ...tree, isMain: false })),
          ].map((tree) => ({
            ...tree,
            repoPath: scan.path,
            ...(scan.machineId ? { machineId: scan.machineId } : {}),
            ...(repoId !== undefined ? { repoId } : {}),
          })),
        )
      })
    })
  }
  function approvals() {
    const keys = catalog()
    return !keys || keys === LOADING ? LOADING : records('shellApproval', keys.approvals)
  }
  function files() {
    const keys = catalog()
    return !keys || keys === LOADING ? LOADING : records('shellFile', keys.files)
  }
  function lanes() {
    const keys = catalog()
    return !keys || keys === LOADING ? LOADING : records('shellShipLane', keys.lanes)
  }
  function workspaceKey(): Loaded<string> {
    const state = window()
    if (!state || state === LOADING) return LOADING
    let root = state.selectedIssueId ? issue(state.selectedIssueId) : undefined
    if (root === LOADING) return LOADING
    if (root?.archived || root?.deletedAt) root = undefined
    const seen = new Set<string>()
    while (root?.parentId && !seen.has(root.id)) {
      seen.add(root.id)
      const parent = issue(root.parentId)
      if (parent === LOADING) return LOADING
      if (!parent || parent.archived || parent.deletedAt) break
      root = parent
    }
    return root
      ? `mission:${root.id}`
      : state.selectedIssueId
        ? `issue:${state.selectedIssueId}`
        : state.selectedWorktree
          ? `wt:${state.selectedWorktree}`
          : 'none'
  }
  function close() {
    return memo('close', () => {
      const key = workspaceKey(),
        fileTabs = files()
      if (!key || key === LOADING || !fileTabs || fileTabs === LOADING) return LOADING
      const layout = pool.row('shellWorkspace', key)
      return layout === LOADING ? LOADING : { workspaceKey: key, layout, fileTabs }
    })
  }
  function chrome() {
    return memo('chrome', () => {
      const state = window(),
        repos = repositories()
      if (!state || state === LOADING) return LOADING
      const root = missionView(pool).selectedRoot(state.selectedIssueId)
      if (root === LOADING) return LOADING
      const missionRoot = root
        ? { id: root.id, title: root.title, type: root.type, childCount: root.childCount }
        : undefined
      const colors: ShellIssue[] = [],
        seen = new Set<string>()
      let target = state.selectedIssueId ? issue(state.selectedIssueId) : undefined
      if (target === LOADING) return LOADING
      if (target?.archived || target?.deletedAt) target = undefined
      const colorIssue = target
      while (target && !seen.has(target.id)) {
        colors.push(target)
        seen.add(target.id)
        target = target.parentId ? issue(target.parentId) : undefined
        if (target === LOADING) return LOADING
      }
      return {
        view: state.view,
        reposLoaded: state.reposLoaded,
        superOpen: state.superOpen,
        paletteOpen: state.paletteOpen,
        selectedIssueId: state.selectedIssueId,
        repoCount: repos.length,
        worktreeCount: repos.reduce((sum, repo) => sum + repo.worktrees.length, 0),
        sessionCount: sessionCount(),
        colorIssue,
        colors,
        missionRoot,
      }
    })
  }
  function dock(includeIssues = false): Loaded<ShellDockData> {
    return memo(includeIssues ? 'dockCatalog' : 'dock', () => {
      if (includeIssues) {
        const context = dock(),
          tasks = issues()
        return !context || context === LOADING || tasks === LOADING
          ? LOADING
          : { ...context, issues: tasks ?? [] }
      }
      const state = window(),
        fileTabs = files(),
        shipLanes = lanes()
      if (!state || state === LOADING || fileTabs === LOADING || shipLanes === LOADING)
        return LOADING
      let active: ActiveWorktree | null = null
      const selectedFile = fileTabs?.find((file) => file.id === state.paneA)
      let activeSession = state.paneA && !selectedFile ? session(state.paneA) : undefined
      if (activeSession === LOADING) return LOADING
      const selected = activeSession
      if (selected)
        active = { cwd: selected.cwd, machineId: selected.machineId, sessionId: selected.sessionId }
      else {
        const tab = selectedFile
        if (tab?.worktreePath)
          active = {
            cwd: tab.worktreePath,
            machineId: tab.scope.kind === 'worktree' ? tab.scope.machineId : undefined,
            ...(tab.issueId ? { issueId: tab.issueId } : {}),
          }
      }
      if (!active) {
        let latest: SessionView | undefined
        const excluded: string[] = []
        for (;;) {
          const id = pool.queries.indexed({ kind: 'headerRecentSession', excluded })[0]
          if (!id) break
          const candidate = session(id)
          if (candidate === LOADING) return LOADING
          if (candidate && !candidate.archived) {
            latest = candidate
            break
          }
          excluded.push(id)
        }
        if (latest)
          active = { cwd: latest.cwd, machineId: latest.machineId, sessionId: latest.sessionId }
        activeSession = latest
      }
      let containing: IssueViewModel | undefined
      if (active)
        for (const id of pool.queries.indexed({ kind: 'containingIssues', cwd: active.cwd })) {
          const candidate = issue(id) as Loaded<IssueViewModel>
          if (candidate === LOADING) return LOADING
          if (
            !candidate ||
            candidate.archived ||
            candidate.deletedAt ||
            !candidate.worktreePath ||
            !contains(active.cwd, candidate.worktreePath)
          )
            continue
          if (
            !containing ||
            candidate.worktreePath.length > containing.worktreePath!.length ||
            (candidate.worktreePath.length === containing.worktreePath!.length &&
              candidate.seq < containing.seq)
          )
            containing = candidate
        }
      const attachedId = active?.issueId ?? activeSession?.issueId
      const attached = attachedId ? (issue(attachedId) as Loaded<IssueViewModel>) : containing
      if (attached === LOADING) return LOADING
      let scope: ShellDockData['scope'] = null
      if (active)
        for (const group of worktrees()) {
          const tree = group
            .filter(
              (tree) =>
                (!active!.machineId || !tree.machineId || tree.machineId === active!.machineId) &&
                contains(active!.cwd, tree.path),
            )
            .sort((a, b) => b.path.length - a.path.length)[0]
          if (tree) {
            scope = { repoId: tree.repoId ?? null, repoPath: tree.repoPath }
            break
          }
        }
      if (active && !scope && attached)
        scope = { repoId: attached.repoId ?? null, repoPath: attached.repoPath }
      const shipOrders = headerIds(pool, 'shipOrder').flatMap((id) => {
        const row = pool.row('shipOrder', id) as HeaderRows['shipOrder'] | undefined
        return row ? [row] : []
      })
      const scoped = scope?.repoId
        ? shipOrders.filter((order) => order.repoId === scope!.repoId)
        : []
      const explicitGitIssue = active?.issueId
        ? (issue(active.issueId) as Loaded<IssueViewModel>)
        : undefined
      if (explicitGitIssue === LOADING) return LOADING
      return {
        active,
        scope,
        gitIssue: explicitGitIssue ?? containing,
        mailIssueId: activeSession?.issueId ?? containing?.id,
        issues: [],
        shipOrders,
        shipLanes: shipLanes ?? [],
        coarseNow: state.coarseNow,
        shipping: {
          unfinishedCount: scoped.filter((order) =>
            ['needs_you', 'in_progress', 'waiting'].includes(order.humanState),
          ).length,
          decisionCount: scoped.filter((order) => order.humanState === 'needs_you').length,
        },
      }
    })
  }
  function shipping() {
    return memo('shipping', () => {
      const value = dock()
      return value && value !== LOADING ? value.shipping : LOADING
    })
  }
  function windowSnapshot() {
    return memo('window', () => {
      const state = window()
      return state && state !== LOADING ? { ...state } : state
    })
  }
  return {
    window: windowSnapshot,
    approvals,
    files,
    lanes,
    sessions,
    session,
    issues,
    issue,
    machines,
    repositories,
    chrome,
    dock,
    shipping,
    close,
  }
}
export function shellViews(pool: MobxPool): ReturnType<typeof createShellViews> {
  return pool.sources.view('shell-views', () => createShellViews(pool))
}
