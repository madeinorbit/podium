import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations, isEmptyDraftVessel, issueDisplayTitle, presenceNote, type ReferentExit } from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { compareStructural, computed, onBecomeUnobserved, _isComputingDerivation, type IComputedValue } from 'mobx'
import { residentWorktreeIds } from './enumerate'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { missions } from './mission'
import type { MobxPool } from './pool'
import { createQueryResult, joinQueryResults } from './query-result'
import { LOADING, type Loaded } from './worklist/rollup'

export interface IssuePageData {
  issue: IssueViewModel
  issues: IssueViewModel[]
  children: IssueViewModel[]
  memberSessions: SessionView[]
  /** Only the addressed page neighbourhood; no legacy session-world read. */
  sessions: SessionView[]
  relations: ReturnType<typeof groupRelations>
  title: string
  presence: ReturnType<typeof presenceNote>
  worktreePaths: string[]
  exits: Readonly<Record<string, ReferentExit | undefined>>
}

type DocumentValue = string | { value: string } | undefined
const text = (value: DocumentValue): string => typeof value === 'string' ? value : value?.value ?? ''
const byId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Presentation helpers preserve the existing vocabulary. Every fact fed to
 * them comes through this pool's one reader and its declared relationships. */
export function createIssuePageViews(pool: MobxPool) {
  const cache = new Map<string, IComputedValue<unknown>>()
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  const stats = { issues: 0, pages: 0, panels: 0 }
  let disposed = false
  function memo<T>(key: string, read: () => T): T {
    if (disposed) return LOADING as T
    if (!_isComputingDerivation()) return read()
    let value = cache.get(key)
    if (!value) {
      value = computed(read, { equals: compareStructural, name: `IssuePage@${key}` })
      cache.set(key, value)
      onBecomeUnobserved(value, () => cache.delete(key))
    }
    return value.get() as T
  }
  function session(id: string): Loaded<SessionView> {
    if (pool.graph.isCollapsed('session', id)) return undefined
    return pool.row('session', id) as Loaded<SessionView>
  }
  function attachedSessions(id: string): Loaded<SessionView[]> {
    if (disposed) return LOADING
    return roster(id, 'missionSessions').get()
  }
  function memberSessions(id: string): Loaded<SessionView[]> {
    if (disposed) return LOADING
    return roster(id, 'pageSessions').get()
  }
  function roster(id: string, relation: 'pageSessions' | 'missionSessions' | 'bornSessions', excluded: readonly string[] = []) {
    const key = `${relation}:${id}:${JSON.stringify(excluded)}`
    let result = rosters.get(key)
    if (!result) {
      result = createQueryResult<SessionView>({
        name: `IssuePage@${relation}:${id}`,
        ids: () => pool.graph.many('issue', id, relation),
        has: sid => pool.queries.hasMember('issue', id, relation, sid),
        ...(relation === 'pageSessions' ? {} : { order: (sid: string) => pool.queries.orderKey(sid) }),
        read: sid => {
          const value = session(sid)
          if (!value || value === LOADING) return value
          // Keep born/current membership disjoint as sessions move owners.
          // missionSessions is the declared, unfiltered explicit issueId relation.
          return value.issueId && excluded.includes(value.issueId) ? undefined : value
        },
        subscribe: changed => pool.queries.onMembers('issue', id, relation, changed),
        released: () => rosters.delete(key),
      })
      rosters.set(key, result)
    }
    return result
  }
  function relatedSessions(id: string, neighbours: ReadonlySet<string>): SessionView[] | typeof LOADING {
    const owners = [...neighbours].sort(byId)
    return memo(`sessions:${id}:${JSON.stringify(owners)}`, () => {
      const groups = [roster(id, 'bornSessions', owners).get(),
        ...owners.map(owner => attachedSessions(owner))]
      if (groups.some(group => group === LOADING)) return LOADING
      return joinQueryResults(groups as SessionView[][])
    })
  }
  function worktreePaths(): string[] {
    return memo('worktree-paths', () => residentWorktreeIds(pool).flatMap(path => {
      const lane = pool.row('worktree', path) as { path?: string; projectRoot?: boolean } | undefined
      return lane?.path && !lane.projectRoot ? [lane.path] : []
    }))
  }
  function bySessionOrder(a: string, b: string): number {
    return byId(pool.queries.orderKey(a), pool.queries.orderKey(b)) || byId(a, b)
  }
  function deferred(until: string | null | undefined): boolean {
    const deadline = until == null ? NaN : Date.parse(until)
    return Number.isFinite(deadline) && !pool.clock.reached(deadline)
  }
  function prefix(id: string, prefixes?: Map<string, string | undefined>): string | undefined {
    const repoId = pool.graph.one('issue', id, 'repo')
    if (!repoId) return undefined
    if (prefixes?.has(repoId)) return prefixes.get(repoId)
    const value = memo(`prefix:${repoId}`, () => {
      const repo = pool.row('repo', repoId) as { prefix?: string } | undefined
      return repo?.prefix ?? undefined
    })
    prefixes?.set(repoId, value)
    return value
  }
  function readDependents(id: string): Loaded<IssueViewModel['dependents']> {
    const result: IssueViewModel['dependents'] = []
    let pending = false
    for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
      const source = pool.row('issue', sourceId, 'summary-fields') as Loaded<{ deps?: { id: string; type: string }[] }>
      if (source === LOADING) pending = true
      else for (const dep of source?.deps ?? []) if (dep.id === id) result.push({ id: asIssueId(sourceId), type: dep.type })
    }
    return pending ? LOADING : result
  }
  function dependents(id: string): Loaded<IssueViewModel['dependents']> {
    return memo(`dependents:${id}`, () => readDependents(id))
  }
  function readSummary(id: string, prefixes?: Map<string, string | undefined>): Loaded<IssueViewModel> {
    // Menus need declared fields, not the worklist's computed presence bound.
    const row = pool.row('issue', id, 'summary-fields')
    if (!row || row === LOADING) return row
    // Pick declared menu facts even for a resident row: a read cursor or
    // body update cannot invalidate the whole menu/edge lookup world.
    const value = row as Record<string, unknown>
    const fields = Object.fromEntries(ISSUE_PAGE_SUMMARIES.issue.map(key => [key, value[key]]))
    const inverse = readDependents(id)
    if (inverse === LOADING) return LOADING
    const p = prefix(id, prefixes)
    const isDeferred = deferred(value.deferUntil as string | null | undefined)
    return { ...fields, id, prefix: p, displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
      labels: value.labels ?? [], deps: value.deps ?? [], dependents: inverse ?? [], memberSessionIds: [], childIds: [],
      childCount: 0, childDoneCount: 0, deferred: isDeferred, ready: !value.blocked && !isDeferred && value.stage !== 'done',
    } as unknown as IssueViewModel
  }
  function summary(id: string): Loaded<IssueViewModel> {
    return memo(`summary:${id}`, () => readSummary(id))
  }
  function issues(): Loaded<IssueViewModel[]> {
    if (disposed) return LOADING
    return pool.queries.project({ kind: 'pageIssues' }, 'IssuePage@summaries', readSummary)
  }
  function issue(id: string): Loaded<IssueViewModel> {
    return memo(`issue:${id}`, () => {
      stats.issues++
      const row = pool.row('issue', id)
      if (!row) return row
      const members = memberSessions(id)
      let pending = members === LOADING
      const rawMemberIds = [...pool.graph.many('issue', id, 'pageSessions')].sort(byId)
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const child = pool.row('issue', childId, 'summary') as Loaded<{ stage?: string }>
        if (child === LOADING) pending = true
        else if (child?.stage === 'done') childDoneCount++
      }
      const inverse = dependents(id)
      // Read every known requirement before returning LOADING so this issue's
      // payload, members and summaries share the existing load window.
      if (pending || row === LOADING || inverse === LOADING) return LOADING
      const value = row as IssueViewModel
      const p = prefix(id)
      const isDeferred = deferred(value.deferUntil)
      // Ingest absorbs cursor-only deltas into this existing scalar lane so
      // a mark does not replace the payload or wake every world projection.
      const cursor = pool.readCursor(id) ?? null
      const readAt = Date.parse(cursor ?? '')
      let unread = !Number.isFinite(readAt) || Date.parse(value.updatedAt) > readAt
      const byPhase: Record<string, number> = {}
      let total = 0
      for (const sid of rawMemberIds) {
        const seat = pool.row('session', sid, 'summary') as Loaded<{ lastActiveAt: string; agentState?: { phase?: string | null } }>
        if (seat === LOADING) return LOADING
        if (seat) {
          total++
          const phase = seat.agentState?.phase ?? 'unknown'
          byPhase[phase] = (byPhase[phase] ?? 0) + 1
          if (Date.parse(seat.lastActiveAt) > readAt) unread = true
        }
      }
      return { ...value, id: asIssueId(id),
        description: text(value.description as DocumentValue), notes: value.notes === undefined ? undefined : text(value.notes as DocumentValue),
        branch: value.branch ?? null, worktreePath: value.worktreePath ?? null,
        readAt: cursor, tuckedAt: value.tuckedAt ?? null, pinned: value.pinned ?? false,
        prefix: p, displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
        deps: (value.deps ?? []).map(dep => ({ ...dep, id: asIssueId(dep.id) })), dependents: inverse ?? [],
        memberSessionIds: rawMemberIds.map(asSessionId),
        childIds: childIds.map(asIssueId), childCount: childIds.length, childDoneCount,
        blocked: value.blocked ?? false, deferred: isDeferred, ready: !value.blocked && !isDeferred && value.stage !== 'done', unread: !value.deletedAt && unread,
        sessionSummary: { total, byPhase },
      }
    })
  }
  function menuIssues(): Loaded<IssueViewModel[]> {
    const world = issues()
    if (!world || world === LOADING) return world
    return world.map(value => {
      const childIds = [...pool.graph.many('issue', value.id, 'treeChildren')].sort(byId)
      const memberSessionIds = [...pool.graph.many('issue', value.id, 'pageSessions')].sort(byId).map(asSessionId)
      return { ...value, memberSessionIds, childIds: childIds.map(asIssueId), childCount: childIds.length,
        childDoneCount: childIds.filter(id => {
          const child = pool.row('issue', id, 'summary') as Loaded<{ stage?: string }>
          return child && child !== LOADING && child.stage === 'done'
        }).length,
      }
    })
  }
  function data(id: string): Loaded<IssuePageData> {
    return memo(`page:${id}`, () => {
      stats.pages++
      const value = issue(id)
      if (!value) return value
      let pending = value === LOADING
      const children: IssueViewModel[] = []
      const neighbours = new Set([id, pool.graph.one('issue', id, 'treeParent'),
        pool.graph.one('issue', id, 'supersedingIssue'), pool.graph.one('issue', id, 'canonicalIssue')]
        .filter((key): key is string => Boolean(key)))
      for (const childId of pool.graph.many('issue', id, 'treeChildren')) {
        const child = issue(childId)
        if (child === LOADING) { pending = true; neighbours.add(childId) }
        else if (child && !child.deletedAt) { children.push(child); neighbours.add(child.id) }
      }
      children.sort((a, b) => a.seq - b.seq)
      for (const target of pool.graph.many('issue', id, 'pageDependencies')) neighbours.add(target)
      for (const source of pool.graph.many('issue', id, 'pageDependents')) neighbours.add(source)
      // A continuation can hop through several closed spin-offs before a
      // staffed, unstarted tip. Read those session owners through the already
      // declared origin relation, without loading an unrelated session world.
      const seenOrigins = new Set([id]), origins = [id]
      while (origins.length) {
        const origin = origins.pop()!
        for (const next of pool.graph.many('issue', origin, 'spinOffs')) {
          if (seenOrigins.has(next)) continue
          seenOrigins.add(next)
          const branch = summary(next)
          if (branch === LOADING) { pending = true; continue }
          if (!branch || branch.archived || branch.deletedAt) continue
          neighbours.add(next)
          origins.push(next)
        }
      }
      const sessions = relatedSessions(id, neighbours)
      const members = memberSessions(id)
      const own = attachedSessions(id)
      // Collect all addressed rows in one batch; do not render partial values
      // or build the menu world while this neighbourhood is still loading.
      if (pending || value === LOADING || members === LOADING || own === LOADING || sessions === LOADING) return LOADING
      const world = issues()
      if (!world || world === LOADING) return world
      const worldById = new Map<string, IssueViewModel>()
      const exits: Record<string, ReferentExit | undefined> = {}
      for (const neighbour of neighbours) {
        const target = summary(neighbour)
        if (target === LOADING) return LOADING
        if (target) worldById.set(neighbour, target)
        else {
          const exit = pool.row('issueExit', neighbour)
          if (exit === LOADING) return LOADING
          exits[neighbour] = exit?.kind
        }
      }
      const paths = worktreePaths()
      return { issue: value, issues: world, children, memberSessions: members ?? [], sessions,
        relations: groupRelations(value), title: issueDisplayTitle(value, sessions, paths),
        presence: presenceNote(value, own ?? [], worldById, sessions), worktreePaths: paths, exits,
      }
    })
  }
  function panel(args: { issueId?: string; sessionId?: string; cwd: string }): Loaded<IssuePageData> {
    return memo(`panel:${JSON.stringify(args)}`, () => {
      stats.panels++
      if (args.issueId) {
        const explicit = data(args.issueId)
        if (explicit === LOADING || explicit && !explicit.issue.deletedAt) return explicit
      }
      if (args.sessionId) {
        const seat = session(args.sessionId)
        if (seat === LOADING) return LOADING
        if (seat) {
          if (!seat.issueId) return undefined
          const attached = data(seat.issueId)
          return attached === LOADING || attached && !attached.issue.archived && !attached.issue.deletedAt ? attached : undefined
        }
      }
      // Only file tabs / unknown sessions use containment. The census reads
      // declared summaries, never cold payloads or a second ownership index.
      let best: IssueViewModel | undefined
      let pending = false
      for (const id of pool.queries.ids({ kind: 'containingIssues', cwd: args.cwd })) {
        const row = pool.row('issue', id, 'summary') as Loaded<IssueViewModel>
        if (row === LOADING) { pending = true; continue }
        if (!row || row.archived || row.deletedAt || !row.worktreePath) continue
        const root = row.worktreePath
        if (args.cwd !== root && !args.cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
        if (!best || root.length > best.worktreePath!.length || root.length === best.worktreePath!.length && row.seq < best.seq) best = row
      }
      return pending ? LOADING : best ? data(best.id) : undefined
    })
  }
  function destination(id: string): Loaded<IssueViewModel> {
    const target = issue(id)
    if (target === LOADING) return LOADING
    if (!target || target.archived || target.deletedAt) return undefined
    const rootId = missions(pool).rootFor(id)
    if (rootId === LOADING) return LOADING
    if (!rootId) return undefined
    const root = issue(rootId)
    if (!root || root === LOADING) return root
    const members = attachedSessions(rootId)
    return members === LOADING ? LOADING : isEmptyDraftVessel(root, members ?? []) ? undefined : root
  }
  function explorer(): Loaded<{ issues: IssueViewModel[]; sessions: SessionView[] }> {
    return memo('explorer', () => {
      const world = menuIssues()
      if (!world || world === LOADING) return world
      const seats: SessionView[] = []
      let pending = false
      for (const id of pool.queries.ids({ kind: 'explorerSessions' }).sort(bySessionOrder)) {
        if (pool.queries.collapsed(id)) continue
        const seat = pool.row('session', id, 'summary') as Loaded<SessionView>
        if (seat === LOADING) pending = true
        else if (seat) seats.push(seat)
      }
      return pending ? LOADING : { issues: world, sessions: seats }
    })
  }
  return { issue, summary, issues, menuIssues, data, panel, destination, explorer, memberSessions, attachedSessions, stats,
    dispose() {
      disposed = true
      cache.clear()
      for (const roster of rosters.values()) roster.dispose()
      rosters.clear()
    },
  }
}

export type IssuePageViews = ReturnType<typeof createIssuePageViews>
export function issuePages(pool: MobxPool): IssuePageViews {
  return pool.sources.view('issue-page', () => createIssuePageViews(pool))
}
