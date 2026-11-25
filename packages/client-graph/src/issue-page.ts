import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type IssueCloseMemberCounts,
  type IssueCloseScalarSubject,
  isEmptyDraftVessel,
  issueDisplayTitle,
} from '@podium/client-core/values'
import { clearCompanions, companion, keyedComputed, lazy } from '@podium/mobx-helpers'
import { asIssueId } from '@podium/model/browser'
import { issueRefText } from '@podium/protocol'
import { compareStructural } from 'mobx'
import { ISSUE_STUBS } from './collections'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { here, omitGone } from './lookup'
import { missions } from './mission'
import { missionView } from './mission-view'
import type { ModelOf, SessionModel } from './models'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { holdingInstanceOf } from './shared/holding-relations'
import { SCHEMA } from './shared/schema'
import { LOADING, type Loaded } from './worklist/rollup'

/** The same pooled issue object, with the page schema's stored-field types.
 * No snapshot or second record is constructed by the detail readers. */
export type PageIssue = ModelOf['issue'] & IssueViewModel

/** Only existing seats leave the list; their installed fields use the view's wire types. */
export type DetailSession = SessionModel & SessionView

/** These are data-layer query results of model identities. Display-only field
 * changes are read by the row observers and do not replace a roster. */
function createIssueDetailLists(issue: PageIssue, pool: MobxPool) {
  const childList = createQueryResult<PageIssue>({
    name: `IssueDetail@children:${issue.id}`,
    ids: () => pool.graph.many('issue', issue.id, 'treeChildren'),
    has: (id) => pool.queries.hasMember('issue', issue.id, 'treeChildren', id),
    order: (id) => {
      const row = omitGone(pool.row('issue', id)) as { seq?: number } | typeof LOADING | undefined
      return row === LOADING ? '' : String(row?.seq ?? 0).padStart(12, '0')
    },
    read: (id) => {
      const row = omitGone(pool.row('issue', id)) as
        | { deletedAt?: string }
        | typeof LOADING
        | undefined
      return row === LOADING
        ? LOADING
        : row && !row.deletedAt
          ? (pool.issueObject(id) as PageIssue)
          : undefined
    },
    subscribe: (changed) => pool.queries.onMembers('issue', issue.id, 'treeChildren', changed),
  })
  // The child relation's hold (POD-7582): the issue's own subtree, or a
  // wider tree already held, brings every sub-issue (POD-7579).
  const child = {
    get: (): Loaded<PageIssue[]> =>
      pool.collections.subtreeHeld(issue.id) ? childList.get() : LOADING,
    dispose: () => childList.dispose(),
  }
  const seats = (
    name: string,
    relation: 'pageSessions' | 'missionSessions' | 'bornSessions',
    archived: boolean | undefined,
    keep: (session: SessionModel) => boolean,
    order?: (session: SessionModel) => string,
    /** What the list waits for: the issue's sessions, or its tree (`seatsHeld`). */
    hold: 'sessions' | 'tree' = 'sessions',
  ) => {
    const list = createQueryResult<DetailSession>({
      name: `IssueDetail@${name}:${issue.id}`,
      ids: () =>
        archived === false && relation !== 'bornSessions'
          ? pool.graph.subset('issue', issue.id, relation, 'unarchived')
          : pool.graph.many('issue', issue.id, relation),
      has: (id) =>
        pool.queries.hasMember('issue', issue.id, relation, id) &&
        (archived !== false || pool.queries.sessionStoredField(id, 'archived') !== true),
      ...(order
        ? {
            order: (id: string) => {
              const session = pool.sessionObject(id)
              try {
                return archived !== undefined && session.archived !== archived ? id : order(session)
              } catch (error) {
                if (error === LOADING) return id
                throw error
              }
            },
          }
        : {}),
      read: (id) => {
        const session = pool.sessionObject(id)
        try {
          return (archived === undefined || session.archived === archived) &&
            session.exists &&
            !pool.queries.collapsed(id) &&
            keep(session)
            ? (session as DetailSession)
            : undefined
        } catch (error) {
          if (error === LOADING) return LOADING
          throw error
        }
      },
      subscribe: (changed) => {
        const stopMembers = pool.queries.onMembers('issue', issue.id, relation, changed)
        // A previously hidden archived seat is not subscribed by the query.
        // Feed deltas admit it when it joins the declared live subset.
        const stopRows =
          archived === false
            ? pool.queries.onChange((event) => {
                if (event.type === 'replace') return
                for (const row of event.rows)
                  if (
                    row.kind === 'session' &&
                    pool.queries.hasMember('issue', issue.id, relation, row.id)
                  )
                    changed(row.id)
              })
            : undefined
        return () => {
          stopMembers()
          stopRows?.()
        }
      },
    })
    return {
      get: (): Loaded<DetailSession[]> =>
        (hold === 'tree' ? seatsHeld(pool, issue.id) : sessionsHeld(pool, issue.id, relation))
          ? list.get()
          : LOADING,
      dispose: () => list.dispose(),
    }
  }
  const members = seats('members', 'pageSessions', undefined, () => true)
  const liveMembers = seats('live-members', 'pageSessions', false, () => true)
  const active = seats(
    'active',
    'pageSessions',
    false,
    (session) => session.open,
    (session) =>
      `${session.attention ? '0' : '1'}|${session.sessionId === issue.coordinatorSessionId ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  const retired = seats('retired', 'pageSessions', undefined, (session) => !session.open)
  // The dock includes explicitly attached shells; raw page membership excludes them.
  const dockActive = seats(
    'dock-active',
    'missionSessions',
    false,
    (session) => session.open,
    (session) =>
      `${session.attention ? '0' : '1'}|${session.sessionId === issue.coordinatorSessionId ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  // A sub-task row in the dock shows only what runs now: its open seats,
  // behind the tree its parent already holds, never its whole history.
  const dockOpen = seats(
    'dock-open',
    'missionSessions',
    false,
    (session) => session.open,
    (session) =>
      `${session.attention ? '0' : '1'}|${session.sessionId === issue.coordinatorSessionId ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
    'tree',
  )
  const dockRetired = seats(
    'dock-retired',
    'missionSessions',
    undefined,
    (session) => !session.open,
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const moved = seats(
    'moved',
    'bornSessions',
    false,
    (session) => Boolean(session.issueId && session.issueId !== issue.id),
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const phone = seats(
    'phone',
    'missionSessions',
    false,
    () => true,
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const inspector = seats(
    'inspector',
    'missionSessions',
    false,
    (session) => session.agentKind !== 'shell',
    (session) =>
      `${session.attention ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  return {
    children: child,
    members,
    liveMembers,
    active,
    retired,
    dockActive,
    dockOpen,
    dockRetired,
    moved,
    phone,
    inspector,
    dispose() {
      for (const list of [
        child,
        members,
        liveMembers,
        active,
        retired,
        dockActive,
        dockOpen,
        dockRetired,
        moved,
        phone,
        inspector,
      ])
        list.dispose()
    },
  }
}

/** The instance each session relation's holding read holds, from the declarations. */
const SESSION_HOLDS = {
  pageSessions: holdingInstanceOf(SCHEMA, 'issue', 'pageSessions'),
  missionSessions: holdingInstanceOf(SCHEMA, 'issue', 'missionSessions'),
  bornSessions: holdingInstanceOf(SCHEMA, 'issue', 'bornSessions'),
}

/**
 * The holding read of an issue's session relation (POD-7579): it holds the
 * relation's collection instance (`session.ofIssue`) for the issue while it
 * is observed and answers false until the device holds it complete, so a
 * roster never shows only the sessions that happen to be in memory (a closed
 * issue's live session without its history). One marker read, not a walk of
 * the members: the rosters below keep their own incremental membership.
 * `bornSessions` holds `session.bornOf` the same way (POD-7582).
 */
function sessionsHeld(
  pool: MobxPool,
  issueId: string,
  relation: keyof typeof SESSION_HOLDS,
): boolean {
  const instance = SESSION_HOLDS[relation]
  if (instance === undefined) return true
  // The server answered it without a marker: it will never say the history
  // is complete. Settle on what the device holds rather than asking again on
  // every read (POD-7579 review F7).
  if (pool.collections.refused(instance(issueId))) return true
  return pool.collections.held(instance(issueId))
}

/**
 * The open seats of an issue, without its archived history: the issue's tree
 * (held from its top-level issue, one instance for the whole chain) comes
 * with every session the flight deck shows (`DECK_SESSION_WHERE`: not
 * archived, not headless, not a shell), and `session.live` (a policy
 * collection) holds every starting or live one, shells included. A hibernated
 * shell is the one open seat neither brings.
 */
export function seatsHeld(pool: MobxPool, issueId: string): boolean {
  return pool.collections.treeHeld(issueId)
}

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
  @lazy get refreshing(): boolean {
    return (
      this.pool.collections.reading(this.issue, [
        { entity: 'issue', id: this.issue.id },
        ISSUE_STUBS,
        ...[
          'issueBrief',
          'issueDescription',
          'issuePanelState',
          'issuePanelTodo',
          'issuePanelArtifact',
          'issuePanelDeferred',
          'session',
          'issueDep',
          'issueGitState',
          'issueUserState',
        ].map((entity) => ({
          collection: `${entity}.ofIssue`,
          args: { issueId: this.issue.id },
          part: 'main' as const,
        })),
      ]) === 'refreshing'
    )
  }
  /** Page draft naming uses raw page members; worklist naming can use cwd seats. */
  @lazy get title(): string {
    const title = this.issue.authoredTitle
    if (!this.issue.isDraftVessel || (title.trim() && title.trim() !== 'Draft')) return title
    const members = this.lists.liveMembers.get()
    // Its members still on their way: the draft keeps its own title for now.
    if (members === LOADING) return title
    return issueDisplayTitle(
      {
        ...here(this.issue.row),
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
  /** Where this task's work went on (a spin-off tip, a superseding task),
   *  for the panel's one-line notice; null while an agent is still on it. */
  @lazy get continuation() {
    return missionView(this.pool).continuation(this.issue, false)
  }
  @lazy get hasTargets(): boolean {
    if (this.pool.collections.available) {
      const found = this.pool.collections.someIssue(
        (stub) =>
          stub.id !== this.issue.id &&
          stub.repoId === this.issue.repoId &&
          !stub.archived &&
          !stub.deletedAt &&
          !stub.isDraftVessel,
      )
      // An incomplete stub download must keep the link action available.
      return found === LOADING || found
    }
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
  get dockActiveSessions() {
    return this.lists.dockActive.get() ?? EMPTY_DETAIL_SESSIONS
  }
  /** Open seats only, behind the tree hold: a dock sub-task row and "show in deck". */
  get dockOpenSessions() {
    return this.lists.dockOpen.get() ?? EMPTY_DETAIL_SESSIONS
  }
  get dockRetiredSessions() {
    return this.lists.dockRetired.get() ?? EMPTY_DETAIL_SESSIONS
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
  /** The displayed roster collapses resume twins; raw action membership does not.
   *  Every agent session over history, through the holding read (POD-7579). */
  get rosterCount(): Loaded<number> {
    if (!sessionsHeld(this.pool, this.issue.id, 'missionSessions')) return LOADING
    return this.pool.graph.subsetSize('issue', this.issue.id, 'missionSessions', 'agents')
  }
  /** Every retired explicit session, shells included, behind the holding read. */
  get retiredCount(): Loaded<number> {
    if (!sessionsHeld(this.pool, this.issue.id, 'missionSessions')) return LOADING
    return this.pool.graph.subsetSize('issue', this.issue.id, 'missionSessions', 'retired')
  }
  dispose() {
    this.lists.dispose()
  }
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Presentation helpers preserve the existing vocabulary. Every fact fed to
 * them comes through this pool's one reader and its declared relationships. */
export function createIssuePageViews(pool: MobxPool) {
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
  let disposed = false
  function memo<T>(key: string, read: () => T, identity = false): T {
    if (disposed) return LOADING as T
    return (identity ? identities : cache)(key, read) as T
  }
  function session(id: string): Loaded<SessionView> {
    if (pool.graph.isCollapsed('session', id)) return undefined
    const row = omitGone(pool.row('session', id)) as Loaded<SessionView>
    return row && row !== LOADING ? { ...row } : row
  }
  function attachedSessions(id: string): Loaded<SessionView[]> {
    if (disposed || !sessionsHeld(pool, id, 'missionSessions')) return LOADING
    return roster(id, 'missionSessions').get()
  }
  function memberSessions(id: string): Loaded<SessionView[]> {
    if (disposed || !sessionsHeld(pool, id, 'pageSessions')) return LOADING
    return roster(id, 'pageSessions').get()
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
  function prefix(id: string, prefixes?: Map<string, string | undefined>): string | undefined {
    const repoId = pool.graph.one('issue', id, 'repo')
    if (!repoId) return undefined
    if (prefixes?.has(repoId)) return prefixes.get(repoId)
    const value = memo(`prefix:${repoId}`, () => {
      const repo = here(pool.model('repo', repoId))
      return repo?.prefix ?? undefined
    })
    prefixes?.set(repoId, value)
    return value
  }
  function readDependents(id: string): Loaded<IssueViewModel['dependents']> {
    const result: IssueViewModel['dependents'] = []
    let pending = false
    for (const sourceId of [...pool.graph.many('issue', id, 'pageDependents')].sort(byId)) {
      const source = omitGone(pool.row('issue', sourceId)) as Loaded<{
        deps?: { id: string; type: string }[]
      }>
      if (source === LOADING) pending = true
      else
        for (const dep of source?.deps ?? [])
          if (dep.id === id) result.push({ id: asIssueId(sourceId), type: dep.type })
    }
    return pending ? LOADING : result
  }
  function readSummary(
    id: string,
    prefixes?: Map<string, string | undefined>,
  ): Loaded<IssueViewModel> {
    // Menus need declared fields, not the worklist's computed presence bound.
    const row = omitGone(pool.row('issue', id))
    if (!row || row === LOADING) return row
    // Pick declared menu facts even for a resident row: a read cursor or
    // body update cannot invalidate the whole menu/edge lookup world.
    const value = row as unknown as Record<string, unknown>
    const fields = Object.fromEntries(ISSUE_PAGE_SUMMARIES.issue.map((key) => [key, value[key]]))
    const inverse = readDependents(id)
    if (inverse === LOADING) return LOADING
    const p = prefix(id, prefixes)
    // Readiness belongs to the shared issue, including the next-message sentinel.
    // Declared summary fields let a cold model answer without loading its payload.
    const issue = pool.issueObject(id)
    return {
      ...fields,
      id,
      prefix: p,
      displayRef: issueRefText(value.seq as number, p),
      labels: value.labels ?? [],
      deps: value.deps ?? [],
      dependents: inverse ?? [],
      memberSessionIds: [],
      childIds: [],
      childCount: 0,
      childDoneCount: 0,
      deferred: issue.deferred,
      ready: issue.ready,
    } as unknown as IssueViewModel
  }
  function summary(id: string): Loaded<IssueViewModel> {
    return memo(`summary:${id}`, () => readSummary(id))
  }
  // The web issue pickers' catalog (duplicate, relation and parent targets):
  // the issues the device holds. POD-7089 moves the pickers to device first,
  // then server search (POD-7088, design "Search and references").
  const summaryIssues = createQueryResult<IssueViewModel>({
    name: 'IssuePage@summaries',
    ids: () => pool.queries.ids({ kind: 'pageIssues' }),
    has: (id) => pool.queries.has({ kind: 'pageIssues' }, id),
    read: readSummary,
    subscribe: (changed) => pool.queries.onQuestionMembers({ kind: 'pageIssues' }, changed),
  })
  function issues(): Loaded<IssueViewModel[]> {
    if (disposed) return LOADING
    return pool.queries.project(
      { kind: 'pageIssues' },
      'IssuePage@summaries',
      readSummary,
      {},
      summaryIssues,
    )
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
  /**
   * The page's issue. The page also reads the bodies it draws, through the
   * model's fields: while the row is on its way their loads join its batch
   * window instead of waiting a hop for it, and once it is here the page keeps
   * holding them, with no release and retake when the sections mount (POD-7545).
   */
  function issue(id: string, bodies: readonly PageBody[] = PAGE_BODIES): Loaded<PageIssue> {
    if (disposed) return LOADING
    const found = readPageIssue(pool, id)
    if (found !== undefined) readBodies(pool, id, bodies)
    return found
  }
  /** Resolve identity before any detail section subscribes to its own fields. */
  function panelIssue(args: {
    issueId?: string
    sessionId?: string
    cwd: string
  }): Loaded<PageIssue> {
    if (disposed) return LOADING
    if (args.issueId) {
      const explicit = issue(args.issueId, PANEL_BODIES)
      if (explicit === LOADING || (explicit && !explicit.deletedAt)) return explicit
    }
    if (args.sessionId) {
      const seat = pool.sessionObject(args.sessionId)
      try {
        if (seat.exists) {
          if (!seat.issueId) return undefined
          const attached = issue(seat.issueId, PANEL_BODIES)
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
    return id ? issue(id, PANEL_BODIES) : undefined
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
    // Only an empty draft is no destination: a root that would not be one
    // even with no sessions is a destination without waiting for them.
    if (!isEmptyDraftVessel(root, [])) return root
    const members = row(rootId).activeSessions
    return members === LOADING
      ? LOADING
      : isEmptyDraftVessel(root, members ?? [])
        ? undefined
        : root
  }
  return {
    issue,
    summary,
    issues,
    row,
    pool,
    panelIssue,
    destination,
    memberSessions,
    attachedSessions,
    closeFacts: (id: string) => memo(`close:${id}`, () => readIssueCloseFacts(pool, id)),
    dispose() {
      disposed = true
      cache.clear()
      identities.clear()
      clearCompanions(companions)
      summaryIssues.dispose()
      for (const lists of detailLists) lists.dispose()
      detailLists.clear()
      for (const roster of rosters.values()) roster.dispose()
      rosters.clear()
    },
  }
}

export type IssuePageViews = ReturnType<typeof createIssuePageViews>
export function issuePages(pool: MobxPool): IssuePageViews {
  return createIssuePageViews(pool)
}

export function readIssueCloseFacts(
  pool: MobxPool,
  id: string,
): Loaded<{ subject: IssueCloseScalarSubject; members: IssueCloseMemberCounts }> {
  const known = omitGone(pool.row('issue', id))
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

/** Shared identity lookup for controls that have no detail-view rules. */
/** The body fields a screen draws: the issue page both, the right-dock panel the description. */
type PageBody = 'description' | 'brief'
const PAGE_BODIES: readonly PageBody[] = ['description', 'brief']
const PANEL_BODIES: readonly PageBody[] = ['description']

/** Read body fields of an issue whose row is on its way: each read holds and loads its record. */
function readBodies(pool: MobxPool, id: string, bodies: readonly PageBody[]): void {
  const model = pool.issueObject(id)
  for (const body of bodies) {
    try {
      void model[body]
    } catch (error) {
      if (error !== LOADING) throw error
    }
  }
}

export function readPageIssue(pool: MobxPool, id: string): Loaded<PageIssue> {
  const raw = omitGone(pool.row('issue', id))
  return !raw || raw === LOADING ? raw : (pool.issueObject(id) as PageIssue)
}
