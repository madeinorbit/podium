import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { keyedComputed } from '@podium/mobx-helpers'
import { asIssueId, asSessionId, machinePathBasename, machinePathKey } from '@podium/model/browser'
import { issueRefText } from '@podium/protocol'
import { compareStructural } from 'mobx'
import { headerView } from './header-views'
import { inBoardScope } from './issue-board-cards'
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
const text = (value: unknown): string =>
  typeof value === 'string' ? value : ((value as { value?: string } | undefined)?.value ?? '')

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
    const row = omitGone(pool.row('issue', id, 'summary-fields'))
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
      description: text(raw.description),
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
  function scoped(
    row: IssueViewModel,
    agents: boolean,
    liveParents = false,
    id: string = row.id,
  ): boolean {
    return inBoardScope(pool, row, id, agents, liveParents)
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
            : (omitGone(pool.row('session', sid, 'summary')) as Loaded<SessionView>),
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
  const catalogEntry = keyedComputed(
    'IssueBoard.catalogEntry',
    (key: string) => {
      const [id, agents] = JSON.parse(key) as [string, boolean]
      const row = omitGone(pool.row('issue', id, 'summary-fields')) as Loaded<IssueViewModel>
      if (!row || row === LOADING) return row
      const eligible = !row.archived && !row.deletedAt && scoped(row, agents, true, id)
      return {
        path: row.repoPath,
        eligible,
        assignee: eligible ? row.assignee : undefined,
        labels: eligible ? row.labels : [],
      }
    },
    { equals: compareStructural },
  )
  function catalog(agents: boolean): Loaded<BoardCatalog> {
    return memo(`catalog:${agents}`, () => {
      const scope: string[] = [],
        paths = new Map<string, string>(),
        assignees = new Set<string>(),
        labels = new Set<string>()
      const visit = (id: string) => {
        const row = catalogEntry(JSON.stringify([id, agents]))
        if (row === LOADING) return false
        if (!row) return true
        if (row.path && !paths.has(machinePathKey(row.path)))
          paths.set(machinePathKey(row.path), row.path)
        if (row.eligible) {
          scope.push(id)
          if (row.assignee) assignees.add(row.assignee)
          for (const label of row.labels) labels.add(label)
        }
        return true
      }
      let pending = false
      for (const id of pool.queries.ids({ kind: 'boardCatalog' })) if (!visit(id)) pending = true
      return pending
        ? LOADING
        : {
            scope: scope.sort(byId),
            assignees: [...assignees].sort(),
            labels: [...labels].sort(),
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
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const row = omitGone(pool.row('issue', childId, 'summary-fields')) as Loaded<{
          stage?: string
          closedReason?: string | null
        }>
        if (row === LOADING) return LOADING
        if (row && isFinished(row)) childDoneCount++
      }
      const dependents: IssueViewModel['dependents'] = []
      for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
        const row = omitGone(pool.row('issue', sourceId, 'summary-fields')) as Loaded<{
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
        const seat = omitGone(pool.row('session', sid, 'summary')) as Loaded<SessionView>
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
        childCount: childIds.length,
        childDoneCount,
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
    catalogEntry.clear()
  }
  return Object.assign(frame, {
    board,
    columnIds: layout.columnIds,
    openIds: layout.openIds,
    issue,
    sessions,
    queryIds,
    catalog,
    stats: () => ({
      residentRows: 0,
      demandKeys: layout.stats().demandKeys,
      cached: cache.size + catalogEntry.size + layout.stats().cached,
    }),
  })
}
