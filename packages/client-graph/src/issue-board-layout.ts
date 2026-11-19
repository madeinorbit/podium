import type { IssueViewModel } from '@podium/client-core/replica'
import type {
  BoardFilter,
  BoardFilterIssue,
  BoardRowIssue,
  IssuesOrdering,
} from '@podium/client-core/values'
import { filterBoardIssues, filterChips, issueRowsByStage } from '@podium/client-core/values'
import { keyedComputed } from '@podium/mobx-helpers'
import { SIDEBAR_STAGES } from '@podium/model'
import {
  asIssueId,
  ISSUE_BOARD_STAGES,
  type IssueStage,
  isFinished,
  issueStatusOf,
  machinePathKey,
} from '@podium/model/browser'
import { compareStructural, observe, untracked } from 'mobx'
import { ISSUE_STUBS, type IssueStub, stagePage, stagePriorityPage } from './collections'
import type {
  BoardColumnOptions,
  BoardOptions,
  BoardQuery,
  PoolBoardData,
} from './issue-board-schema'
import { issueSearch } from './issue-search'
import { omitGone } from './lookup'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { LOADING, type Loaded } from './worklist/rollup'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const equalIds = (a: Loaded<readonly string[]>, b: Loaded<readonly string[]>) =>
  a === b ||
  (!!a &&
    !!b &&
    a !== LOADING &&
    b !== LOADING &&
    a.length === b.length &&
    a.every((id, at) => id === b[at]))
const queryOf = (options: Pick<BoardOptions, 'filter' | 'display'>): BoardQuery => ({
  kind: 'board',
  filter: options.filter,
  showAgentTasks: options.display.showAgentTasks,
})
const questionOf = (query: BoardQuery) => {
  const { text: _text, ...filter } = query.filter ?? {}
  return { kind: 'boardIssues' as const, ...filter }
}

/** The exact collection that supplies this column, including a partially held page. */
function columnInstance(pool: MobxPool, options: Pick<BoardColumnOptions, 'stage' | 'filter'>) {
  const sidebar = { collection: 'issueProjection.sidebar', part: 'main' } as const
  if (
    !options.filter.archived &&
    !options.filter.deleted &&
    (SIDEBAR_STAGES as readonly string[]).includes(options.stage) &&
    pool.collections.complete(sidebar)
  )
    return sidebar
  return options.filter.priority != null
    ? stagePriorityPage(options.stage, options.filter.priority)
    : stagePage(options.stage)
}

/** Screen freshness follows its shown columns and count source, never a global sync flag. */
export function boardRefreshing(
  pool: MobxPool,
  stages: readonly string[],
  filter: BoardColumnOptions['filter'],
): boolean {
  const instances = stages.map((stage) =>
    columnInstance(pool, { stage: stage as BoardColumnOptions['stage'], filter }),
  )
  return (
    pool.collections.reading(undefined, [ISSUE_STUBS, ...instances]) === 'refreshing' ||
    Boolean(
      filter.text?.trim() &&
        issueSearch(pool).read(filter.text, pool.queries.localTextIds(filter.text)).refreshing,
    )
  )
}

/** Ordinary MobX derivations over the feed's existing facets. No board-owned
 * reverse index, reaction writes, rich issue facts, or session catalog. */
export function createBoardLayout(pool: MobxPool) {
  type Scalars = Pick<
    IssueViewModel,
    | 'parentId'
    | 'stage'
    | 'priority'
    | 'seq'
    | 'createdAt'
    | 'updatedAt'
    | 'deferUntil'
    | 'blocked'
    | 'closedReason'
  >
  const raw = (id: string) => omitGone(pool.row('issue', id)) as Loaded<Scalars>
  const scope = keyedComputed('IssueBoard.inScope', (key: string): boolean => {
    const [id, agents] = JSON.parse(key) as [string, boolean]
    const row = pool.queries.issueScope(id)
    if (!row || (row.draft && !row.deleted)) return false
    if (agents || row.deleted || !row.agent) return true
    const seen = new Set([id])
    let parent = pool.graph.one('issue', id, 'treeParent')
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const ancestor = pool.queries.issueScope(parent)
      if (!ancestor || (ancestor.draft && !ancestor.deleted)) return false
      if (ancestor.deleted || !ancestor.agent) return true
      parent = pool.graph.one('issue', parent, 'treeParent')
    }
    return false
  })
  const parent = keyedComputed('IssueBoard.parent', (id: string): Loaded<string> => {
    const resolved = pool.graph.one('issue', id, 'treeParent')
    if (resolved) return resolved
    const row = raw(id)
    return row === LOADING ? LOADING : row?.parentId
  })
  const column = keyedComputed('IssueBoard.column', (id: string): Loaded<IssueStage> => {
    const row = raw(id)
    return row === LOADING ? LOADING : (row?.stage as IssueStage | undefined)
  })
  const status = keyedComputed('IssueBoard.status', (key: string): Loaded<boolean> => {
    const [id, flag] = JSON.parse(key) as [string, string]
    const row = raw(id)
    if (!row || row === LOADING) return row
    const deadline = Date.parse((row.deferUntil as string) ?? '')
    const deferred = Number.isFinite(deadline) && !pool.clock.reached(deadline)
    return flag === 'deferred' ? deferred : !row.blocked && !deferred && !isFinished(row)
  })
  // The text filter's candidates: the device's matches and the server's hits.
  // `exact` once the server's answer covers history in the pages read (POD-7175).
  const textSearch = keyedComputed('IssueBoard.textSearch', (needle: string) => {
    const answer = issueSearch(pool).read(needle, pool.queries.localTextIds(needle))
    return { ids: new Set(answer.ids), exact: answer.complete && !answer.more }
  })
  const textIds = (needle: string) => textSearch(needle).ids
  const matchesFacet = keyedComputed('IssueBoard.matchesFacet', (key: string): Loaded<boolean> => {
    const [id, queryKey] = JSON.parse(key) as [string, string]
    const query = JSON.parse(queryKey) as BoardQuery
    const row = omitGone(pool.row('issue', id)) as Loaded<BoardFilterIssue>
    if (!row || row === LOADING) return row
    const { text: _text, status, ...filter } = query.filter ?? {}
    // Facets narrow the candidates; this per-issue scalar answer also keeps
    // the shared filter semantics when the source supplies broader IDs.
    return (
      filterBoardIssues([row], {
        ...filter,
        status: status === 'ready' || status === 'deferred' ? undefined : status,
      }).length === 1
    )
  })
  // biome-ignore format: the shared work-counter transform anchors this declaration.
  const matching = keyedComputed('IssueBoard.matchingIds',
    (key: string): Loaded<string[]> => {
      const query = JSON.parse(key) as BoardQuery
      // Text owns only its candidate IDs. Keep the scalar filter answer shared
      // while typing, instead of rebuilding it for every matching issue.
      const { text: _text, ...filter } = query.filter ?? {}
      const facetKey = JSON.stringify({
        kind: 'board',
        filter,
        showAgentTasks: query.showAgentTasks,
      })

      const needle = query.filter?.text?.trim() ?? ''
      const text = needle ? textIds(needle) : undefined
      const ids: string[] = []
      for (const id of pool.queries.ids(questionOf(query))) {
        if (text && !text.has(id)) continue
        if (!scope(JSON.stringify([id, query.showAgentTasks ?? false]))) continue
        const matches = matchesFacet(JSON.stringify([id, facetKey]))
        if (matches === LOADING) return LOADING
        if (!matches) continue
        if (query.filter?.status === 'ready' || query.filter?.status === 'deferred') {
          const value = status(JSON.stringify([id, query.filter.status]))
          if (value === LOADING) return LOADING
          if (!value) continue
        }
        ids.push(id)
      }

      return ids.sort(byId)
    },
    { equals: equalIds },
  )
  const members = keyedComputed('IssueBoard.members', (key: string) => {
    const ids = matching(key)
    return ids === LOADING ? LOADING : new Set(ids)
  })
  const root = keyedComputed('IssueBoard.root', (key: string): Loaded<0 | 1 | 2> => {
    const [id, queryKey] = JSON.parse(key) as [string, string]
    const ids = members(queryKey)
    if (ids === LOADING) return LOADING
    const first = parent(id)
    if (first === LOADING) return LOADING
    if (!first || first === id || !ids.has(first)) return 1
    // Match the shared tree partition's deterministic cycle fallback. An
    // ordinary child stays nested; the first ID of a cycle becomes its root.
    const path = [id]
    const seen = new Map([[id, 0]])
    let next: string | undefined = first
    while (next && ids.has(next)) {
      const at = seen.get(next)
      if (at !== undefined) return [...path].sort(byId)[0] === id ? 2 : 0
      seen.set(next, path.length)
      path.push(next)
      const value: Loaded<string> = parent(next)
      if (value === LOADING) return LOADING
      next = value
    }
    return 0
  })
  const sortKey = keyedComputed(
    'IssueBoard.sortKey',
    (key: string): Loaded<readonly [number, number, string]> => {
      const [id, ordering] = JSON.parse(key) as [string, IssuesOrdering]
      const row = raw(id)
      if (!row || row === LOADING) return row
      return ordering === 'priority'
        ? [row.priority as number, row.seq as number, '']
        : [0, 0, (row[ordering === 'created' ? 'createdAt' : 'updatedAt'] as string) ?? '']
    },
    { equals: compareStructural },
  )
  const columnKey = (options: BoardColumnOptions) =>
    JSON.stringify({
      filter: options.filter,
      ordering: options.ordering,
      showAgentTasks: options.showAgentTasks,
      stage: options.stage,
    })
  const columnResults = new Map<
    string,
    ReturnType<typeof createQueryResult<ReturnType<typeof asIssueId>>>
  >()
  // Dates are canonical ISO scalars. Reverse their characters so the existing
  // ordered query uses the same descending order as the board's comparator.
  function descendingDate(value: string): string {
    let result = ''
    for (const character of value) result += String.fromCharCode(0xffff - character.charCodeAt(0))
    return result + '\uffff'
  }
  function ordered(
    ids: string[],
    ordering: IssuesOrdering,
  ): Loaded<ReturnType<typeof asIssueId>[]> {
    const keys = new Map<string, readonly [number, number, string]>()
    for (const id of ids) {
      const key = sortKey(JSON.stringify([id, ordering]))
      if (key === LOADING) return LOADING
      if (key) keys.set(id, key)
    }
    return ids
      .sort((a, b) => {
        const left = keys.get(a)!,
          right = keys.get(b)!
        return left[0] - right[0] || left[1] - right[1] || right[2].localeCompare(left[2])
      })
      .map(asIssueId)
  }
  // biome-ignore format: the shared work-counter transform anchors this declaration.
  const columnIds = keyedComputed('IssueBoard.columnIds',
    (key: string): Loaded<ReturnType<typeof asIssueId>[]> => {
      const options = JSON.parse(key) as BoardColumnOptions

      const query: BoardQuery = {
        kind: 'board',
        filter: options.filter,
        showAgentTasks: options.showAgentTasks,
      }
      const queryKey = JSON.stringify(query)
      // The terminal lane includes all closed reasons. Filters still refer to
      // issueStatusOf, while placement refers to the actual durable stage.
      const statuses = options.filter.stage
        ? [options.filter.stage]
        : isFinished(options)
          ? ['done', 'cancelled', 'duplicate', 'superseded']
          : [options.stage]
      const questions = statuses.map((stage) => ({ ...questionOf(query), stage }))
      let result = columnResults.get(key)
      if (!result) {
        result = createQueryResult({
          name: `IssueBoard.column:${key}`,
          // untracked-read: board-column-seed
          ids: () => untracked(() => new Set(questions.flatMap((question) => pool.queries.ids(question)))),
          // untracked-read: board-column-probe
          has: (id) => untracked(() => questions.some((question) => pool.queries.has(question, id))),
          read: (id) => {
            const all = members(queryKey)
            if (all === LOADING) return LOADING
            if (!all.has(id)) return undefined
            const stage = column(id)
            if (stage === LOADING) return LOADING
            if (stage !== options.stage) return undefined
            const isRoot = root(JSON.stringify([id, queryKey]))
            return isRoot === LOADING ? LOADING : isRoot ? asIssueId(id) : undefined
          },
          order: (id) => {
            const value = sortKey(JSON.stringify([id, options.ordering]))
            if (!value || value === LOADING) return ''
            const placement = root(JSON.stringify([id, queryKey]))
            if (placement === LOADING) return ''
            return `${String(value[0]).padStart(16, '0')}:${String(value[1]).padStart(16, '0')}:${descendingDate(value[2])}:${placement}`
          },
          subscribe: (changed) => {
            // A feed publication's records come in `onChange` below, all at
            // once. Read as each enters the table, the column found the page's
            // later records absent and looked each one up (POD-7174).
            const stopTable = observe(pool.tables.issue, (change) => {
              if (!pool.queries.inPublication) changed(change.name)
            })
            const stopFeed = pool.queries.onChange((event) => {
              if (event.type === 'replace') changed(undefined)
              else for (const row of event.rows) if (row.kind === 'issue') changed(row.id)
            })
            return () => {
              stopTable()
              stopFeed()
            }
          },
          released: () => columnResults.delete(key),
        })
        columnResults.set(key, result)
      }
      // The helper preserves equal ID snapshots and replaces only the changed
      // ordering path. Reading a column never copies or re-sorts all its IDs.
      return result.get()
    },
  )
  const roots = keyedComputed(
    'IssueBoard.rootIds',
    (key: string): Loaded<ReturnType<typeof asIssueId>[]> => {
      const ids = matching(key)
      if (ids === LOADING) return LOADING
      const result: ReturnType<typeof asIssueId>[] = [],
        cycles: ReturnType<typeof asIssueId>[] = []
      for (const id of ids ?? []) {
        const value = root(JSON.stringify([id, key]))
        if (value === LOADING) return LOADING
        if (value === 1) result.push(asIssueId(id))
        else if (value === 2) cycles.push(asIssueId(id))
      }
      return [...result, ...cycles]
    },
    { equals: equalIds },
  )
  const inColumn = keyedComputed('IssueBoard.inColumn', (id: string) => {
    const value = column(id)
    return value === LOADING ? LOADING : ISSUE_BOARD_STAGES.some((stage) => stage === value)
  })
  const presentRoots = keyedComputed('IssueBoard.presentRoots', (key: string) => {
    const ids = roots(key)
    if (ids === LOADING) return LOADING
    const result = new Set<string>()
    for (const id of ids ?? []) {
      const value = inColumn(id)
      if (value === LOADING) return LOADING
      if (value) result.add(id)
    }
    return result
  })
  const position = keyedComputed(
    'IssueBoard.listPosition',
    (key: string): Loaded<BoardRowIssue & { closedReason?: string | null }> => {
      const [id, ordering] = JSON.parse(key) as [string, IssuesOrdering]
      const stage = column(id),
        parentId = parent(id),
        sort = sortKey(key)
      const row = raw(id)
      if (stage === LOADING || parentId === LOADING || sort === LOADING || row === LOADING)
        return LOADING
      if (!stage || !sort) return undefined
      return {
        id,
        parentId,
        stage,
        closedReason: row?.closedReason,
        priority: sort[0],
        seq: sort[1],
        createdAt: ordering === 'created' ? sort[2] : '',
        updatedAt: ordering === 'updated' ? sort[2] : '',
      }
    },
    { equals: compareStructural },
  )
  const rows = keyedComputed(
    'IssueBoard.listRows',
    (key: string): Loaded<PoolBoardData['view']['rowGroups']> => {
      const { query, ordering, expanded, flatten } = JSON.parse(key) as {
        query: BoardQuery
        ordering: IssuesOrdering
        expanded: string[]
        flatten: boolean
      }
      const ids = matching(JSON.stringify(query))
      if (ids === LOADING) return LOADING
      const values: BoardRowIssue[] = []
      for (const id of ids ?? []) {
        const value = position(JSON.stringify([id, ordering]))
        if (value === LOADING) return LOADING
        if (value) values.push(value)
      }
      return issueRowsByStage(values, ordering, { expanded: new Set(expanded), flatten }).map(
        (group) => ({
          stage: group.stage,
          count: group.rows.filter((row) => row.issue.stage === group.stage).length,
          rows: group.rows.map(({ issue, ...rest }) => ({ ...rest, id: asIssueId(issue.id) })),
        }),
      )
    },
    { equals: compareStructural },
  )
  const board = keyedComputed('IssueBoard.layout', (key: string): Loaded<PoolBoardData> => {
    const options = JSON.parse(key) as BoardOptions
    const query = queryOf(options),
      queryKey = JSON.stringify(query)
    const active = matching(queryKey),
      rootIds = roots(queryKey),
      present = presentRoots(queryKey)
    if (active === LOADING || rootIds === LOADING || present === LOADING) return LOADING
    const columns: PoolBoardData['view']['orderedByStage'] = []
    for (const stage of ISSUE_BOARD_STAGES) {
      const ids = columnIds(
        columnKey({
          filter: options.filter,
          ordering: options.display.ordering,
          showAgentTasks: options.display.showAgentTasks,
          stage,
        }),
      )
      if (ids === LOADING) return LOADING
      columns.push({ stage, ids: ids ?? [] })
    }
    const layout = options.isMobile ? 'list' : options.display.layout
    const groups =
      layout === 'list'
        ? rows(
            JSON.stringify({
              query,
              ordering: options.display.ordering,
              expanded: options.expanded,
              flatten: false,
            }),
          )
        : []
    if (groups === LOADING) return LOADING
    const listIds = groups?.flatMap((group) => group.rows.map((row) => row.id)) ?? []
    const nav: PoolBoardData['view']['nav'] =
      layout === 'list'
        ? { kind: 'rows', ids: listIds }
        : { kind: 'columns', columns: columns.map((column) => column.ids) }
    return {
      activeIds: (active ?? []) as ReturnType<typeof asIssueId>[],
      rootIds: rootIds ?? [],
      view: {
        layout,
        chips: filterChips(options.filter),
        orderedByStage: columns,
        rowGroups: groups ?? [],
        listIds,
        nav,
        presentIds: nav.kind === 'rows' ? new Set(nav.ids) : present,
      },
    }
  })
  // -------------------------------------------------------- held and counted
  // A column shows what the device holds at once (POD-7088, design "Where
  // each question gets its answer": board columns). Its count is exact
  // locally only when the device holds the whole column: the sidebar
  // collection holds every open stage that is not proposed, a stage page
  // read to its end holds the rest. Otherwise the column reads its page,
  // which asks for it and holds it while the column is read (POD-7158), and
  // its count comes from the stubs when the filter reads only stub fields,
  // with the page when it filters by priority, from its cards when a text
  // filter's search answer is complete (POD-7175), else LOADING.
  const SIDEBAR = { collection: 'issueProjection.sidebar', part: 'main' } as const
  const pageOf = (options: BoardColumnOptions) =>
    options.filter.priority != null
      ? stagePriorityPage(options.stage, options.filter.priority)
      : stagePage(options.stage)
  const columnHeld = keyedComputed('IssueBoard.columnHeld', (key: string): boolean => {
    const options: BoardColumnOptions = JSON.parse(key)
    if (!pool.collections.available) return true
    // No collection holds archived or deleted issues by stage.
    if (options.filter.archived || options.filter.deleted) return false
    if (
      (SIDEBAR_STAGES as readonly string[]).includes(options.stage) &&
      pool.collections.complete(SIDEBAR)
    )
      return true
    if (pool.collections.pageEnded(pageOf(options))) return true
    return false
  })
  /** The repositories at each filtered project path, by their own records. */
  const reposAt = (paths: readonly string[]): Set<string> => {
    const keys = new Set(paths.map(machinePathKey)),
      ids = new Set<string>()
    for (const [id, row] of pool.tables.repo) {
      const path = (row as { repoPath?: unknown }).repoPath
      if (typeof path === 'string' && keys.has(machinePathKey(path))) ids.add(id)
    }
    return ids
  }
  /** The board filter as a test over stubs, when it reads only stub fields. */
  function stubFilter(filter: BoardFilter, agents: boolean) {
    if (filter.text?.trim() || filter.priority != null || filter.assignee) return undefined
    if (filter.status === 'ready' || filter.status === 'blocked' || filter.status === 'deferred')
      return undefined
    const repos = filter.projectPaths?.length ? reposAt(filter.projectPaths) : undefined
    return (stub: IssueStub, stubOf: (id: string) => IssueStub | undefined): boolean => {
      if (!(filter.archived || !stub.archived || stub.deletedAt)) return false
      if (!(filter.deleted || !stub.deletedAt)) return false
      const status = issueStatusOf({
        stage: stub.stage,
        closedReason: stub.closedReason,
      } as Parameters<typeof issueStatusOf>[0])
      if (filter.stage && status !== filter.stage) return false
      if (filter.status === 'open' && isFinished(stub as never)) return false
      if (filter.status === 'closed' && !isFinished(stub as never)) return false
      if (repos && !(stub.repoId && repos.has(stub.repoId))) return false
      return stubInScope(stub, stubOf, agents)
    }
  }
  /** The board's audience and draft scope (`scope` above), over stubs. */
  function stubInScope(
    stub: IssueStub,
    stubOf: (id: string) => IssueStub | undefined,
    agents: boolean,
  ): boolean {
    if (stub.isDraftVessel && !stub.deletedAt) return false
    if (agents || stub.deletedAt || stub.audience !== 'agent') return true
    const seen = new Set([stub.id])
    let parent = stub.parentId
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const ancestor = stubOf(parent)
      if (!ancestor || (ancestor.isDraftVessel && !ancestor.deletedAt)) return false
      if (ancestor.deletedAt || ancestor.audience !== 'agent') return true
      parent = ancestor.parentId
    }
    return false
  }
  const columnCount = keyedComputed('IssueBoard.columnCount', (key: string): Loaded<number> => {
    const options: BoardColumnOptions = JSON.parse(key)
    // A filter the stubs can answer is counted from them once they are
    // complete, held column or not: a count never opens the column's rows.
    const member = pool.collections.available
      ? stubFilter(options.filter, options.showAgentTasks)
      : undefined
    const statuses: readonly string[] = options.filter.stage
      ? [options.filter.stage]
      : isFinished(options)
        ? ['done', 'cancelled', 'duplicate', 'superseded']
        : [options.stage]
    // A card is a column root: its parent is not on the board.
    const fromStubs = (test: NonNullable<typeof member>) =>
      pool.collections.countStubs(`board:${key}`, (stub, stubOf) => {
        if (stub.stage !== options.stage || !test(stub, stubOf)) return false
        const status = issueStatusOf({
          stage: stub.stage,
          closedReason: stub.closedReason,
        } as Parameters<typeof issueStatusOf>[0])
        if (!statuses.includes(status)) return false
        const parent = stub.parentId ? stubOf(stub.parentId) : undefined
        return !parent || parent.id === stub.id || !test(parent, stubOf)
      })
    if (member !== undefined && pool.collections.stubsComplete) return fromStubs(member)
    if (columnHeld(key)) {
      const ids = columnIds(key)
      return ids === LOADING ? LOADING : (ids?.length ?? 0)
    }
    if (member !== undefined) return fromStubs(member)
    // A text filter whose search answer is complete names every candidate:
    // its cards in this column are the count (POD-7175).
    const needle = options.filter.text?.trim()
    if (needle && textSearch(needle).exact) {
      const ids = columnIds(key)
      return ids === LOADING ? LOADING : (ids?.length ?? 0)
    }
    // A priority filter's total comes with its page, counted for this viewer.
    const onlyPriority =
      options.filter.priority != null &&
      stubFilter({ ...options.filter, priority: undefined }, options.showAgentTasks) !== undefined
    return onlyPriority ? pool.collections.pageTotal(pageOf(options)) : LOADING
  })

  function boardKey(options: BoardOptions): string {
    return JSON.stringify({
      display: {
        layout: options.display.layout,
        ordering: options.display.ordering,
        showAgentTasks: options.display.showAgentTasks,
      },
      filter: options.filter,
      expanded: options.isMobile || options.display.layout === 'list' ? options.expanded : [],
      isMobile: options.isMobile,
    })
  }
  return {
    queryIds(query: BoardQuery) {
      const ids = matching(
        JSON.stringify({
          kind: 'board',
          filter: query.filter ?? {},
          showAgentTasks: query.showAgentTasks ?? false,
        }),
      )
      return ids === LOADING ? LOADING : { ids: ids ?? [] }
    },
    position: (id: string, ordering: IssuesOrdering) => position(JSON.stringify([id, ordering])),
    board: (options: BoardOptions) => board(boardKey(options)),
    columnIds: (options: BoardColumnOptions) => columnIds(columnKey(options)),
    /** A column's count: exact locally when held whole, else stubs or its page (POD-7088). */
    columnCount: (options: BoardColumnOptions) => columnCount(columnKey(options)),
    /** Whether the device holds the whole column; otherwise its page is on its way. */
    columnHeld: (options: BoardColumnOptions) => columnHeld(columnKey(options)),
    dropIndex(options: BoardColumnOptions & { id: string }) {
      const { id, ...columnOptions } = options
      const ids = columnIds(columnKey(columnOptions))
      if (ids === LOADING) return LOADING
      const next = ordered([...(ids ?? []).filter((other) => other !== id), id], options.ordering)
      return next === LOADING ? LOADING : (next?.indexOf(asIssueId(id)) ?? 0)
    },
    openIds(options: BoardOptions, id: string) {
      const query = queryOf(options)
      const groups = rows(
        JSON.stringify({
          query,
          ordering: options.display.ordering,
          expanded: options.expanded,
          flatten: false,
        }),
      )
      if (groups === LOADING) return LOADING
      const ids = groups?.flatMap((group) => group.rows.map((row) => row.id)) ?? []
      if (ids.includes(asIssueId(id))) return ids
      const flat = rows(
        JSON.stringify({ query, ordering: options.display.ordering, expanded: [], flatten: true }),
      )
      return flat === LOADING
        ? LOADING
        : (flat?.flatMap((group) => group.rows.map((row) => row.id)) ?? [])
    },
    stats: () => ({
      demandKeys: matching.size,
      cached: [
        scope,
        parent,
        column,
        status,
        textSearch,
        matchesFacet,
        matching,
        members,
        root,
        sortKey,
        columnIds,
        columnHeld,
        columnCount,
        roots,
        inColumn,
        presentRoots,
        position,
        rows,
        board,
      ].reduce((total, cache) => total + cache.size, columnResults.size),
    }),
    dispose() {
      for (const result of [...columnResults.values()]) result.dispose()
      columnResults.clear()
      for (const cache of [
        scope,
        parent,
        column,
        status,
        textSearch,
        matchesFacet,
        matching,
        members,
        root,
        sortKey,
        columnIds,
        columnHeld,
        columnCount,
        roots,
        inColumn,
        presentRoots,
        position,
        rows,
        board,
      ])
        cache.clear()
    },
  }
}
