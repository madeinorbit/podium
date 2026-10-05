import { countIssueBoard } from '@podium/client-core/perf'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { BoardRowIssue, IssuesOrdering } from '@podium/client-core/values'
import { filterChips, issueRowsByStage } from '@podium/client-core/values'
import { asIssueId, ISSUE_BOARD_STAGES, isFinished, type IssueStage } from '@podium/model/browser'
import { keyedComputed } from '@podium/mobx-helpers'
import { compareStructural } from 'mobx'
import type { BoardColumnOptions, BoardOptions, BoardQuery, PoolBoardData } from './issue-board-schema'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const equalIds = (a: Loaded<readonly string[]>, b: Loaded<readonly string[]>) =>
  a === b || (!!a && !!b && a !== LOADING && b !== LOADING && a.length === b.length && a.every((id, at) => id === b[at]))
const queryOf = (options: Pick<BoardOptions, 'filter' | 'display'>): BoardQuery => ({
  kind: 'board', filter: options.filter, showAgentTasks: options.display.showAgentTasks,
})
const questionOf = (query: BoardQuery) => {
  const { text: _text, ...filter } = query.filter ?? {}
  return { kind: 'boardIssues' as const, ...filter }
}

/** Ordinary MobX derivations over the feed's existing facets. No board-owned
 * reverse index, reaction writes, rich issue facts, or session catalog. */
export function createBoardLayout(pool: MobxPool) {
  type Scalars = Pick<IssueViewModel, 'parentId' | 'stage' | 'priority' | 'seq' | 'createdAt' | 'updatedAt' | 'deferUntil' | 'blocked' | 'closedReason'>
  const raw = (id: string) => pool.row('issue', id, 'summary-fields') as Loaded<Scalars>
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
    return row === LOADING ? LOADING : row?.stage as IssueStage | undefined
  })
  const status = keyedComputed('IssueBoard.status', (key: string): Loaded<boolean> => {
    const [id, flag] = JSON.parse(key) as [string, string]
    const row = raw(id)
    if (!row || row === LOADING) return row
    const deadline = Date.parse(row.deferUntil as string ?? '')
    const deferred = Number.isFinite(deadline) && !pool.clock.reached(deadline)
    return flag === 'deferred' ? deferred : !row.blocked && !deferred && !isFinished(row)
  })
  const textIds = keyedComputed('IssueBoard.textIds', (needle: string) => pool.queries.localTextIds(needle))
  const matching = keyedComputed('IssueBoard.matchingIds', (key: string): Loaded<string[]> => {
    const query = JSON.parse(key) as BoardQuery
    countIssueBoard('queries')
    const needle = query.filter?.text?.trim() ?? ''
    const text = needle ? textIds(needle) : undefined
    const ids: string[] = []
    for (const id of pool.queries.ids(questionOf(query))) {
      if (text && !text.has(id)) continue
      if (!scope(JSON.stringify([id, query.showAgentTasks ?? false]))) continue
      if (query.filter?.status === 'ready' || query.filter?.status === 'deferred') {
        const value = status(JSON.stringify([id, query.filter.status]))
        if (value === LOADING) return LOADING
        if (!value) continue
      }
      ids.push(id)
    }
    countIssueBoard('matchedIds', ids.length)
    return ids.sort(byId)
  }, { equals: equalIds })
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
  const sortKey = keyedComputed('IssueBoard.sortKey', (key: string): Loaded<readonly [number, number, string]> => {
    const [id, ordering] = JSON.parse(key) as [string, IssuesOrdering]
    const row = raw(id)
    if (!row || row === LOADING) return row
    return ordering === 'priority'
      ? [row.priority as number, row.seq as number, '']
      : [0, 0, row[ordering === 'created' ? 'createdAt' : 'updatedAt'] as string ?? '']
  }, { equals: compareStructural })
  const columnKey = (options: BoardColumnOptions) => JSON.stringify({ filter: options.filter,
    ordering: options.ordering, showAgentTasks: options.showAgentTasks, stage: options.stage })
  function ordered(ids: string[], ordering: IssuesOrdering): Loaded<ReturnType<typeof asIssueId>[]> {
    const keys = new Map<string, readonly [number, number, string]>()
    for (const id of ids) {
      const key = sortKey(JSON.stringify([id, ordering]))
      if (key === LOADING) return LOADING
      if (key) keys.set(id, key)
    }
    return ids.sort((a, b) => {
      const left = keys.get(a)!, right = keys.get(b)!
      return left[0] - right[0] || left[1] - right[1] || right[2].localeCompare(left[2])
    }).map(asIssueId)
  }
  const columnIds = keyedComputed('IssueBoard.columnIds', (key: string): Loaded<ReturnType<typeof asIssueId>[]> => {
    const options = JSON.parse(key) as BoardColumnOptions
    countIssueBoard(`column.${options.stage}`)
    const query: BoardQuery = { kind: 'board', filter: options.filter, showAgentTasks: options.showAgentTasks }
    const queryKey = JSON.stringify(query), all = members(queryKey)
    if (all === LOADING) return LOADING
    // The terminal lane includes all closed reasons. Filters still refer to
    // issueStatusOf, while placement refers to the actual durable stage.
    const statuses = options.filter.stage ? [options.filter.stage]
      : options.stage === 'done' ? ['done', 'cancelled', 'duplicate', 'superseded'] : [options.stage]
    const candidates = new Set(statuses.flatMap(stage => pool.queries.ids({ ...questionOf(query), stage })))
    const ids: string[] = [], cycles: string[] = []
    for (const id of candidates) {
      if (!all.has(id)) continue
      const stage = column(id)
      if (stage === LOADING) return LOADING
      if (stage !== options.stage) continue
      const isRoot = root(JSON.stringify([id, queryKey]))
      if (isRoot === LOADING) return LOADING
      if (isRoot === 1) ids.push(id)
      else if (isRoot === 2) cycles.push(id)
    }
    return ordered([...ids.sort(byId), ...cycles.sort(byId)], options.ordering)
  }, { equals: equalIds })
  const roots = keyedComputed('IssueBoard.rootIds', (key: string): Loaded<ReturnType<typeof asIssueId>[]> => {
    const ids = matching(key)
    if (ids === LOADING) return LOADING
    const result: ReturnType<typeof asIssueId>[] = [], cycles: ReturnType<typeof asIssueId>[] = []
    for (const id of ids ?? []) {
      const value = root(JSON.stringify([id, key]))
      if (value === LOADING) return LOADING
      if (value === 1) result.push(asIssueId(id))
      else if (value === 2) cycles.push(asIssueId(id))
    }
    return [...result, ...cycles]
  }, { equals: equalIds })
  const position = keyedComputed('IssueBoard.listPosition', (key: string): Loaded<BoardRowIssue> => {
    const [id, ordering] = JSON.parse(key) as [string, IssuesOrdering]
    const stage = column(id), parentId = parent(id), sort = sortKey(key)
    if (stage === LOADING || parentId === LOADING || sort === LOADING) return LOADING
    if (!stage || !sort) return undefined
    return { id, parentId, stage, priority: sort[0], seq: sort[1],
      createdAt: ordering === 'created' ? sort[2] : '', updatedAt: ordering === 'updated' ? sort[2] : '' }
  }, { equals: compareStructural })
  const rows = keyedComputed('IssueBoard.listRows', (key: string): Loaded<PoolBoardData['view']['rowGroups']> => {
    const { query, ordering, expanded, flatten } = JSON.parse(key) as {
      query: BoardQuery; ordering: IssuesOrdering; expanded: string[]; flatten: boolean
    }
    const ids = matching(JSON.stringify(query))
    if (ids === LOADING) return LOADING
    const values: BoardRowIssue[] = []
    for (const id of ids ?? []) {
      const value = position(JSON.stringify([id, ordering]))
      if (value === LOADING) return LOADING
      if (value) values.push(value)
    }
    return issueRowsByStage(values, ordering, { expanded: new Set(expanded), flatten }).map(group => ({
      stage: group.stage,
      count: group.rows.filter(row => row.issue.stage === group.stage).length,
      rows: group.rows.map(({ issue, ...rest }) => ({ ...rest, id: asIssueId(issue.id) })),
    }))
  }, { equals: compareStructural })
  const board = keyedComputed('IssueBoard.layout', (key: string): Loaded<PoolBoardData> => {
    const options = JSON.parse(key) as BoardOptions
    const query = queryOf(options), queryKey = JSON.stringify(query)
    const active = matching(queryKey), rootIds = roots(queryKey)
    if (active === LOADING || rootIds === LOADING) return LOADING
    const columns: PoolBoardData['view']['orderedByStage'] = []
    for (const stage of ISSUE_BOARD_STAGES) {
      const ids = columnIds(columnKey({ filter: options.filter, ordering: options.display.ordering,
        showAgentTasks: options.display.showAgentTasks, stage }))
      if (ids === LOADING) return LOADING
      columns.push({ stage, ids: ids ?? [] })
    }
    const layout = options.isMobile ? 'list' : options.display.layout
    const groups = layout === 'list' ? rows(JSON.stringify({ query, ordering: options.display.ordering,
      expanded: options.expanded, flatten: false })) : []
    if (groups === LOADING) return LOADING
    const listIds = groups?.flatMap(group => group.rows.map(row => row.id)) ?? []
    const nav: PoolBoardData['view']['nav'] = layout === 'list' ? { kind: 'rows', ids: listIds }
      : { kind: 'columns', columns: columns.map(column => column.ids) }
    return { activeIds: (active ?? []).map(asIssueId), rootIds: rootIds ?? [], view: {
      layout, chips: filterChips(options.filter), orderedByStage: columns, rowGroups: groups ?? [], listIds,
      nav, presentIds: new Set(nav.kind === 'rows' ? nav.ids : nav.columns.flat()),
    } }
  })
  function boardKey(options: BoardOptions): string {
    return JSON.stringify({ display: { layout: options.display.layout, ordering: options.display.ordering,
      showAgentTasks: options.display.showAgentTasks }, filter: options.filter,
      expanded: options.isMobile || options.display.layout === 'list' ? options.expanded : [], isMobile: options.isMobile })
  }
  return {
    queryIds(query: BoardQuery) {
      const ids = matching(JSON.stringify({ kind: 'board', filter: query.filter ?? {}, showAgentTasks: query.showAgentTasks ?? false }))
      return ids === LOADING ? LOADING : { ids: ids ?? [] }
    },
    board: (options: BoardOptions) => board(boardKey(options)),
    columnIds: (options: BoardColumnOptions) => columnIds(columnKey(options)),
    dropIndex(options: BoardColumnOptions & { id: string }) {
      const { id, ...columnOptions } = options
      const ids = columnIds(columnKey(columnOptions))
      if (ids === LOADING) return LOADING
      const next = ordered([...(ids ?? []).filter(other => other !== id), id], options.ordering)
      return next === LOADING ? LOADING : next?.indexOf(asIssueId(id)) ?? 0
    },
    openIds(options: BoardOptions, id: string) {
      const query = queryOf(options)
      const groups = rows(JSON.stringify({ query, ordering: options.display.ordering, expanded: options.expanded, flatten: false }))
      if (groups === LOADING) return LOADING
      const ids = groups?.flatMap(group => group.rows.map(row => row.id)) ?? []
      if (ids.includes(asIssueId(id))) return ids
      const flat = rows(JSON.stringify({ query, ordering: options.display.ordering, expanded: [], flatten: true }))
      return flat === LOADING ? LOADING : flat?.flatMap(group => group.rows.map(row => row.id)) ?? []
    },
    stats: () => ({ demandKeys: matching.size,
      cached: [scope, parent, column, status, textIds, matching, members, root, sortKey, columnIds, roots, position, rows, board]
        .reduce((total, cache) => total + cache.size, 0) }),
    dispose() {
      for (const cache of [scope, parent, column, status, textIds, matching, members, root, sortKey, columnIds, roots, position, rows, board]) cache.clear()
    },
  }
}
