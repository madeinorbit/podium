import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { groupRelations, isEmptyDraftVessel, issueDisplayTitle, presenceNote } from '@podium/client-core/viewmodels'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { compareStructural, computed, onBecomeUnobserved, _isComputingDerivation, type IComputedValue } from 'mobx'
import { knownIssueIds, residentWorktreeIds } from './enumerate'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { missions } from './mission'
import type { MobxPool } from './pool'
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
}

type DocumentValue = string | { value: string } | undefined
const text = (value: DocumentValue): string => typeof value === 'string' ? value : value?.value ?? ''
const byId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Presentation helpers preserve the existing vocabulary. Every fact fed to
 * them comes through this pool's one reader and its declared relationships. */
export function createIssuePageViews(pool: MobxPool) {
  const cache = new Map<string, IComputedValue<unknown>>()
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
    return memo(`members:${id}`, () => {
      const result: SessionView[] = []
      let pending = false
      for (const sid of [...pool.graph.many('issue', id, 'missionSessions')].sort(byId)) {
        const value = session(sid)
        if (value === LOADING) pending = true
        else if (value) result.push(value)
      }
      return pending ? LOADING : result
    })
  }
  function memberSessions(id: string): Loaded<SessionView[]> {
    const members = attachedSessions(id)
    return members && members !== LOADING ? members.filter(s => s.agentKind !== 'shell') : members
  }
  function prefix(id: string): string | undefined {
    const repoId = pool.graph.one('issue', id, 'repo')
    const repo = repoId ? pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
    return repo?.prefix ?? undefined
  }
  function summary(id: string): Loaded<IssueViewModel> {
    return memo(`summary:${id}`, () => {
      const row = pool.row('issue', id, 'summary')
      if (!row || row === LOADING) return row
      // Pick declared menu facts even for a resident row: a read cursor or
      // body update cannot invalidate the whole menu/edge lookup world.
      const value = row as Record<string, unknown>
      const fields = Object.fromEntries(ISSUE_PAGE_SUMMARIES.issue.map(key => [key, value[key]]))
      const p = prefix(id)
      return { ...fields, id, prefix: p, displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
        labels: value.labels ?? [], deps: value.deps ?? [], dependents: [], memberSessionIds: [], childIds: [],
        childCount: 0, childDoneCount: 0,
      } as unknown as IssueViewModel
    })
  }
  function issues(): IssueViewModel[] {
    return memo('summaries', () => knownIssueIds(pool).sort(byId).flatMap(id => {
      const value = summary(id)
      return value && value !== LOADING ? [value] : []
    }))
  }
  function issue(id: string): Loaded<IssueViewModel> {
    return memo(`issue:${id}`, () => {
      stats.issues++
      const row = pool.row('issue', id)
      if (!row || row === LOADING) return row
      const value = row as IssueViewModel
      const members = memberSessions(id)
      if (members === LOADING) return LOADING
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const child = pool.row('issue', childId, 'summary') as Loaded<{ stage?: string }>
        if (child === LOADING) return LOADING
        if (child?.stage === 'done') childDoneCount++
      }
      const dependents: IssueViewModel['dependents'] = []
      for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
        const source = pool.row('issue', sourceId, 'summary') as Loaded<{ deps?: { id: string; type: string }[] }>
        if (source === LOADING) return LOADING
        for (const dep of source?.deps ?? []) if (dep.id === id) dependents.push({ id: asIssueId(sourceId), type: dep.type })
      }
      const p = prefix(id)
      const deferred = Boolean(value.deferUntil && !pool.clock.passed(Date.parse(value.deferUntil)))
      const readAt = Date.parse(value.readAt ?? '')
      const unread = !value.deletedAt && (!Number.isFinite(readAt) || Date.parse(value.updatedAt) > readAt ||
        members.some(s => Date.parse(s.lastActiveAt) > readAt))
      return { ...value, id: asIssueId(id),
        description: text(value.description as DocumentValue), notes: value.notes === undefined ? undefined : text(value.notes as DocumentValue),
        branch: value.branch ?? null, worktreePath: value.worktreePath ?? null,
        readAt: value.readAt ?? null, tuckedAt: value.tuckedAt ?? null, pinned: value.pinned ?? false,
        prefix: p, displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
        deps: (value.deps ?? []).map(dep => ({ ...dep, id: asIssueId(dep.id) })), dependents,
        memberSessionIds: members.map(s => asSessionId(s.sessionId)),
        childIds: childIds.map(asIssueId), childCount: childIds.length, childDoneCount,
        blocked: value.blocked ?? false, deferred, ready: !value.blocked && !deferred && value.stage !== 'done', unread,
      }
    })
  }
  function menuIssues(): IssueViewModel[] {
    return issues().map(value => {
      const childIds = [...pool.graph.many('issue', value.id, 'treeChildren')].sort(byId)
      const memberSessionIds = [...pool.graph.many('issue', value.id, 'missionSessions')].sort(byId).filter(id => {
        const seat = pool.row('session', id, 'summary') as Loaded<{ agentKind?: string }>
        return seat && seat !== LOADING && seat.agentKind !== 'shell'
      }).map(asSessionId)
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
      if (!value || value === LOADING) return value
      const children: IssueViewModel[] = []
      const neighbours = new Set([id, value.parentId, value.supersededBy, value.duplicateOf].filter((key): key is string => Boolean(key)))
      for (const childId of pool.graph.many('issue', id, 'treeChildren')) {
        const child = issue(childId)
        if (child === LOADING) return LOADING
        if (child && !child.deletedAt) { children.push(child); neighbours.add(child.id) }
      }
      children.sort((a, b) => a.seq - b.seq)
      for (const target of pool.graph.many('issue', id, 'pageDependencies')) neighbours.add(target)
      for (const source of pool.graph.many('issue', id, 'pageDependents')) neighbours.add(source)
      const sessionIds = new Set<string>(pool.graph.many('issue', id, 'bornSessions'))
      for (const neighbour of neighbours) for (const sid of pool.graph.many('issue', neighbour, 'missionSessions')) sessionIds.add(sid)
      const sessions: SessionView[] = []
      for (const sid of [...sessionIds].sort(byId)) {
        const seat = session(sid)
        if (seat === LOADING) return LOADING
        if (seat) sessions.push(seat)
      }
      const members = memberSessions(id)
      if (members === LOADING) return LOADING
      const world = issues()
      const worldById = new Map(world.map(row => [row.id as string, row]))
      const own = attachedSessions(id)
      if (own === LOADING) return LOADING
      const worktreePaths = residentWorktreeIds(pool).flatMap(path => {
        const lane = pool.row('worktree', path) as { path?: string; projectRoot?: boolean } | undefined
        return lane?.path && !lane.projectRoot ? [lane.path] : []
      })
      return { issue: value, issues: world, children, memberSessions: members, sessions,
        relations: groupRelations(value), title: issueDisplayTitle(value, sessions, worktreePaths),
        presence: presenceNote(value, own ?? [], worldById, sessions), worktreePaths,
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
      for (const id of knownIssueIds(pool)) {
        const row = pool.row('issue', id, 'summary') as Loaded<IssueViewModel>
        if (!row || row === LOADING || row.archived || row.deletedAt || !row.worktreePath) continue
        const root = row.worktreePath
        if (args.cwd !== root && !args.cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
        if (!best || root.length > best.worktreePath!.length || root.length === best.worktreePath!.length && row.seq < best.seq) best = row
      }
      return best ? data(best.id) : undefined
    })
  }
  function destination(id: string): Loaded<IssueViewModel> {
    const target = issue(id)
    if (target === LOADING) return LOADING
    if (!target || target.archived || target.deletedAt) return undefined
    const rootId = missions(pool).rootFor(id)
    if (!rootId || rootId === LOADING) return rootId
    const root = issue(rootId)
    if (!root || root === LOADING) return root
    const members = attachedSessions(rootId)
    return members === LOADING ? LOADING : isEmptyDraftVessel(root, members) ? undefined : root
  }
  return { issue, summary, issues, menuIssues, data, panel, destination, memberSessions, attachedSessions, stats,
    dispose() { disposed = true; cache.clear() },
  }
}

export type IssuePageViews = ReturnType<typeof createIssuePageViews>
export function issuePages(pool: MobxPool): IssuePageViews {
  return pool.sources.view('issue-page', () => createIssuePageViews(pool))
}
