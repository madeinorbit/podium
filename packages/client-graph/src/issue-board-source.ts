import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { keyedComputed } from '@podium/mobx-helpers'
import { asIssueId, asSessionId, machinePathBasename, machinePathKey } from '@podium/model/browser'
import { issueRefText } from '@podium/protocol'
import { headerView } from './header-views'
import { createBoardLayout } from './issue-board-layout'
import {
  type BoardCatalog,
  type BoardColumnOptions,
  type BoardQuery,
  ISSUE_BOARD_SUMMARIES,
  type IssueBoardSourceRows,
} from './issue-board-schema'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { isFinished } from './shared/predicates'
import { defineSource, type PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Read-side service over declared pool questions and relations. Layouts
 * publish IDs; rich cards belong to mounted rows or explicit diagnostics.
 * Query demand and scalar computeds disappear on filter change/unmount. */
export function createIssueBoardSource(
  pool: MobxPool,
  owner?: { readonly ui: Pick<import('@podium/client-core/ui').UiStore, 'openIssueId'> },
) {
  const layout = createBoardLayout(pool)
  const cache = keyedComputed(
    (key: string) => `IssueBoard@${key}`,
    (_key: string, read: () => unknown) => read(),
  )
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  const frame = defineSource({ readById, release })
  const stopOwner = () => {}
  function memo<T>(key: string, read: () => T): T {
    if (frame.disposed) return LOADING as T
    return cache(key, read) as T
  }
  function facts(id: string): Loaded<IssueViewModel> {
    // Resident rows share memoized scalar facts. Cold facts remain
    // demand-owned by the reader's addressed computations.
    return pool.tables.issue.has(id) ? memo(`facts:${id}`, () => readFacts(id)) : readFacts(id)
  }
  function readFacts(id: string): Loaded<IssueViewModel> {
    const row = omitGone(pool.row('issue', id))
    if (!row || row === LOADING) return row
    const raw = row as unknown as Record<string, unknown>
    // Cold input already IS the declared summary. Picking every field again
    // allocates dozens of pairs per historical candidate. Resident facts keep
    // only the declared fields, so no document is retained by this index.
    const fields = pool.tables.issue.has(id)
      ? Object.fromEntries(ISSUE_BOARD_SUMMARIES.issue.map((key) => [key, raw[key]]))
      : raw
    const repoId = pool.graph.one('issue', id, 'repo')
    const repo = repoId
      ? (omitGone(pool.row('repo', repoId)) as Loaded<{ prefix?: string }>)
      : undefined
    if (repo === LOADING) return LOADING
    const prefix = repo?.prefix
    const deadline = Date.parse((raw.deferUntil as string) ?? '')
    const deferred = Number.isFinite(deadline) && !pool.clock.reached(deadline)
    return {
      ...fields,
      id: asIssueId(id),
      // The declared relation owns resolved parentage. Preserve its opaque
      // projection FK too when the parent is outside this principal's scope.
      parentId: pool.graph.one('issue', id, 'treeParent') ?? raw.parentId,
      labels: raw.labels ?? [],
      deps: raw.deps ?? [],
      prefix,
      displayRef: issueRefText(raw.seq as number, prefix),
      blocked: raw.blocked ?? false,
      deferred,
      ready: !raw.blocked && !deferred && !isFinished(raw),
      branch: raw.branch ?? null,
      worktreePath: raw.worktreePath ?? null,
    } as IssueViewModel
  }
  function roster(id: string) {
    let result = rosters.get(id)
    if (!result) {
      result = createQueryResult<SessionView>({
        name: `IssueBoard@sessions:${id}`,
        ids: () => pool.graph.many('issue', id, 'missionSessions'),
        has: (sid) => pool.queries.hasMember('issue', id, 'missionSessions', sid),
        order: (sid) => pool.graph.orderKey('session', sid),
        read: (sid) =>
          pool.graph.isCollapsed('session', sid)
            ? undefined
            : (omitGone(pool.row('session', sid)) as Loaded<SessionView>),
        subscribe: (changed) => pool.queries.onMembers('issue', id, 'missionSessions', changed),
        released: () => rosters.delete(id),
      })
      rosters.set(id, result)
    }
    return result
  }
  function sessions(id: string): Loaded<SessionView[]> {
    return frame.disposed ? LOADING : roster(id).get()
  }
  function queryIds(query: BoardQuery): Loaded<{ ids: string[] }> {
    return layout.queryIds(query)
  }
  /**
   * The filter menu's projects, from the repository records (an "always"
   * collection), never from a walk over every issue (POD-7088). Labels are
   * the server's label list, asked for when the menu opens.
   */
  function catalog(_agents: boolean): Loaded<BoardCatalog> {
    return memo('catalog', () => {
      const paths = new Map<string, string>()
      for (const row of pool.tables.repo.values()) {
        const path = (row as { repoPath?: unknown }).repoPath
        if (typeof path === 'string' && path && !paths.has(machinePathKey(path)))
          paths.set(machinePathKey(path), path)
      }
      return {
        projectPaths: [...paths.values()].sort((a, b) =>
          (machinePathBasename(a) || a).localeCompare(machinePathBasename(b) || b),
        ),
      }
    })
  }
  function issue(id: string): Loaded<IssueViewModel> {
    return memo(`row:${id}`, () => {
      const value = facts(id)
      if (!value || value === LOADING) return value
      // The children the device holds; their counts over all history come
      // from the stubs, LOADING until those answer (POD-7088).
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      const children = pool.queries.issueChildCounts(id)
      if (children === LOADING) return LOADING
      const dependents: IssueViewModel['dependents'] = []
      for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
        const row = omitGone(pool.row('issue', sourceId)) as Loaded<{
          deps?: { id: string; type: string }[]
        }>
        if (row === LOADING) return LOADING
        for (const dep of row?.deps ?? [])
          if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
      }
      const memberSessionIds = [...pool.graph.many('issue', id, 'pageSessions')]
        .sort(byId)
        .map(asSessionId)
      const readAt = pool.readCursor(id) ?? null,
        readTime = Date.parse(readAt ?? '')
      let unread = !Number.isFinite(readTime) || Date.parse(value.updatedAt) > readTime
      const byPhase: Record<string, number> = {}
      let total = 0
      for (const sid of memberSessionIds) {
        const seat = omitGone(pool.row('session', sid)) as Loaded<SessionView>
        if (seat === LOADING) return LOADING
        if (!seat) continue
        total++
        const phase = seat.agentState?.phase ?? 'unknown'
        byPhase[phase] = (byPhase[phase] ?? 0) + 1
        if (Date.parse(seat.lastActiveAt) > readTime) unread = true
      }
      return {
        ...value,
        readAt,
        tuckedAt: value.tuckedAt ?? null,
        // My pin record (POD-6692), never a field of the row.
        pinned: pool.isPinned('issue', id),
        childIds: childIds.map(asIssueId),
        childCount: children.childCount,
        childDoneCount: children.childDoneCount,
        dependents,
        memberSessionIds,
        unread: !value.deletedAt && unread,
        sessionSummary: { total, byPhase },
      }
    })
  }
  const board = layout.board
  function menu(options: { ids: string[]; agents: boolean }) {
    return memo(`menu:${JSON.stringify(options)}`, () => {
      const issues: IssueViewModel[] = [],
        seats = new Map<string, SessionView>()
      // The menu reads addressed origins itself and opens choice catalogs
      // only for the relevant submenu. Its trigger needs selected rows only.
      for (const id of options.ids) {
        const row = issue(id),
          roster = sessions(id)
        if (row === LOADING || roster === LOADING) return LOADING
        if (row) issues.push(row)
        for (const seat of roster ?? []) seats.set(seat.sessionId, seat)
      }
      return {
        issues,
        allIssues: issues,
        sessions: [...seats.values()],
        repos: headerView(pool)
          .ids('repository')
          .flatMap((id) => {
            const row = headerView(pool).row('repository', id)
            return row ? [row] : []
          }),
        machines: headerView(pool).machines(),
      }
    })
  }
  function readById(
    entity: keyof IssueBoardSourceRows,
    id: string,
  ): ReturnType<PoolSource<keyof IssueBoardSourceRows>['read']> {
    switch (entity) {
      case 'issueBoardWindow':
        return { openIssueId: owner?.ui.openIssueId ?? null }
      case 'issueBoardQuery':
        return queryIds(JSON.parse(id))
      case 'issueBoardCatalog':
        return catalog(id === 'true')
      case 'issueBoardModel':
        return board(JSON.parse(id))
      case 'issueBoardPosition': {
        const [issueId, ordering] = JSON.parse(id)
        return layout.position(issueId, ordering)
      }
      case 'issueBoardColumn':
        return layout.columnIds(JSON.parse(id) as BoardColumnOptions)
      case 'issueBoardColumnCount': {
        const count = layout.columnCount(JSON.parse(id) as BoardColumnOptions)
        return count === LOADING ? LOADING : { count: count ?? 0 }
      }
      case 'issueBoardOpenIds': {
        const options = JSON.parse(id)
        return layout.openIds(options, options.id)
      }
      case 'issueBoardMenu':
        return menu(JSON.parse(id))
      case 'issueBoardDropIndex': {
        const index = layout.dropIndex(JSON.parse(id))
        return index === LOADING ? LOADING : { index }
      }
      case 'issueBoardRow':
        return issue(id)
      case 'issueBoardSessions':
        return sessions(id)
    }
  }
  function release(): void {
    stopOwner()
    layout.dispose()
    for (const result of [...rosters.values()]) result.dispose()
    rosters.clear()
    cache.clear()
  }
  return Object.assign(frame, {
    board,
    columnIds: layout.columnIds,
    columnCount: layout.columnCount,
    columnHeld: layout.columnHeld,
    openIds: layout.openIds,
    issue,
    sessions,
    queryIds,
    catalog,
    stats: () => ({
      residentRows: 0,
      demandKeys: layout.stats().demandKeys,
      cached: cache.size + layout.stats().cached,
    }),
  })
}
