import { headerView } from './header-views'
import { keyedComputed } from '@podium/mobx-helpers'
import { isFinished } from './shared/predicates'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  confirmedWorkingAgentCount,
  filterBoardIssues,
  issueIsActionable,
  sessionNeedsHuman,
  sessionPresentOnTask,
} from '@podium/client-core/values'
import { asIssueId, asSessionId, CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, ISSUE_STAGES, issueStatusOf } from '@podium/model/browser'
import {
  compareStructural,
  observable,
  observe,
  runInAction,
} from 'mobx'
import { createIssueExplorer } from './issue-explorer'
import { createBoardLayout } from './issue-board-layout'
import {
  BOARD_EXPLORER_TABS,
  type BoardCardData,
  type BoardColumnOptions,
  type BoardCatalog,
  type BoardExplorerTab,
  type BoardOptions,
  type BoardQuery,
  ISSUE_BOARD_SUMMARIES,
  type IssueBoardSourceRows,
  type PoolExplorerData,
} from './issue-board-schema'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { defineSource, type PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const text = (value: unknown): string =>
  typeof value === 'string' ? value : ((value as { value?: string } | undefined)?.value ?? '')
const tabOf = (row: IssueViewModel): BoardExplorerTab | null => {
  const status = issueStatusOf(row)
  return status === 'shipping'
    ? null
    : status === 'cancelled' || status === 'duplicate' || status === 'superseded'
      ? 'cancelled'
      : status
}

/** Read-side service over declared pool questions and relations. Layouts
 * publish IDs; rich cards belong to mounted rows or explicit diagnostics.
 * Query demand and scalar computeds disappear on filter change/unmount. */
export function createIssueBoardSource(
  pool: MobxPool,
  owner?: {
    readLocal(key: 'openIssueId'): string | null
    onLocals(keys: readonly 'openIssueId'[], listener: () => void): () => void
  },
) {
  const layout = createBoardLayout(pool)
  const cache = keyedComputed((key: string) => `IssueBoard@${key}`, (_key: string, read: () => unknown) => read())
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  const countQuestion = { kind: 'boardCounts' } as const
  // Counts are maintained contributions. Opening an explorer attaches its
  // aggregate once; an addressed update changes only that issue's answer.
  // Closing the last count reader releases every contribution and roster.
  const tabCounts = createQueryResult<{ tab: BoardExplorerTab | null; needs: boolean }>({
    name: 'IssueBoard@tabCounts',
    ids: () => pool.queries.ids(countQuestion),
    has: id => pool.queries.has(countQuestion, id),
    read: id => {
      const row = facts(id)
      if (row === LOADING) return LOADING
      if (!row || row.archived || row.deletedAt || !scoped(row, false, false, id)) return undefined
      return { tab: tabOf(row), needs: !isFinished(row) && actionable(row) }
    },
    matches: BOARD_EXPLORER_TABS.map(tab => value => tab === 'needs' ? value.needs : value.tab === tab),
    subscribe: changed => {
      const stopTable = observe(pool.tables.issue, change => changed(change.name))
      const stopFeed = pool.queries.onChange(event => {
        if (event.type === 'replace') changed(undefined)
        else for (const row of event.rows) if (row.kind === 'issue') changed(row.id)
      })
      return () => { stopTable(); stopFeed() }
    },
  })
  const frame = defineSource({ readById, release })
  const explorerLayout = createIssueExplorer(pool, (id, query) => {
    const row = facts(id)
    return !row || row === LOADING ? row : matches(row, query, id)
  })
  const open = observable.box(owner?.readLocal('openIssueId') ?? null)
  // Keyed (POD-5433): only an open-issue change wakes the board.
  const stopOwner =
    owner?.onLocals(['openIssueId'], () =>
      runInAction(() => open.set(owner.readLocal('openIssueId'))),
    ) ?? (() => {})
  function memo<T>(key: string, read: () => T): T {
    if (frame.disposed) return LOADING as T
    return cache(key, read) as T
  }
  function facts(id: string): Loaded<IssueViewModel> {

    // Observed counts and eligibility share resident scalar facts. Cold
    // facts remain demand-owned by the query's addressed computations.
    return pool.tables.issue.has(id) ? memo(`facts:${id}`, () => readFacts(id)) : readFacts(id)
  }
  function readFacts(id: string): Loaded<IssueViewModel> {
    const row = pool.row('issue', id, 'summary-fields')
    if (!row || row === LOADING) return row
    const raw = row as Record<string, unknown>
    // Cold input already IS the declared summary. Picking every field again
    // allocates dozens of pairs per historical candidate. Resident facts keep
    // only the declared fields, so no document is retained by this index.
    const fields = pool.tables.issue.has(id)
      ? Object.fromEntries(ISSUE_BOARD_SUMMARIES.issue.map((key) => [key, raw[key]]))
      : raw
    const repoId = pool.graph.one('issue', id, 'repo')
    const repo = repoId ? (pool.row('repo', repoId) as Loaded<{ prefix?: string }>) : undefined
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
      displayRef: prefix ? `${prefix}-${raw.seq}` : `#${raw.seq}`,
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
    if (row.isDraftVessel && !row.deletedAt) return false
    if (agents || row.deletedAt || row.audience !== 'agent') return true
    const seen = new Set([id])
    let parent = pool.graph.one('issue', id, 'treeParent')
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const value = pool.queries.issueScope(parent)
      if (
        !value ||
        (value.draft && !value.deleted) ||
        (liveParents && (value.archived || value.deleted))
      )
        return false
      if (value.deleted || !value.agent) return true
      parent = pool.graph.one('issue', parent, 'treeParent')
    }
    return false
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
            : (pool.row('session', sid, 'summary') as Loaded<SessionView>),
        matches: [
          (seat) => !seat.archived && sessionNeedsHuman(seat),
          (seat) => !seat.archived && seat.issueId === id && sessionPresentOnTask(seat),
        ],
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
  function cardSessions(id: string): Loaded<SessionView[]> {
    return memo(`visibleSessions:${id}`, () => {
      const seats = pool.queries.project({ kind: 'commandIssueSessions', issueId: id,
        archived: false, includeShells: true }, `IssueBoard@sessions:${id}`, sid =>
        pool.graph.isCollapsed('session', sid) ? undefined
          : pool.row('session', sid, 'summary') as Loaded<SessionView>)
      if (!seats || seats === LOADING) return seats
      return seats.slice().sort((a, b) => pool.graph.orderKey('session', a.sessionId)
        .localeCompare(pool.graph.orderKey('session', b.sessionId)))
    })
  }
  function actionable(row: IssueViewModel): boolean {
    if (row.archived || row.deletedAt || isFinished(row)) return false
    const seats = roster(row.id)
    // The shared pure predicate needs only witnesses for these two
    // existential questions. Archived history never enters this read.
    const asking = seats.firstMatch(0),
      staffed = seats.firstMatch(1)
    const attention =
      row.stage === 'review'
        ? {
            ...row,
            dependents: [...pool.graph.many('issue', row.id, 'spinOffs')].map((id) => ({
              id: asIssueId(id),
              type: 'discovered-from',
            })),
          }
        : row
    return (
      asking !== LOADING &&
      staffed !== LOADING &&
      issueIsActionable(
        attention,
        [asking, staffed].filter((seat): seat is SessionView => seat !== undefined),
      )
    )
  }
  function matches(row: IssueViewModel, query: BoardQuery, id: string = row.id): boolean {
    if (query.kind === 'board')
      return (
        filterBoardIssues([row], query.filter ?? {}).length > 0 &&
        scoped(row, query.showAgentTasks ?? false, false, id)
      )
    const needle = query.query?.trim().toLowerCase()
    if (needle && !row.deletedAt && row.displayRef.toLowerCase() === needle) return true
    if (row.archived || row.deletedAt || !scoped(row, false, false, id)) return false
    if (needle) return `${row.displayRef} ${row.title}`.toLowerCase().includes(needle)
    return query.tab === 'needs' ? actionable(row) : tabOf(row) === query.tab
  }
  function queryIds(query: BoardQuery): Loaded<{ ids: string[] }> {
    if (query.kind === 'board') return layout.queryIds(query)
    return memo(`query:${JSON.stringify(query)}`, () => {
      const ids = explorerLayout.ids(query)
      return ids === LOADING ? LOADING : { ids: ids ?? [] }
    })
  }
  const catalogEntry = keyedComputed('IssueBoard.catalogEntry', (key: string) => {
    const [id, agents] = JSON.parse(key) as [string, boolean]
    const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
    if (!row || row === LOADING) return row
    const eligible = !row.archived && !row.deletedAt && scoped(row, agents, true, id)
    return { path: row.repoPath, eligible, assignee: eligible ? row.assignee : undefined,
      labels: eligible ? row.labels : [] }
  }, { equals: compareStructural })
  function catalog(agents: boolean): Loaded<BoardCatalog> {
    return memo(`catalog:${agents}`, () => {
      const scope: string[] = [],
        paths = new Set<string>(),
        assignees = new Set<string>(),
        labels = new Set<string>()
      const visit = (id: string) => {
        const row = catalogEntry(JSON.stringify([id, agents]))
        if (row === LOADING) return false
        if (!row) return true
        if (row.path) paths.add(row.path)
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
            projectPaths: [...paths].sort((a, b) =>
              (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b),
            ),
          }
    })
  }
  function issue(id: string, visible = false): Loaded<IssueViewModel> {
    return memo(`${visible ? 'visibleRow' : 'row'}:${id}`, () => {

      const value = facts(id)
      if (!value || value === LOADING) return value
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const row = pool.row('issue', childId, 'summary-fields') as Loaded<{ stage?: string; closedReason?: string | null }>
        if (row === LOADING) return LOADING
        if (row && isFinished(row)) childDoneCount++
      }
      const dependents: IssueViewModel['dependents'] = []
      for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
        const row = pool.row('issue', sourceId, 'summary-fields') as Loaded<{
          deps?: { id: string; type: string }[]
        }>
        if (row === LOADING) return LOADING
        for (const dep of row?.deps ?? [])
          if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
      }
      const visibleSeats = visible ? cardSessions(id) : undefined
      if (visibleSeats === LOADING) return LOADING
      const memberSessionIds = (visible
        ? (visibleSeats ?? []).filter(seat => seat.agentKind !== 'shell').map(seat => seat.sessionId)
        : [...pool.graph.many('issue', id, 'pageSessions')])
        .sort(byId)
        .map(asSessionId)
      const readAt = pool.readCursor(id) ?? null,
        readTime = Date.parse(readAt ?? '')
      let unread = !Number.isFinite(readTime) || Date.parse(value.updatedAt) > readTime
      if (visible && !pool.graph.many('issue', id, 'pageSessions')[Symbol.iterator]().next().done) {
        const activity = pool.visibleInputs.seatSummary?.(id).activity
        if (activity != null && activity > readTime) unread = true
      }
      const byPhase: Record<string, number> = {}
      let total = 0
      for (const sid of memberSessionIds) {
        const seat = pool.row('session', sid, 'summary') as Loaded<SessionView>
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
        pinned: value.pinned ?? false,
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
  function workingAgents(seats: readonly SessionView[]): number {
    for (const seat of seats) {
      if (seat.status !== 'live' || seat.archived || seat.agentKind === 'shell' ||
        !['working', 'compacting'].includes(seat.agentState?.phase ?? '')) continue
      const at = Math.max(...[seat.lastActiveAt, seat.agentState?.since, seat.agentState?.stateObservedAt]
        .map(stamp => Date.parse(stamp ?? '')).filter(Number.isFinite))
      if (Number.isFinite(at)) pool.clock.passed(at + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS)
    }
    // The count's time value pairs with the exact per-seat expiry deadlines
    // above, so read it untracked: a minute tick must not wake the card.
    return confirmedWorkingAgentCount(seats, pool.clock.peekNow())
  }
  function progress(id: string) {
    if (pool.graph.many('issue', id, 'treeChildren')[Symbol.iterator]().next().done) return null
    return memo(`progress:${id}`, () => {
      let total = 0,
        done = 0,
        liveAgents = 0
      const seen = new Set([id]),
        stack = [...pool.graph.many('issue', id, 'treeChildren')]
      while (stack.length) {
        const next = stack.pop()!
        if (seen.has(next)) continue
        seen.add(next)
        // Progress needs closure membership and terminal state, never a rich
        // card's document, labels, reference or presentation fields.
        const row = pool.row('issue', next, 'summary-fields') as Loaded<IssueViewModel>
        if (row === LOADING) return LOADING
        if (!row || row.archived || row.deletedAt || row.isDraftVessel) continue
        total++
        if (isFinished(row)) done++
        const seats = cardSessions(next)
        if (seats === LOADING) return LOADING
        liveAgents += workingAgents(seats ?? [])
        stack.push(...pool.graph.many('issue', next, 'treeChildren'))
      }
      return total ? { total, done, liveAgents } : null
    })
  }
  function card(options: { id: string; now?: number; agents?: boolean }): Loaded<BoardCardData> {
    return memo(`card:${JSON.stringify({ id: options.id, agents: options.agents ?? false })}`, () => {

      const row = issue(options.id, true),
        roster = cardSessions(options.id)
      if (!row || row === LOADING || roster === LOADING)
        return row === undefined ? undefined : LOADING
      const byId = new Map<string, IssueViewModel>([[row.id, row]])
      for (const other of pool.graph.many('issue', row.id, 'pageDependencies')) {
        const value = facts(other)
        if (value === LOADING) return LOADING
        if (value) byId.set(other, value)
      }
      const counts = new Map<IssueViewModel['stage'], number>()
      if (!row.archived && !row.deletedAt && scoped(row, options.agents ?? false, true)) {
        for (const childId of pool.graph.many('issue', row.id, 'treeChildren')) {
          const child = pool.row('issue', childId, 'summary-fields') as Loaded<IssueViewModel>
          if (child === LOADING) return LOADING
          if (
            child &&
            child.id !== row.id &&
            !child.archived &&
            !child.deletedAt &&
            scoped(child, options.agents ?? false, true, childId)
          )
            counts.set(child.stage, (counts.get(child.stage) ?? 0) + 1)
        }
      }
      const rollup = progress(row.id)
      if (rollup === LOADING) return LOADING
      const seatsById = new Map((roster ?? []).map((seat) => [seat.sessionId as string, seat]))
      return {
        issue: row,
        sessions: roster ?? [],
        fleet: row.memberSessionIds.flatMap((id) => {
          const seat = seatsById.get(id)
          return seat ? [seat] : []
        }),
        byId,
        stageCounts: ISSUE_STAGES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })).filter(
          (value) => value.count,
        ),
        progress: rollup,
      }
    })
  }
  const board = layout.board
  function menu(options: { ids: string[]; agents: boolean }) {
    return memo(`menu:${JSON.stringify(options)}`, () => {
      const issues: IssueViewModel[] = [], seats = new Map<string, SessionView>()
      // The menu reads addressed origins itself and opens choice catalogs
      // only for the relevant submenu. Its trigger needs selected rows only.
      for (const id of options.ids) {
        const row = issue(id), roster = sessions(id)
        if (row === LOADING || roster === LOADING) return LOADING
        if (row) issues.push(row)
        for (const seat of roster ?? []) seats.set(seat.sessionId, seat)
      }
      return {
        issues, allIssues: issues, sessions: [...seats.values()],
        repos: headerView(pool).ids('repository').flatMap(id => {
          const row = headerView(pool).row('repository', id)
          return row ? [row] : []
        }),
        machines: headerView(pool).machines(),
      }
    })
  }
  function explorerCounts(): Loaded<Record<BoardExplorerTab, number>> {
    return memo('explorerCounts', () => {
      const counts = Object.fromEntries(BOARD_EXPLORER_TABS.map((tab) => [tab, 0])) as Record<
        BoardExplorerTab,
        number
      >
      for (const [index, tab] of BOARD_EXPLORER_TABS.entries()) {
        const count = tabCounts.countMatch(index)
        if (count === LOADING) return LOADING
        counts[tab] = count ?? 0
      }
      return counts
    })
  }
  function explorer(options: {
    tab: BoardExplorerTab | null
    query: string
    windowed?: boolean
  }): Loaded<PoolExplorerData> {
    return memo(`explorer:${JSON.stringify(options)}`, () => {
      const counts = explorerCounts()
      if (!counts || counts === LOADING) return LOADING
      const tab = options.tab ?? BOARD_EXPLORER_TABS.find((key) => counts[key]) ?? 'in_progress'
      const found = explorerLayout.ids({ kind: 'explorer', tab, query: options.query }, true)
      if (!found || found === LOADING) return LOADING
      const total = BOARD_EXPLORER_TABS.reduce((n, key) => n + (key === 'needs' ? 0 : counts[key]), 0)
      // Production publishes only order and counts. Rich values are demanded
      // by mounted cards, or explicitly by the diagnostic snapshot below.
      if (options.windowed) return { counts, tab, total, ids: found, rows: [],
        byId: new Map(), rowSessions: new Map(), sessions: [] }
      const rows: IssueViewModel[] = [],
        byId = new Map<string, IssueViewModel>(),
        rowSessions = new Map<string, SessionView[]>(),
        allSeats = new Map<string, SessionView>()
      for (const id of found) {
        const row = issue(id)
        if (row === LOADING) return LOADING
        if (row) {
          rows.push(row)
          byId.set(id, row)
        }
      }
      const neighbours = new Set<string>(found)
      for (const id of found) {
        const parent = pool.graph.one('issue', id, 'treeParent')
        if (parent) neighbours.add(parent)
        for (const relation of ['pageDependencies', 'pageDependents', 'spinOffs'] as const)
          for (const other of pool.graph.many('issue', id, relation)) neighbours.add(other)
      }
      for (const id of neighbours) {
        if (!byId.has(id)) {
          const row = issue(id)
          if (row === LOADING) return LOADING
          if (row) byId.set(id, row)
        }
        const roster = sessions(id)
        if (roster === LOADING) return LOADING
        rowSessions.set(id, roster ?? [])
        for (const seat of roster ?? []) allSeats.set(seat.sessionId, seat)
      }
      return {
        counts,
        tab,
        total,
        ids: found,
        rows,
        byId,
        rowSessions,
        sessions: [...allSeats.values()],
      }
    })
  }
  function readById(entity: keyof IssueBoardSourceRows, id: string): ReturnType<PoolSource<keyof IssueBoardSourceRows>['read']> {
    switch (entity) {
      case 'issueBoardWindow':
        return { openIssueId: open.get() ? asIssueId(open.get()!) : null }
      case 'issueBoardQuery':
        return queryIds(JSON.parse(id))
      case 'issueBoardCatalog':
        return catalog(id === 'true')
      case 'issueBoardModel':
        return board(JSON.parse(id))
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
      case 'issueExplorerModel':
        return explorer(JSON.parse(id))
      case 'issueBoardRow':
        return issue(id)
      case 'issueBoardCard':
        return card(JSON.parse(id))
      case 'issueBoardSessions':
        return sessions(id)

    }
  }
  function release(): void {
    stopOwner()
    layout.dispose()
    explorerLayout.dispose()
    tabCounts.dispose()
    for (const result of [...rosters.values()]) result.dispose()
    rosters.clear()
    cache.clear()
    catalogEntry.clear()
  }
  return Object.assign(frame, {
    board,
    columnIds: layout.columnIds,
    openIds: layout.openIds,
    explorer,
    explorerCounts,
    issue,
    card,
    sessions,
    queryIds,
    catalog,
    stats: () => ({
      residentRows: 0,
      demandKeys: explorerLayout.stats().demandKeys + layout.stats().demandKeys,
      cached: cache.size + catalogEntry.size + explorerLayout.stats().cached + layout.stats().cached,
    }),
  })
}
