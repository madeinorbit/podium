import { companion, lazy, keyedComputed } from '@podium/mobx-helpers'
import type { ModelOf } from './models'
import { createIssueDetailLists, type DetailSession } from './issue-detail-lists'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type IssueCloseMemberCounts,
  type IssueCloseScalarSubject,
  isEmptyDraftVessel,
  issueDisplayTitle,
} from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model/browser'
import { compareStructural, observe } from 'mobx'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { missions } from './mission'
import { missionView } from './mission-view'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { isFinished } from './shared/predicates'
import { LOADING, type Loaded } from './worklist/rollup'

/** The same pooled issue object, with the page schema's stored-field types.
 * No snapshot or second record is constructed by the detail readers. */
export type PageIssue = ModelOf['issue'] & IssueViewModel

const EMPTY_CHILDREN: PageIssue[] = []
const EMPTY_DETAIL_SESSIONS: DetailSession[] = []

export class IssuePageRow {
  constructor(
    readonly issue: PageIssue,
    readonly pool: MobxPool,
  ) {
    this.lists = createIssueDetailLists(issue, pool)
  }
  readonly lists: ReturnType<typeof createIssueDetailLists>
  /** Page draft naming uses raw page members; worklist naming can use cwd seats. */
  @lazy get title(): string {
    const title = this.issue.authoredTitle
    if (!this.issue.isDraftVessel || (title.trim() && title.trim() !== 'Draft')) return title
    const members = this.lists.liveMembers.get()
    if (members === LOADING) throw LOADING
    return issueDisplayTitle(
      {
        ...this.issue.row,
        id: this.issue.id,
        title,
        memberSessionIds: (members ?? []).map((session) => session.sessionId),
      } as IssueViewModel,
      members ?? [],
      [],
    )
  }
  /** Detail shows activity from every raw member; worklist unread follows its retained seats. */
  @lazy get unread(): boolean {
    const at = Date.parse(this.pool.readCursor(this.issue.id) ?? '')
    return (
      !this.issue.deletedAt &&
      (!Number.isFinite(at) ||
        Date.parse(this.issue.updatedAt) > at ||
        this.issue.memberLatestActivity > at)
    )
  }
  @lazy get presence() {
    const reader = missionView(this.pool),
      present = reader.present(this.issue.id)
    if (present === LOADING) throw LOADING
    return reader.presence(this.issue, present, false, this.issue.id)
  }
  @lazy get hasTargets(): boolean {
    return (
      this.pool.queries.ids({
        kind: 'mobileIssueTargets',
        repoPath: this.issue.repoPath,
        excludeId: this.issue.id,
        query: '',
        limit: 1,
        prefixes: {},
      }).length > 0
    )
  }
  get children() {
    return this.lists.children.get() ?? EMPTY_CHILDREN
  }
  get memberSessions() {
    return this.lists.members.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get activeSessions() {
    return this.lists.active.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get retiredSessions() {
    return this.lists.retired.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get movedOn() {
    return this.lists.moved.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get phoneSessions() {
    return this.lists.phone.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get inspectorSessions() {
    return this.lists.inspector.get() ?? EMPTY_DETAIL_SESSIONS
  }
  /** The displayed roster collapses resume twins; raw action membership does not. */
  get rosterCount(): number {
    return this.pool.graph.subsetSize('issue', this.issue.id, 'missionSessions', 'agents')
  }
  /** A closed retired fold reads IDs plus live exited seats, never archived payloads. */
  get retiredCount(): number {
    return this.pool.graph.subsetSize('issue', this.issue.id, 'missionSessions', 'retiredAgents')
  }
  dispose() {
    this.lists.dispose()
  }
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Presentation helpers preserve the existing vocabulary. Every fact fed to
 * them comes through this pool's one reader and its declared relationships. */
function createIssuePageViews(pool: MobxPool) {
  // Explicit menu/explorer catalogs keep their existing lifetime and comparison.
  const cache = keyedComputed(
    (key: string) => `IssuePage@${key}`,
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const identities = keyedComputed(
    (key: string) => `IssuePage@${key}`,
    (_key: string, read: () => unknown) => read(),
  )
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  const explorerQuestion = { kind: 'explorerSessions' } as const
  const explorerSeats = createQueryResult<SessionView>({
    name: 'IssuePage@explorerSessions',
    ids: () => pool.queries.ids(explorerQuestion),
    has: (id) => pool.queries.has(explorerQuestion, id),
    order: (id) => pool.queries.orderKey(id),
    read: (id) => {
      if (pool.queries.collapsed(id)) return undefined
      const seat = pool.row('session', id, 'summary') as Loaded<SessionView>
      return seat && seat !== LOADING ? { ...seat } : seat
    },
    subscribe: (changed) => {
      const stopTable = observe(pool.tables.session, (change) => changed(change.name))
      const stopFeed = pool.queries.onChange((event) => {
        if (event.type === 'replace') changed(undefined)
        else for (const row of event.rows) if (row.kind === 'session') changed(row.id)
      })
      return () => {
        stopTable()
        stopFeed()
      }
    },
  })
  let disposed = false
  function memo<T>(key: string, read: () => T, identity = false): T {
    if (disposed) return LOADING as T
    return (identity ? identities : cache)(key, read) as T
  }
  function session(id: string): Loaded<SessionView> {
    if (pool.graph.isCollapsed('session', id)) return undefined
    const row = pool.row('session', id) as Loaded<SessionView>
    return row && row !== LOADING ? { ...row } : row
  }
  function attachedSessions(id: string): Loaded<SessionView[]> {
    if (disposed) return LOADING
    return roster(id, 'missionSessions').get()
  }
  function memberSessions(id: string): Loaded<SessionView[]> {
    if (disposed) return LOADING
    return roster(id, 'pageSessions').get()
  }
  function closeFacts(
    id: string,
  ): Loaded<{ subject: IssueCloseScalarSubject; members: IssueCloseMemberCounts }> {
    const known = pool.row('issue', id, 'summary-fields')
    if (!known || known === LOADING) return known
    const model = pool.issueObject(id) as PageIssue
    try {
      return {
        subject: {
          needsHuman: model.closeNeedsHuman,
          asked: model.closeQuestion === undefined ? undefined : { question: model.closeQuestion },
          git: model.closeGit,
          parentBranch: model.parentBranch ?? 'main',
          ...model.closeChildren,
        },
        members: model.closeMembers,
      }
    } catch (error) {
      if (error === LOADING) return LOADING
      throw error
    }
  }
  function roster(
    id: string,
    relation: 'pageSessions' | 'missionSessions' | 'bornSessions',
    excluded: readonly string[] = [],
  ) {
    const key = `${relation}:${id}:${JSON.stringify(excluded)}`
    let result = rosters.get(key)
    if (!result) {
      result = createQueryResult<SessionView>({
        name: `IssuePage@${relation}:${id}`,
        ids: () => pool.graph.many('issue', id, relation),
        has: (sid) => pool.queries.hasMember('issue', id, relation, sid),
        ...(relation === 'pageSessions'
          ? {}
          : { order: (sid: string) => pool.queries.orderKey(sid) }),
        read: (sid) => {
          const value = session(sid)
          if (!value || value === LOADING) return value
          // Keep born/current membership disjoint as sessions move owners.
          // missionSessions is the declared, unfiltered explicit issueId relation.
          return value.issueId && excluded.includes(value.issueId) ? undefined : value
        },
        subscribe: (changed) => pool.queries.onMembers('issue', id, relation, changed),
        released: () => rosters.delete(key),
      })
      rosters.set(key, result)
    }
    return result
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
      const repo = pool.model('repo', repoId)
      return repo?.prefix ?? undefined
    })
    prefixes?.set(repoId, value)
    return value
  }
  function readDependents(id: string): Loaded<IssueViewModel['dependents']> {
    const result: IssueViewModel['dependents'] = []
    let pending = false
    for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
      const source = pool.row('issue', sourceId, 'summary-fields') as Loaded<{
        deps?: { id: string; type: string }[]
      }>
      if (source === LOADING) pending = true
      else
        for (const dep of source?.deps ?? [])
          if (dep.id === id) result.push({ id: asIssueId(sourceId), type: dep.type })
    }
    return pending ? LOADING : result
  }
  function dependents(id: string): Loaded<IssueViewModel['dependents']> {
    return memo(`dependents:${id}`, () => readDependents(id))
  }
  function readSummary(
    id: string,
    prefixes?: Map<string, string | undefined>,
  ): Loaded<IssueViewModel> {
    // Menus need declared fields, not the worklist's computed presence bound.
    const row = pool.row('issue', id, 'summary-fields')
    if (!row || row === LOADING) return row
    // Pick declared menu facts even for a resident row: a read cursor or
    // body update cannot invalidate the whole menu/edge lookup world.
    const value = row as Record<string, unknown>
    const fields = Object.fromEntries(ISSUE_PAGE_SUMMARIES.issue.map((key) => [key, value[key]]))
    const inverse = readDependents(id)
    if (inverse === LOADING) return LOADING
    const p = prefix(id, prefixes)
    const isDeferred = deferred(value.deferUntil as string | null | undefined)
    return {
      ...fields,
      id,
      prefix: p,
      displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
      labels: value.labels ?? [],
      deps: value.deps ?? [],
      dependents: inverse ?? [],
      memberSessionIds: [],
      childIds: [],
      childCount: 0,
      childDoneCount: 0,
      deferred: isDeferred,
      ready: !value.blocked && !isDeferred && !isFinished(value),
    } as unknown as IssueViewModel
  }
  function summary(id: string): Loaded<IssueViewModel> {
    return memo(`summary:${id}`, () => readSummary(id))
  }
  function issues(): Loaded<IssueViewModel[]> {
    if (disposed) return LOADING
    return pool.queries.project({ kind: 'pageIssues' }, 'IssuePage@summaries', readSummary)
  }
  const detailLists = new Set<ReturnType<typeof createIssueDetailLists>>()
  const companions = companion((model: PageIssue) => {
    const page = new IssuePageRow(model, pool)
    detailLists.add(page.lists)
    return page
  })
  function row(id: string): IssuePageRow {
    return companions(pool.issueObject(id) as PageIssue)
  }
  function issue(id: string): Loaded<PageIssue> {
    if (disposed) return LOADING
    const raw = pool.row('issue', id)
    return !raw || raw === LOADING ? raw : (pool.issueObject(id) as PageIssue)
  }
  function menuIssues(): Loaded<IssueViewModel[]> {
    const world = issues()
    if (!world || world === LOADING) return world
    return world.map((value) => {
      const childIds = [...pool.graph.many('issue', value.id, 'treeChildren')].sort(byId)
      const memberSessionIds = [...pool.graph.many('issue', value.id, 'pageSessions')]
        .sort(byId)
        .map(asSessionId)
      return {
        ...value,
        memberSessionIds,
        childIds: childIds.map(asIssueId),
        childCount: childIds.length,
        childDoneCount: childIds.filter((id) => {
          const child = pool.row('issue', id, 'summary') as Loaded<{
            stage?: string
            closedReason?: string | null
          }>
          return child && child !== LOADING && isFinished(child)
        }).length,
      }
    })
  }
  /** Resolve identity before any detail section subscribes to its own fields. */
  function panelIssue(args: {
    issueId?: string
    sessionId?: string
    cwd: string
  }): Loaded<PageIssue> {
    if (disposed) return LOADING
    if (args.issueId) {
      const explicit = issue(args.issueId)
      if (explicit === LOADING || (explicit && !explicit.deletedAt)) return explicit
    }
    if (args.sessionId) {
      const seat = pool.sessionObject(args.sessionId)
      try {
        if (seat.exists) {
          if (!seat.issueId) return undefined
          const attached = issue(seat.issueId)
          return attached === LOADING || (attached && !attached.archived && !attached.deletedAt)
            ? attached
            : undefined
        }
      } catch (error) {
        if (error === LOADING) return LOADING
        throw error
      }
    }
    const id = pool.queries.containingIssueId(args.cwd)
    return id ? issue(id) : undefined
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
    const members = row(rootId).activeSessions
    return members === LOADING
      ? LOADING
      : isEmptyDraftVessel(root, members ?? [])
        ? undefined
        : root
  }
  function explorer(): Loaded<{ issues: IssueViewModel[]; sessions: SessionView[] }> {
    return memo(
      'explorer',
      () => {
        // This retained catalog is explicit full-list demand. Maintain each
        // answer by address; updates never reconstruct or compare its world.
        const world = pool.queries.project(
          { kind: 'pageIssues' },
          'IssuePage@explorerIssues',
          (id) => {
            const value = summary(id)
            if (!value || value === LOADING) return value
            const children = memo(
              `explorerChildren:${id}`,
              () => {
                const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
                let childDoneCount = 0
                for (const childId of childIds) {
                  const child = pool.row('issue', childId, 'summary') as Loaded<{
                    stage?: string
                    closedReason?: string | null
                  }>
                  if (child && child !== LOADING && isFinished(child)) childDoneCount++
                }
                return {
                  childIds: childIds.map(asIssueId),
                  childCount: childIds.length,
                  childDoneCount,
                }
              },
              true,
            )
            const memberSessionIds = memo(
              `explorerMembers:${id}`,
              () => [...pool.graph.many('issue', id, 'pageSessions')].sort(byId).map(asSessionId),
              true,
            )
            return { ...value, ...children, memberSessionIds }
          },
        )
        if (!world || world === LOADING) return world
        const seats = explorerSeats.get()
        return seats === LOADING ? LOADING : { issues: world, sessions: seats ?? [] }
      },
      true,
    )
  }
  return {
    issue,
    summary,
    issues,
    menuIssues,
    row,
    pool,
    panelIssue,
    destination,
    explorer,
    memberSessions,
    attachedSessions,
    closeFacts,
    dispose() {
      disposed = true
      cache.clear()
      identities.clear()
      explorerSeats.dispose()
      for (const lists of detailLists) lists.dispose()
      detailLists.clear()
      for (const roster of rosters.values()) roster.dispose()
      rosters.clear()
    },
  }
}

export type IssuePageViews = ReturnType<typeof createIssuePageViews>
export function issuePages(pool: MobxPool): IssuePageViews {
  return pool.sources.view('issue-page', () => createIssuePageViews(pool))
}
