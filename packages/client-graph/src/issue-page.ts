import { keyedComputed } from '@podium/mobx-helpers'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  groupRelations,
  type IssueCloseMemberCounts,
  type IssueCloseScalarSubject,
  type IssueCloseSubject,
  isEmptyDraftVessel,
  issueDisplayTitle,
  type MissionSessionIndex,
  presenceNote,
  type ReferentExit,
  sessionPresentOnTask,
} from '@podium/client-core/values'
import { asIssueId, asSessionId } from '@podium/model/browser'
import {
  compareStructural,
  observe,
} from 'mobx'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { missions } from './mission'
import { missionView } from './mission-view'
import type { MobxPool } from './pool'
import { createQueryResult, joinQueryResults } from './query-result'
import { isFinished } from './shared/predicates'
import { LOADING, type Loaded } from './worklist/rollup'

export interface IssuePageData {
  issue: IssueViewModel
  /** Addressed display references. Full menu choices are read only on open. */
  issues: IssueViewModel[]
  hasTargets?: boolean
  children: IssueViewModel[]
  memberSessions: SessionView[]
  /** Only the addressed page neighbourhood; no legacy session-world read. */
  sessions: SessionView[]
  relations: ReturnType<typeof groupRelations>
  title: string
  presence: ReturnType<typeof presenceNote>
  exits: Readonly<Record<string, ReferentExit | undefined>>
}

type DocumentValue = string | { value: string } | undefined
const text = (value: DocumentValue): string =>
  typeof value === 'string' ? value : (value?.value ?? '')
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Presentation helpers preserve the existing vocabulary. Every fact fed to
 * them comes through this pool's one reader and its declared relationships. */
function createIssuePageViews(pool: MobxPool) {
  // TODO(POD-5575): fresh pane summaries still need explicit structural equality.
  const cache = keyedComputed((key: string) => `IssuePage@${key}`, (_key: string, read: () => unknown) => read(), { equals: compareStructural })
  const identities = keyedComputed((key: string) => `IssuePage@${key}`, (_key: string, read: () => unknown) => read())
  const rosters = new Map<string, ReturnType<typeof createQueryResult<SessionView>>>()
  const explorerQuestion = { kind: 'explorerSessions' } as const
  const explorerSeats = createQueryResult<SessionView>({
    name: 'IssuePage@explorerSessions',
    ids: () => pool.queries.ids(explorerQuestion),
    has: id => pool.queries.has(explorerQuestion, id),
    order: id => pool.queries.orderKey(id),
    read: id => {
      if (pool.queries.collapsed(id)) return undefined
      const seat = pool.row('session', id, 'summary') as Loaded<SessionView>
      return seat && seat !== LOADING ? { ...seat } : seat
    },
    subscribe: changed => {
      const stopTable = observe(pool.tables.session, change => changed(change.name))
      const stopFeed = pool.queries.onChange(event => {
        if (event.type === 'replace') changed(undefined)
        else for (const row of event.rows) if (row.kind === 'session') changed(row.id)
      })
      return () => { stopTable(); stopFeed() }
    },
  })
  const stats = { issues: 0, pages: 0, panels: 0 }
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
    return memo(`close:${id}`, () => {
      const raw = pool.row('issue', id, 'summary-fields') as Loaded<
        Readonly<Record<string, unknown>>
      >
      if (!raw || raw === LOADING) return raw
      const git = raw.gitState as IssueCloseSubject['gitState']
      const question = (raw.asked as IssueCloseSubject['asked'])?.question
      return {
        subject: {
          needsHuman: !!raw.needsHuman,
          asked: question === undefined ? undefined : { question },
          git: git
            ? {
                dirty: git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0),
                delivery: git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0),
                shared: !!git.shared,
                merged: git.merged,
              }
            : undefined,
          parentBranch: String(raw.parentBranch ?? 'main'),
          ...pool.queries.issueChildCounts(id),
        },
        members: pool.queries.issueCloseCounts(id),
      }
    })
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
  function relatedSessions(
    id: string,
    neighbours: ReadonlySet<string>,
  ): SessionView[] | typeof LOADING {
    const owners = [...neighbours].sort(byId)
    return memo(
      `sessions:${id}:${JSON.stringify(owners)}`,
      () => {
        const groups = [
          roster(id, 'bornSessions', owners).get(),
          ...owners.map((owner) => attachedSessions(owner)),
        ]
        if (groups.some((group) => group === LOADING)) return LOADING
        return joinQueryResults(groups as SessionView[][])
      },
      true,
    )
  }
  function pagePresence(
    id: string,
    neighbours: ReadonlySet<string>,
  ): IssuePageData['presence'] | typeof LOADING {
    const owners = [...neighbours].sort(byId)
    return memo(`presence:${id}:${JSON.stringify(owners)}`, () => {
      const value = summary(id)
      if (!value || value === LOADING) return LOADING
      const reader = missionView(pool)
      const own = reader.present(id),
        history = reader.history(id)
      if (own === LOADING || history === LOADING) return LOADING
      const byId = new Map<string, IssueViewModel>()
      const index: MissionSessionIndex = {
        byIssue: new Map(),
        openIssues: new Set(),
        lastActive: new Map(),
      }
      for (const owner of owners) {
        const target = summary(owner),
          present = reader.present(owner),
          all = attachedSessions(owner)
        if (target === LOADING || present === LOADING || all === LOADING) return LOADING
        if (target) byId.set(owner, target)
        index.byIssue.set(owner, all ?? [])
        if (present.some(sessionPresentOnTask)) index.openIssues.add(owner)
        for (const seat of present) {
          const last = index.lastActive.get(owner)
          if (last === undefined || seat.lastActiveAt > last)
            index.lastActive.set(owner, seat.lastActiveAt)
        }
      }
      // The same first open/moved sender, with archived winners maintained by
      // the existing mission reader. Continuations use neighbourhood witnesses.
      const open = own.find(sessionPresentOnTask)
      try {
        const witness = open ?? reader.moved(id)
        return presenceNote(value, witness ? [witness] : [], byId, [], index)
      } catch (error) {
        if (error === LOADING) return LOADING
        throw error
      }
    })
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
  function hasTargets(id: string, repoPath: string): boolean {
    return memo(
      `targets:${id}:${repoPath}`,
      () =>
        pool.queries.ids({
          kind: 'mobileIssueTargets',
          repoPath,
          excludeId: id,
          query: '',
          limit: 1,
          prefixes: {},
        }).length > 0,
    )
  }
  function issue(id: string): Loaded<IssueViewModel> {
    return memo(`issue:${id}`, () => {
      stats.issues++
      const row = pool.row('issue', id)
      if (!row) return row
      const members = memberSessions(id)
      const facts = memo(`members:${id}`, () => missionView(pool).issueMembers(id))
      let pending = members === LOADING || facts === LOADING
      const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
      let childDoneCount = 0
      for (const childId of childIds) {
        const child = pool.row('issue', childId, 'summary') as Loaded<{
          stage?: string
          closedReason?: string | null
        }>
        if (child === LOADING) pending = true
        else if (child && isFinished(child)) childDoneCount++
      }
      const inverse = dependents(id)
      // Read every known requirement before returning LOADING so this issue's
      // payload, members and summaries share the existing load window.
      if (pending || row === LOADING || inverse === LOADING || facts === LOADING) return LOADING
      const value = row as IssueViewModel
      const p = prefix(id)
      const isDeferred = deferred(value.deferUntil)
      // Ingest absorbs cursor-only deltas into this existing scalar lane so
      // a mark does not replace the payload or wake every world projection.
      const cursor = pool.readCursor(id) ?? null
      const readAt = Date.parse(cursor ?? '')
      const unread =
        !Number.isFinite(readAt) || Date.parse(value.updatedAt) > readAt || facts.latest > readAt
      return {
        ...value,
        id: asIssueId(id),
        description: text(value.description as DocumentValue),
        notes: value.notes === undefined ? undefined : text(value.notes as DocumentValue),
        branch: value.branch ?? null,
        worktreePath: value.worktreePath ?? null,
        readAt: cursor,
        tuckedAt: value.tuckedAt ?? null,
        pinned: value.pinned ?? false,
        prefix: p,
        displayRef: p ? `${p}-${value.seq}` : `#${value.seq}`,
        deps: (value.deps ?? []).map((dep) => ({ ...dep, id: asIssueId(dep.id) })),
        dependents: inverse ?? [],
        memberSessionIds: facts.ids,
        childIds: childIds.map(asIssueId),
        childCount: childIds.length,
        childDoneCount,
        blocked: value.blocked ?? false,
        deferred: isDeferred,
        ready: !value.blocked && !isDeferred && !isFinished(value),
        unread: !value.deletedAt && unread,
        sessionSummary: facts.summary,
      }
    })
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
  function data(id: string): Loaded<IssuePageData> {
    return memo(
      `page:${id}`,
      () => {
        stats.pages++
        const value = issue(id)
        if (!value) return value
        let pending = value === LOADING
        const children: IssueViewModel[] = []
        const neighbours = new Set(
          [
            id,
            pool.graph.one('issue', id, 'treeParent'),
            pool.graph.one('issue', id, 'supersedingIssue'),
            pool.graph.one('issue', id, 'canonicalIssue'),
          ].filter((key): key is string => Boolean(key)),
        )
        for (const childId of pool.graph.many('issue', id, 'treeChildren')) {
          const child = issue(childId)
          if (child === LOADING) {
            pending = true
            neighbours.add(childId)
          } else if (child && !child.deletedAt) {
            children.push(child)
            neighbours.add(child.id)
          }
        }
        children.sort((a, b) => a.seq - b.seq)
        for (const target of pool.graph.many('issue', id, 'pageDependencies'))
          neighbours.add(target)
        for (const source of pool.graph.many('issue', id, 'pageDependents')) neighbours.add(source)
        // A continuation can hop through several closed spin-offs before a
        // staffed, unstarted tip. Read those session owners through the already
        // declared origin relation, without loading an unrelated session world.
        const seenOrigins = new Set([id]),
          origins = [id]
        while (origins.length) {
          const origin = origins.pop()!
          for (const next of pool.graph.many('issue', origin, 'spinOffs')) {
            if (seenOrigins.has(next)) continue
            seenOrigins.add(next)
            const branch = summary(next)
            if (branch === LOADING) {
              pending = true
              continue
            }
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
        if (
          pending ||
          value === LOADING ||
          members === LOADING ||
          own === LOADING ||
          sessions === LOADING
        )
          return LOADING
        // Only displayed references belong to the page's subscription. Catalog
        // choices must not hydrate or compare every unrelated issue on opening.
        const references = new Set(neighbours)
        for (const seat of sessions) {
          if (seat.issueId) references.add(seat.issueId)
          if (seat.refIssueId) references.add(seat.refIssueId)
        }
        const neighbourhood: IssueViewModel[] = []
        const exits: Record<string, ReferentExit | undefined> = {}
        for (const neighbour of references) {
          const target = summary(neighbour)
          if (target === LOADING) return LOADING
          if (target) {
            neighbourhood.push(target)
            // Placement and breadcrumb references can span several ancestors.
            if (target.parentId) references.add(target.parentId)
          } else {
            const exit = pool.row('issueExit', neighbour)
            if (exit === LOADING) return LOADING
            exits[neighbour] = exit?.kind
          }
        }
        const presence = pagePresence(id, neighbours)
        if (presence === LOADING) return LOADING
        return {
          issue: value,
          issues: neighbourhood,
          hasTargets: hasTargets(id, value.repoPath),
          children,
          memberSessions: members ?? [],
          sessions,
          relations: groupRelations(value),
          // issue() declares memberSessionIds, including the empty answer.
          // Draft naming therefore uses that relation, never cwd discovery.
          title: issueDisplayTitle(value, sessions, []),
          presence,
          exits,
        }
      },
      true,
    )
  }
  function panel(args: {
    issueId?: string
    sessionId?: string
    cwd: string
  }): Loaded<IssuePageData> {
    return memo(
      `panel:${JSON.stringify(args)}`,
      () => {
        stats.panels++
        if (args.issueId) {
          const explicit = data(args.issueId)
          if (explicit === LOADING || (explicit && !explicit.issue.deletedAt)) return explicit
        }
        if (args.sessionId) {
          const seat = session(args.sessionId)
          if (seat === LOADING) return LOADING
          if (seat) {
            if (!seat.issueId) return undefined
            const attached = data(seat.issueId)
            return attached === LOADING ||
              (attached && !attached.issue.archived && !attached.issue.deletedAt)
              ? attached
              : undefined
          }
        }
        // File tabs / unknown sessions demand the maintained winning identity,
        // then that page alone, including when many old issues share its path.
        const id = pool.queries.containingIssueId(args.cwd)
        return id ? data(id) : undefined
      },
      true,
    )
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
    return members === LOADING
      ? LOADING
      : isEmptyDraftVessel(root, members ?? [])
        ? undefined
        : root
  }
  function explorer(): Loaded<{ issues: IssueViewModel[]; sessions: SessionView[] }> {
    return memo('explorer', () => {
      // This retained catalog is explicit full-list demand. Maintain each
      // answer by address; updates never reconstruct or compare its world.
      const world = pool.queries.project({ kind: 'pageIssues' }, 'IssuePage@explorerIssues', id => {
        const value = summary(id)
        if (!value || value === LOADING) return value
        const children = memo(`explorerChildren:${id}`, () => {
          const childIds = [...pool.graph.many('issue', id, 'treeChildren')].sort(byId)
          let childDoneCount = 0
          for (const childId of childIds) {
            const child = pool.row('issue', childId, 'summary') as Loaded<{
              stage?: string; closedReason?: string | null
            }>
            if (child && child !== LOADING && isFinished(child)) childDoneCount++
          }
          return { childIds: childIds.map(asIssueId), childCount: childIds.length, childDoneCount }
        }, true)
        const memberSessionIds = memo(`explorerMembers:${id}`, () =>
          [...pool.graph.many('issue', id, 'pageSessions')].sort(byId).map(asSessionId), true)
        return { ...value, ...children, memberSessionIds }
      })
      if (!world || world === LOADING) return world
      const seats = explorerSeats.get()
      return seats === LOADING ? LOADING : { issues: world, sessions: seats ?? [] }
    }, true)
  }
  return {
    issue,
    summary,
    issues,
    menuIssues,
    data,
    panel,
    destination,
    explorer,
    memberSessions,
    attachedSessions,
    closeFacts,
    stats,
    dispose() {
      disposed = true
      cache.clear()
      identities.clear()
      explorerSeats.dispose()
      for (const roster of rosters.values()) roster.dispose()
      rosters.clear()
    },
  }
}

export type IssuePageViews = ReturnType<typeof createIssuePageViews>
export function issuePages(pool: MobxPool): IssuePageViews {
  return pool.sources.view('issue-page', () => createIssuePageViews(pool))
}
