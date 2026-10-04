import { countIssueBoard } from '@podium/client-core/perf'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  confirmedWorkingAgentCount,
  filterBoardIssues,
  filterChips,
  flattenRowGroups,
  groupIssuesByStage,
  issueIsActionable,
  issueRowsByStage,
  partitionIssueTree,
  sessionNeedsHuman,
  sessionPresentOnTask,
} from '@podium/client-core/values'
import { asIssueId, asSessionId, ISSUE_STAGES, issueStatusOf } from '@podium/model/browser'
import {
  _isComputingDerivation,
  compareStructural,
  computed,
  createAtom,
  type IComputedValue,
  observable,
  observe,
  onBecomeUnobserved,
  reaction,
  runInAction,
} from 'mobx'
import { seedIssueReferences } from './enumerate'
import { type BoardProjection, createBoardProjection } from './issue-board-projection'
import {
  BOARD_EXPLORER_TABS,
  type BoardCardData,
  type BoardCatalog,
  type BoardExplorerTab,
  type BoardOptions,
  type BoardQuery,
  ISSUE_BOARD_SUMMARIES,
  type IssueBoardSourceRows,
  type PoolBoardData,
  type PoolExplorerData,
} from './issue-board-schema'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import type { PoolSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const text = (value: unknown): string =>
  typeof value === 'string' ? value : ((value as { value?: string } | undefined)?.value ?? '')
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
function grams(value: string): string[] {
  const n = Math.min(3, value.length)
  return n
    ? [...new Set(Array.from({ length: value.length - n + 1 }, (_, i) => value.slice(i, i + n)))]
    : []
}
function indexedGrams(value: string): string[] {
  const out = new Set<string>()
  for (let n = 1; n <= 3; n++)
    for (let i = 0; i <= value.length - n; i++) out.add(value.slice(i, i + n))
  return [...out]
}
const tabOf = (row: IssueViewModel): BoardExplorerTab | null => {
  const status = issueStatusOf(row)
  return status === 'shipping'
    ? null
    : status === 'cancelled' || status === 'duplicate' || status === 'superseded'
      ? 'cancelled'
      : status
}

/** Read-side service over the existing pool, with no row feed or write owner.
 * The standing index contains RESIDENT IDs only. Cold demand results contain
 * IDs only and disappear on filter change/unmount. Cold candidates come from
 * the feed's declared question; only matching scalar candidates are visited. */
export function createIssueBoardSource(
  pool: MobxPool,
  owner?: {
    readLocal(key: 'openIssueId'): string | null
    onLocals(keys: readonly 'openIssueId'[], listener: () => void): () => void
  },
) {
  const cache = new Map<string, IComputedValue<unknown>>()
  const buckets = observable.map<string, ReturnType<typeof observable.set<string>>>(undefined, {
    deep: false,
  })
  const stops = new Map<string, () => void>()
  const projections = new Map<string, BoardProjection>()
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  let disposed = false
  const open = observable.box(owner?.readLocal('openIssueId') ?? null)
  // Keyed (POD-5433): only an open-issue change wakes the board.
  const stopOwner =
    owner?.onLocals(['openIssueId'], () =>
      runInAction(() => open.set(owner.readLocal('openIssueId'))),
    ) ?? (() => {})
  function memo<T>(key: string, read: () => T): T {
    if (disposed) return LOADING as T
    const existing = cache.get(key)
    if (existing) return existing.get() as T
    if (!_isComputingDerivation()) return read()
    let value = cache.get(key)
    if (!value) {
      value = computed(read, {
        name: `IssueBoard@${key}`,
        ...(key.startsWith('placement:') ? { equals: compareStructural } : {}),
      })
      cache.set(key, value)
      onBecomeUnobserved(value, () => cache.delete(key))
    }
    return value.get() as T
  }
  function facts(id: string): Loaded<IssueViewModel> {
    // Existing resident index observations own these small facts. Reuse them
    // during React's pre-subscription read; cold facts are never cached here.
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
      ready: !raw.blocked && !deferred && raw.stage !== 'done',
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
      const value = facts(parent)
      if (
        !value ||
        value === LOADING ||
        (value.isDraftVessel && !value.deletedAt) ||
        (liveParents && (value.archived || value.deletedAt))
      )
        return false
      if (value.deletedAt || value.audience !== 'agent') return true
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
    return disposed ? LOADING : roster(id).get()
  }
  function actionable(row: IssueViewModel): boolean {
    if (row.archived || row.deletedAt || row.stage === 'done' || row.closedReason) return false
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
  function indexKeys(row: IssueViewModel): Set<string> {
    const keys = new Set([
      'all',
      `priority:${row.priority}`,
      `repo:${row.repoPath}`,
      `stage:${issueStatusOf(row)}`,
    ])
    if (scoped(row, false)) keys.add('scope')
    if (scoped(row, true)) keys.add('agents')
    if (!row.archived && !row.deletedAt) {
      keys.add('live')
      if (scoped(row, false, true)) keys.add('liveScope')
      if (scoped(row, true, true)) keys.add('liveAgents')
    }
    keys.add(row.stage === 'done' || row.closedReason != null ? 'status:closed' : 'status:open')
    for (const flag of ['ready', 'blocked', 'deferred'] as const)
      if (row[flag]) keys.add(`status:${flag}`)
    const tab = tabOf(row)
    if (tab) keys.add(`tab:${tab}`)
    if (actionable(row)) keys.add('tab:needs')
    const explorerText = `${row.displayRef} ${row.title}`.toLowerCase()
    for (const gram of indexedGrams(explorerText)) keys.add(`explorer:${gram}`)
    for (const gram of indexedGrams(`${row.title} ${row.description}`.toLowerCase()))
      keys.add(`text:${gram}`)
    for (const gram of indexedGrams(normalized(row.displayRef))) keys.add(`ref:${gram}`)
    if (!row.deletedAt) keys.add(`exact:${row.displayRef.toLowerCase()}`)
    return keys
  }
  function track(id: string) {
    if (stops.has(id)) return
    let previous = new Set<string>()
    const stop = reaction(
      () => {
        const row = facts(id)
        return row && row !== LOADING ? indexKeys(row) : new Set<string>()
      },
      (next) =>
        runInAction(() => {
          for (const key of previous) if (!next.has(key)) remove(key, id)
          for (const key of next)
            if (!previous.has(key)) {
              let bucket = buckets.get(key)
              if (!bucket) {
                bucket = observable.set<string>(undefined, { deep: false })
                buckets.set(key, bucket)
              }
              bucket.add(id)
            }
          previous = next
        }),
      { fireImmediately: true, name: `IssueBoard@index:${id}` },
    )
    stops.set(id, () => {
      stop()
      runInAction(() => {
        for (const key of previous) remove(key, id)
      })
    })
  }
  function remove(key: string, id: string) {
    const set = buckets.get(key)
    set?.delete(id)
    if (set?.size === 0) buckets.delete(key)
  }
  let stopTable: (() => void) | undefined
  const indexDemand = createAtom('IssueBoard@residentIndex', undefined, releaseIndex)
  function ensureIndex() {
    if (stopTable || disposed) return
    stopTable = observe(pool.tables.issue, (change) => {
      if (change.type === 'add') track(change.name)
      if (change.type === 'delete') {
        stops.get(change.name)?.()
        stops.delete(change.name)
      }
    })
    const bootstrap = performance.now()
    seedIssueReferences(pool.tables, track)
    countIssueBoard('residentIndexRows', stops.size)
    countIssueBoard('residentIndexBootstrapMs', performance.now() - bootstrap)
  }
  function releaseIndex() {
    stopTable?.()
    stopTable = undefined
    for (const stop of stops.values()) stop()
    stops.clear()
    runInAction(() => buckets.clear())
  }
  function indexed<T>(read: () => T): T {
    const retained = Boolean(stopTable)
    const observed = indexDemand.reportObserved()
    ensureIndex()
    try {
      return read()
    } finally {
      // Imperative snapshots borrow the index for this read only. Observed
      // board/explorer queries share it until their last reader closes.
      if (!observed && !retained) releaseIndex()
    }
  }
  const bucket = (key: string): ReadonlySet<string> => buckets.get(key) ?? new Set<string>()
  function union(sets: readonly ReadonlySet<string>[]): Set<string> {
    return new Set(sets.flatMap((set) => [...set]))
  }
  function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
    const sorted = [...sets].sort((a, b) => a.size - b.size)
    const result = new Set<string>()
    for (const id of sorted[0] ?? []) if (sorted.every((set) => set.has(id))) result.add(id)
    return result
  }
  function candidates(query: BoardQuery): ReadonlySet<string> {
    const filters: ReadonlySet<string>[] = [bucket(query.showAgentTasks ? 'agents' : 'scope')]
    if (query.kind === 'board') {
      const f = query.filter ?? {}
      if (f.priority != null) filters.push(bucket(`priority:${f.priority}`))
      if (f.stage) filters.push(bucket(`stage:${f.stage}`))
      if (f.status) filters.push(bucket(`status:${f.status}`))
      if (f.projectPaths?.length)
        filters.push(union(f.projectPaths.map((path) => bucket(`repo:${path}`))))
      const needle = f.text?.trim().toLowerCase()
      if (needle) {
        const matching = [intersection(grams(needle).map((gram) => bucket(`text:${gram}`)))]
        const ref = normalized(needle)
        if (/\d/.test(ref))
          matching.push(intersection(grams(ref).map((gram) => bucket(`ref:${gram}`))))
        filters.push(union(matching))
      }
    } else {
      filters.push(bucket('live'))
      const needle = query.query?.trim().toLowerCase()
      if (needle)
        filters.push(intersection(grams(needle).map((gram) => bucket(`explorer:${gram}`))))
      else filters.push(bucket(`tab:${query.tab}`))
    }
    const smallest = [...filters].sort((a, b) => a.size - b.size)[0]
    countIssueBoard('residentCandidates', smallest?.size ?? 0)
    const result = intersection(filters)
    if (query.kind === 'explorer' && query.query?.trim()) {
      for (const id of bucket(`exact:${query.query.trim().toLowerCase()}`)) result.add(id)
    }
    return result
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
    return memo(`query:${JSON.stringify(query)}`, () =>
      indexed(() => {
        countIssueBoard('queries')
        const ids: string[] = []
        let pending = false
        for (const id of candidates(query)) {
          const row = facts(id)
          if (row === LOADING) pending = true
          else if (row && matches(row, query)) ids.push(id)
        }
        const start = performance.now()
        const cold = pool.queries
          .ids({
            kind: 'boardIssues',
            ...query.filter,
            ...(query.kind === 'explorer'
              ? { explorerTab: query.tab ?? '', searching: !!query.query?.trim() }
              : {}),
          })
          .filter((id) => !pool.tables.issue.has(id))
        for (const id of cold) {
          // Stage, priority, path and ordinary status filters read only their
          // declared scalar inputs. Build text/ready/deferred values on demand.
          const f = query.filter
          const scalarBoard =
            query.kind === 'board' &&
            !f?.text?.trim() &&
            f?.status !== 'ready' &&
            f?.status !== 'deferred'
          const scalarExplorer =
            query.kind === 'explorer' && !query.query?.trim() && query.tab !== 'needs'
          const row =
            scalarBoard || scalarExplorer
              ? (pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>)
              : facts(id)
          if (row === LOADING) pending = true
          else if (row && matches(row, query, id)) ids.push(id)
        }
        countIssueBoard('coldSummaryVisits', cold.length)
        countIssueBoard('coldSummaryMs', performance.now() - start)
        countIssueBoard('matchedIds', ids.length)
        return pending ? LOADING : { ids: [...new Set(ids)].sort(byId) }
      }),
    )
  }
  function catalog(agents: boolean): Loaded<BoardCatalog> {
    return memo(`catalog:${agents}`, () =>
      indexed(() => {
        const scope: string[] = [],
          paths = new Set<string>(),
          assignees = new Set<string>(),
          labels = new Set<string>()
        const visit = (id: string) => {
          const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
          if (row === LOADING) return false
          if (!row) return true
          if (row.repoPath) paths.add(row.repoPath)
          if (!row.archived && !row.deletedAt && scoped(row, agents, true, id)) {
            scope.push(id)
            if (row.assignee) assignees.add(row.assignee)
            for (const label of row.labels) labels.add(label)
          }
          return true
        }
        let pending = false
        for (const id of bucket('all')) if (!visit(id)) pending = true
        const start = performance.now(),
          cold = pool.queries
            .ids({ kind: 'boardCatalog' })
            .filter((id) => !pool.tables.issue.has(id))
        for (const id of cold) if (!visit(id)) pending = true
        countIssueBoard('catalogColdVisits', cold.length)
        countIssueBoard('catalogColdMs', performance.now() - start)
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
      }),
    )
  }
  function issue(id: string): Loaded<IssueViewModel> {
    return memo(`row:${id}`, () => {
      countIssueBoard('rowModels')
      const value = facts(id)
      if (!value || value === LOADING) return value
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const row = pool.row('issue', childId, 'summary-fields') as Loaded<{ stage?: string }>
        if (row === LOADING) return LOADING
        if (row?.stage === 'done') childDoneCount++
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
      const memberSessionIds = [...pool.graph.many('issue', id, 'pageSessions')]
        .sort(byId)
        .map(asSessionId)
      const readAt = pool.readCursor(id) ?? null,
        readTime = Date.parse(readAt ?? '')
      let unread = !Number.isFinite(readTime) || Date.parse(value.updatedAt) > readTime
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
  function progress(id: string, now: number) {
    if (pool.graph.many('issue', id, 'treeChildren')[Symbol.iterator]().next().done) return null
    return memo(`progress:${id}:${now}`, () => {
      let total = 0,
        done = 0,
        liveAgents = 0
      const seen = new Set([id]),
        stack = [...pool.graph.many('issue', id, 'treeChildren')]
      while (stack.length) {
        const next = stack.pop()!
        if (seen.has(next)) continue
        seen.add(next)
        const row = facts(next)
        if (row === LOADING) return LOADING
        if (!row || row.archived || row.deletedAt || row.isDraftVessel) continue
        total++
        if (row.stage === 'done') done++
        const seats = sessions(next)
        if (seats === LOADING) return LOADING
        liveAgents += confirmedWorkingAgentCount(seats ?? [], now)
        stack.push(...pool.graph.many('issue', next, 'treeChildren'))
      }
      return total ? { total, done, liveAgents } : null
    })
  }
  /** Positions need eight scalar fields. Rich cards belong to the virtual
   * window; addressed actions/details obtain the same canonical row model. */
  function placement(id: string): Loaded<IssueViewModel> {
    if (pool.tables.issue.has(id)) return facts(id)
    return memo(`placement:${id}`, () => {
      const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
      if (!row || row === LOADING) return row
      return {
        id: asIssueId(id),
        seq: row.seq,
        stage: row.stage,
        priority: row.priority,
        parentId: pool.graph.one('issue', id, 'treeParent') ?? row.parentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        title: row.title,
        memberSessionIds: [],
      } as unknown as IssueViewModel
    })
  }
  function card(options: { id: string; now: number; agents?: boolean }): Loaded<BoardCardData> {
    return memo(`card:${JSON.stringify(options)}`, () => {
      const row = issue(options.id),
        roster = sessions(options.id)
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
          const child = facts(childId)
          if (child === LOADING) return LOADING
          if (
            child &&
            child.id !== row.id &&
            !child.archived &&
            !child.deletedAt &&
            scoped(child, options.agents ?? false, true)
          )
            counts.set(child.stage, (counts.get(child.stage) ?? 0) + 1)
        }
      }
      const rollup = progress(row.id, options.now)
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
  function board(options: BoardOptions): Loaded<PoolBoardData> {
    return memo(`board:${JSON.stringify(options)}`, () => {
      const found = queryIds({
        kind: 'board',
        filter: options.filter,
        showAgentTasks: options.display.showAgentTasks,
      })
      const choices = catalog(options.display.showAgentTasks)
      if (!found || found === LOADING || !choices || choices === LOADING) return LOADING
      const active: IssueViewModel[] = []
      for (const id of found.ids) {
        const row = options.windowed ? placement(id) : facts(id)
        if (row === LOADING) return LOADING
        if (row) active.push(row)
      }
      const roots = partitionIssueTree(active).roots
      const layout = options.isMobile ? 'list' : options.display.layout
      const expanded = new Set(options.expanded)
      const needsRows = layout === 'list' || options.openIssueId !== null
      const groups = needsRows
        ? issueRowsByStage(active, options.display.ordering, { flatten: false, expanded })
        : []
      const shown = new Set(
        options.windowed
          ? (options.addressed ?? [])
          : [
              ...roots.map((row) => row.id),
              ...groups.flatMap((group) => group.rows.map((row) => row.issue.id)),
            ],
      )
      if (options.openIssueId) shown.add(options.openIssueId)
      const models = new Map<string, IssueViewModel>(),
        seats = new Map<string, SessionView>()
      for (const id of shown) {
        const row = issue(id),
          roster = sessions(id)
        if (row === LOADING || roster === LOADING) return LOADING
        if (row) models.set(id, row)
        for (const seat of roster ?? []) seats.set(seat.sessionId, seat)
      }
      const boardIssues = roots.map((row) => models.get(row.id) ?? row)
      const rowGroups = groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => ({ ...row, issue: models.get(row.issue.id) ?? row.issue })),
      }))
      const listIds = flattenRowGroups(rowGroups)
      const orderedByStage = groupIssuesByStage(boardIssues, options.display.ordering)
      const nav: PoolBoardData['view']['nav'] =
        layout === 'list'
          ? { kind: 'rows', ids: listIds }
          : {
              kind: 'columns',
              columns: orderedByStage.map((column) => column.issues.map((row) => row.id)),
            }
      const presentIds = new Set(nav.kind === 'rows' ? nav.ids : nav.columns.flat())
      const stageCounts = new Map<string, { stage: IssueViewModel['stage']; count: number }[]>(),
        epicProgress: PoolBoardData['view']['epicProgress'] = new Map()
      const scopeIds = new Set(choices.scope)
      const rootIds = new Set(boardIssues.map((row) => row.id))
      for (const root of options.windowed ? [] : models.values()) {
        if (scopeIds.has(root.id) && root.childIds.length) {
          const counts = new Map<string, number>()
          for (const childId of pool.graph.many('issue', root.id, 'treeChildren'))
            if (childId !== root.id && scopeIds.has(childId)) {
              const child = facts(childId)
              if (child === LOADING) return LOADING
              if (child) counts.set(child.stage, (counts.get(child.stage) ?? 0) + 1)
            }
          const result = ISSUE_STAGES.map((stage) => ({
            stage,
            count: counts.get(stage) ?? 0,
          })).filter((value) => value.count)
          if (result.length) stageCounts.set(root.id, result)
        }
        if (rootIds.has(root.id)) {
          const rollup = progress(root.id, options.now)
          if (rollup === LOADING) return LOADING
          epicProgress.set(root.id, rollup)
        }
      }
      let opened = options.openIssueId ? models.get(options.openIssueId) : undefined
      if (opened) {
        // A single addressed detail may borrow its full row. Opening the board
        // itself and changing filters never promote cold cards to resident.
        const full = pool.row('issue', opened.id) as Loaded<IssueViewModel>
        if (full === LOADING) return LOADING
        if (full)
          opened = {
            ...full,
            ...opened,
            description: text(full.description),
            notes: full.notes === undefined ? undefined : text(full.notes),
            brief: full.brief,
            design: full.design,
            acceptance: full.acceptance,
          }
      }
      const flatIds = opened
        ? flattenRowGroups(
            issueRowsByStage(active, options.display.ordering, { flatten: true, expanded }),
          )
        : []
      const scope: IssueViewModel[] = []
      if (options.menu)
        for (const id of choices.scope) {
          const row = facts(id)
          if (row === LOADING) return LOADING
          if (row) scope.push(row)
        }
      const menuInputs = options.menu
        ? {
            issues: [...models.values()],
            allIssues: scope,
            sessions: [...seats.values()],
            repos: pool.headerViews.ids('repository').flatMap((id) => {
              const row = pool.headerViews.row('repository', id)
              return row ? [row] : []
            }),
            machines: pool.headerViews.machines(),
          }
        : undefined
      return {
        issues: options.windowed
          ? active.map((row) => models.get(row.id) ?? row)
          : [...models.values()],
        sessions: [...seats.values()],
        projectPaths: choices.projectPaths,
        menuInputs,
        view: {
          nonArchived: [],
          scope,
          active: active.map((row) => models.get(row.id) ?? row),
          assignees: choices.assignees,
          labels: choices.labels,
          chips: filterChips(options.filter),
          layout,
          boardIssues,
          stageCounts,
          epicProgress,
          orderedByStage,
          rowGroups,
          listIds,
          nav,
          presentIds,
          ...(opened ? { open: opened } : {}),
          orderedIdsForOpen: opened ? (listIds.includes(opened.id) ? listIds : flatIds) : [],
        },
      }
    })
  }
  function explorerCounts(): Loaded<Record<BoardExplorerTab, number>> {
    return memo('explorerCounts', () => {
      const counts = Object.fromEntries(BOARD_EXPLORER_TABS.map((tab) => [tab, 0])) as Record<
        BoardExplorerTab,
        number
      >
      for (const id of new Set([
        ...bucket('scope'),
        ...pool.queries.ids({ kind: 'boardCounts' }),
      ])) {
        const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
        if (row === LOADING) return LOADING
        if (!row || row.archived || row.deletedAt || !scoped(row, false, false, id)) continue
        const tab = tabOf(row)
        if (tab) counts[tab]++
        if (row.stage !== 'done' && !row.closedReason) {
          const attention = facts(id)
          if (attention === LOADING) return LOADING
          if (attention && actionable(attention)) counts.needs++
        }
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
      const found = queryIds({ kind: 'explorer', tab, query: options.query })
      if (!found || found === LOADING) return LOADING
      const rows: IssueViewModel[] = [],
        byId = new Map<string, IssueViewModel>(),
        rowSessions = new Map<string, SessionView[]>(),
        allSeats = new Map<string, SessionView>()
      for (const id of found.ids) {
        const row = options.windowed ? placement(id) : issue(id)
        if (row === LOADING) return LOADING
        if (row) {
          rows.push(row)
          byId.set(id, row)
        }
      }
      rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const neighbours = new Set<string>(options.windowed ? [] : found.ids)
      for (const id of options.windowed ? [] : found.ids) {
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
        total: BOARD_EXPLORER_TABS.reduce((n, key) => n + (key === 'needs' ? 0 : counts[key]), 0),
        rows,
        byId,
        rowSessions,
        sessions: [...allSeats.values()],
      }
    })
  }
  const source: PoolSource<keyof IssueBoardSourceRows> = {
    read(entity, id) {
      switch (entity) {
        case 'issueBoardWindow':
          return { openIssueId: open.get() ? asIssueId(open.get()!) : null }
        case 'issueBoardQuery':
          return queryIds(JSON.parse(id))
        case 'issueBoardCatalog':
          return catalog(id === 'true')
        case 'issueBoardModel':
          return board(JSON.parse(id))
        case 'issueExplorerModel':
          return explorer(JSON.parse(id))
        case 'issueBoardRow':
          return issue(id)
        case 'issueBoardCard':
          return card(JSON.parse(id))
        case 'issueBoardSessions':
          return sessions(id)
        case 'issueBoardProjection': {
          let view = projections.get(id)
          if (!view) {
            const [entity, key] = JSON.parse(id) as [
              'issueBoardModel' | 'issueExplorerModel',
              string,
            ]
            view = createBoardProjection(
              () => pool.row(entity, key),
              () => {
                if (projections.get(id) === view) projections.delete(id)
              },
            )
            projections.set(id, view)
          }
          return view
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopOwner()
      releaseIndex()
      for (const projection of projections.values()) projection.dispose()
      for (const stop of stops.values()) stop()
      for (const result of [...rosters.values()]) result.dispose()
      rosters.clear()
      stops.clear()
      cache.clear()
      runInAction(() => buckets.clear())
    },
  }
  return {
    ...source,
    board,
    explorer,
    issue,
    card,
    sessions,
    queryIds,
    catalog,
    stats: () => ({
      residentRows: stops.size,
      demandKeys: [...cache.keys()].filter((key) => key.startsWith('query:')).length,
      cached: cache.size,
    }),
  }
}
