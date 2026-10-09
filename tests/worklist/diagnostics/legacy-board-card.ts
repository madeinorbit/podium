/** Frozen pre-migration desktop board card (POD-5828). The board source built
 * a second card graph: a visible-row overlay, a sorted seat projection, a
 * descendant progress walk and child stage counts. Cards now read the shared
 * IssueModel/SessionModel facts; this copy is the parity oracle only. */
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { confirmedWorkingAgentCount, type TaskProgress } from '@podium/client-core/values'
import { asIssueId, asSessionId, CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS, ISSUE_STAGES } from '@podium/model/browser'
import { ISSUE_BOARD_SUMMARIES } from '../../../packages/client-graph/src/issue-board-schema'
import type { MobxPool } from '../../../packages/client-graph/src/pool'
import { isFinished } from '../../../packages/client-graph/src/shared/predicates'
import { LOADING, type Loaded } from '../../../packages/client-graph/src/worklist/rollup'

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const text = (value: unknown): string =>
  typeof value === 'string' ? value : ((value as { value?: string } | undefined)?.value ?? '')

export interface LegacyBoardCard {
  issue: IssueViewModel
  /** Every unarchived, uncollapsed seat including shells, in collapse order. */
  sessions: SessionView[]
  /** The card's fleet: the non-shell seats, by session id. */
  fleet: SessionView[]
  byId: Map<string, IssueViewModel>
  stageCounts: { stage: IssueViewModel['stage']; count: number }[]
  progress: TaskProgress | null
}

export function readLegacyBoardCard(
  pool: MobxPool,
  options: { id: string; agents?: boolean },
): Loaded<LegacyBoardCard> {
  function facts(id: string): Loaded<IssueViewModel> {
    const row = pool.row('issue', id, 'summary-fields')
    if (!row || row === LOADING) return row
    const raw = row as Record<string, unknown>
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
  function scoped(row: IssueViewModel, agents: boolean, liveParents: boolean, id: string = row.id): boolean {
    if (row.isDraftVessel && !row.deletedAt) return false
    if (agents || row.deletedAt || row.audience !== 'agent') return true
    const seen = new Set([id])
    let parent = pool.graph.one('issue', id, 'treeParent')
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const value = pool.queries.issueScope(parent)
      if (!value || (value.draft && !value.deleted) || (liveParents && (value.archived || value.deleted)))
        return false
      if (value.deleted || !value.agent) return true
      parent = pool.graph.one('issue', parent, 'treeParent')
    }
    return false
  }
  function cardSessions(id: string): Loaded<SessionView[]> {
    const seats = pool.queries.project({ kind: 'commandIssueSessions', issueId: id,
      archived: false, includeShells: true }, `LegacyBoard@sessions:${id}`, sid =>
      pool.graph.isCollapsed('session', sid) ? undefined
        : pool.row('session', sid, 'summary') as Loaded<SessionView>)
    if (!seats || seats === LOADING) return seats
    return seats.slice().sort((a, b) => pool.graph.orderKey('session', a.sessionId)
      .localeCompare(pool.graph.orderKey('session', b.sessionId)))
  }
  function issue(id: string): Loaded<IssueViewModel> {
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
      const row = pool.row('issue', sourceId, 'summary-fields') as Loaded<{ deps?: { id: string; type: string }[] }>
      if (row === LOADING) return LOADING
      for (const dep of row?.deps ?? [])
        if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
    }
    const visibleSeats = cardSessions(id)
    if (visibleSeats === LOADING) return LOADING
    const memberSessionIds = (visibleSeats ?? []).filter(seat => seat.agentKind !== 'shell')
      .map(seat => seat.sessionId).sort(byId).map(asSessionId)
    const readAt = pool.readCursor(id) ?? null,
      readTime = Date.parse(readAt ?? '')
    let unread = !Number.isFinite(readTime) || Date.parse(value.updatedAt) > readTime
    if (!pool.graph.many('issue', id, 'pageSessions')[Symbol.iterator]().next().done) {
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
  }
  function workingAgents(seats: readonly SessionView[]): number {
    for (const seat of seats) {
      if (seat.status !== 'live' || seat.archived || seat.agentKind === 'shell' ||
        !['working', 'compacting'].includes(seat.agentState?.phase ?? '')) continue
      const at = Math.max(...[seat.lastActiveAt, seat.agentState?.since, seat.agentState?.stateObservedAt]
        .map(stamp => Date.parse(stamp ?? '')).filter(Number.isFinite))
      if (Number.isFinite(at)) pool.clock.passed(at + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS)
    }
    return confirmedWorkingAgentCount(seats, pool.clock.peekNow())
  }
  function progress(id: string): Loaded<TaskProgress | null> {
    if (pool.graph.many('issue', id, 'treeChildren')[Symbol.iterator]().next().done) return null
    let total = 0,
      done = 0,
      liveAgents = 0
    const seen = new Set([id]),
      stack = [...pool.graph.many('issue', id, 'treeChildren')]
    while (stack.length) {
      const next = stack.pop()!
      if (seen.has(next)) continue
      seen.add(next)
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
  }
  const agents = options.agents ?? false
  const row = issue(options.id),
    roster = cardSessions(options.id)
  if (!row || row === LOADING || roster === LOADING) return row === undefined ? undefined : LOADING
  const cards = new Map<string, IssueViewModel>([[row.id, row]])
  for (const other of pool.graph.many('issue', row.id, 'pageDependencies')) {
    const value = facts(other)
    if (value === LOADING) return LOADING
    if (value) cards.set(other, value)
  }
  const counts = new Map<IssueViewModel['stage'], number>()
  if (!row.archived && !row.deletedAt && scoped(row, agents, true)) {
    for (const childId of pool.graph.many('issue', row.id, 'treeChildren')) {
      const child = pool.row('issue', childId, 'summary-fields') as Loaded<IssueViewModel>
      if (child === LOADING) return LOADING
      if (child && child.id !== row.id && !child.archived && !child.deletedAt &&
        scoped(child, agents, true, childId))
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
    byId: cards,
    stageCounts: ISSUE_STAGES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })).filter(
      (value) => value.count,
    ),
    progress: rollup ?? null,
  }
}
