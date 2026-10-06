import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { keyedComputed } from '@podium/mobx-helpers'
import type { Store } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { ActiveWorktree, IssueNavigationModel } from '@podium/client-core/values'
import type { RepoId } from '@podium/model/browser'
import { compareStructural } from 'mobx'
import { headerIds } from './enumerate'
import type { HeaderRows } from './header-schema'
import { missionView } from './mission-view'
import { missions } from './mission'
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

/** Cached views over the pool's one reader. No replica, legacy array, peek or
 * cold-ID index lives here. A missing summary queues the existing batch. */
function createShellViews(pool: MobxPool) {
  // Summaries build fresh arrays/records; equal answers must not wake consumers.
  const cache = keyedComputed(
    () => undefined,
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
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
  function linkedIssue(identifier: string): Loaded<ShellIssue> {
    const id = pool.queries.linkedIssueId(identifier)
    return id === undefined ? undefined : issue(id)
  }
  function linkedSession(identifier: string): Loaded<SessionView> {
    const id = pool.queries.linkedSessionId(identifier)
    return id === undefined ? undefined : session(id)
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
  function orders(): HeaderRows['shipOrder'][] {
    return memo('orders', () =>
      headerIds(pool, 'shipOrder').flatMap((id) => {
        const row = pool.row('shipOrder', id) as HeaderRows['shipOrder'] | undefined
        return row ? [row] : []
      }),
    )
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
      const state = window()
      if (!state || state === LOADING) return LOADING
      // Chrome needs only the mission root's addressed identity (id/title/type
      // and child count) for its flight-deck key and complexity check. Reading
      // the full mission view here would observe archived history, so a late
      // history row at larger scales re-runs chrome on pane switch (POD-5690).
      // Resolve the root cheaply, read its own row, and (for draft vessels)
      // only its shown present sessions — never archived history.
      const rootId = missions(pool).rootFor(state.selectedIssueId)
      if (rootId === LOADING) return LOADING
      let missionRoot: Pick<IssueNavigationModel, 'id' | 'title' | 'type' | 'childCount'> | undefined = undefined
      if (rootId) {
        const full = pool.row('issue', rootId) as Loaded<
          Pick<IssueNavigationModel, 'id' | 'title' | 'type' | 'archived' | 'deletedAt' | 'isDraftVessel' | 'worktreePath'>
        >
        if (full === LOADING) return LOADING
        if (!full || full.archived || full.deletedAt) missionRoot = undefined
        else if (full.isDraftVessel && !full.worktreePath) {
          const present = missionView(pool).present(rootId)
          if (present === LOADING) return LOADING
          missionRoot = present.length
            ? { id: full.id, title: full.title, type: full.type,
                childCount: pool.queries.issueChildCounts(rootId).childCount }
            : undefined
        } else {
          missionRoot = { id: full.id, title: full.title, type: full.type,
            childCount: pool.queries.issueChildCounts(rootId).childCount }
        }
      }
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
        repoCount: headerView(pool).repositoryCount(),
        worktreeCount: headerView(pool).worktreeCount(),
        sessionCount: sessionCount(),
        colorIssue,
        colors,
        missionRoot,
      }
    })
  }
  function dock(includeCatalog = false): Loaded<ShellDockData> {
    return memo(includeCatalog ? 'dockCatalog' : 'dock', () => {
      // Only the queue/shipping panels display catalogues. Context and rail
      // badges must never acquire them while resolving the active pane.
      if (includeCatalog) {
        const context = dock(),
          tasks = issues(),
          shipOrders = orders(),
          shipLanes = lanes()
        return !context || context === LOADING || tasks === LOADING || shipLanes === LOADING
          ? LOADING
          : { ...context, issues: tasks ?? [], shipOrders, shipLanes: shipLanes ?? [] }
      }
      const state = window(),
        fileTabs = files()
      if (!state || state === LOADING || fileTabs === LOADING) return LOADING
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
      const containingId = active ? pool.queries.containingIssueId(active.cwd) : undefined
      const containing = containingId
        ? (issue(containingId) as Loaded<IssueViewModel>)
        : undefined
      if (containing === LOADING) return LOADING
      const attachedId = active?.issueId ?? activeSession?.issueId
      const attached = attachedId ? (issue(attachedId) as Loaded<IssueViewModel>) : containing
      if (attached === LOADING) return LOADING
      const discovered = active ? headerEntities(pool).shippingScope(active.cwd, active.machineId) : undefined
      let scope: ShellDockData['scope'] = discovered
        ? { repoId: discovered.repoId as RepoId | null, repoPath: discovered.repoPath }
        : null
      if (active && !scope && attached)
        scope = { repoId: attached.repoId ?? null, repoPath: attached.repoPath }
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
        shipOrders: [],
        shipLanes: [],
        coarseNow: state.coarseNow,
        shipping: headerEntities(pool).shippingCounts(scope?.repoId ?? null),
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
    linkedIssue,
    linkedSession,
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
