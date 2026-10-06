import { isFinished } from '@podium/client-graph/shared/predicates'
/** Independent, stateless fixture oracle for pool parity. */
import {
  asIssueId,
  type IssueId,
  type IssueProjection,
  type IssueUserStateWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import type { Replica } from '@podium/client-core/replica'

export interface IssueView {
  id: string

  memberSessionIds: SessionId[]

  displayRef: string

  childIds: IssueId[]
  childCount: number
  childDoneCount: number

  blocked: boolean

  ready: boolean

  deferred: boolean

  dependents: Array<{ id: IssueId; type: string }>
}

export interface IssueSessionRollups {
  unread: boolean
  sessionSummary: { total: number; byPhase: Record<string, number> }
}

export interface IssueViewInput {
  id: string
  seq: number
  parentId?: string | null
  prefix?: string | null
  stage: string
  closedReason?: string | null
  status?: string
  deferUntil?: string | null
  readAt?: string | null
  updatedAt: string
  deletedAt?: string | null
  deps?: Array<{ id: string; type: string }>
}

export interface SessionViewInput {
  sessionId: SessionId
  issueId?: IssueId | null
  agentKind?: string | null
  phase?: string | null
  lastActiveAt?: string | null
}

export function sessionRollupPhase(
  row: { agentState?: { phase?: string | null } | undefined; phase?: string | null } | undefined,
): string | null {
  if (!row) return null
  return row.agentState?.phase ?? row.phase ?? null
}

function toSessionViewInput(row: SessionMeta): SessionViewInput {
  // Explicit object rather than a spread so the return is CHECKED against
  // `SessionViewInput` field by field — the same posture as
  // `projectionToViewInput` below. If a field the views read leaves
  // `SessionMeta`, this stops compiling HERE, at the join.
  const next: SessionViewInput = {
    sessionId: row.sessionId,
    issueId: row.issueId,
    agentKind: row.agentKind,
    phase: sessionRollupPhase(row),
    lastActiveAt: row.lastActiveAt,
  }
  return next
}

export function indexSessionsByIssue(
  sessions: readonly SessionViewInput[],
): Map<IssueId, SessionId[]> {
  const index = new Map<IssueId, SessionId[]>()
  for (const session of sessions) {
    // Shells are terminal plumbing, not issue workers. In particular, the
    // right dock stamps its persistent shell with the active issue id, but the
    // workspace deliberately refuses to open that dock-owned session as a tab.
    // Keeping it out at the membership boundary makes every issue roster,
    // count and rollup share the same policy instead of handing navigation an
    // id whose only home is the dock.
    if (session.agentKind === 'shell') continue
    const issueId = session.issueId
    if (issueId === undefined || issueId === null || issueId === '') continue
    const ids = index.get(issueId)
    if (ids) ids.push(session.sessionId)
    else index.set(issueId, [session.sessionId])
  }
  return index
}

export function issueDisplayRef(issue: Pick<IssueViewInput, 'seq' | 'prefix'>): string {
  return issue.prefix ? `${issue.prefix}-${issue.seq}` : `#${issue.seq}`
}

function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameDependents(
  a: readonly { id: IssueId; type: string }[],
  b: readonly { id: IssueId; type: string }[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined || right === undefined) return false
    if (left.id !== right.id || left.type !== right.type) return false
  }
  return true
}

function sameIssueView(a: IssueView, b: IssueView): boolean {
  return (
    a.id === b.id &&
    a.displayRef === b.displayRef &&
    a.childCount === b.childCount &&
    a.childDoneCount === b.childDoneCount &&
    a.blocked === b.blocked &&
    a.ready === b.ready &&
    a.deferred === b.deferred &&
    sameIdList(a.memberSessionIds, b.memberSessionIds) &&
    sameIdList(a.childIds, b.childIds) &&
    sameDependents(a.dependents, b.dependents)
  )
}

export function deriveIssueViews(
  issues: readonly IssueViewInput[],
  sessions: readonly SessionViewInput[],
  opts: {
    now?: () => number
    previous?: ReadonlyMap<string, IssueView>

    dependencyStage?: (id: string) => string | undefined
  } = {},
): Map<string, IssueView> {
  const now = opts.now ?? Date.now
  const sessionsByIssue = indexSessionsByIssue(sessions)
  const finishedById = new Map(issues.map((i) => [i.id, isFinished(i)]))
  const childrenByParent = new Map<IssueId, IssueId[]>()
  // Reverse of every issue's `deps`: an edge A→B (A's dep on B) contributes B a
  // dependent { id: A, type }. Built once here in O(deps) so `dependents` is a
  // local derivation, never a wire field — the same reason `blocked` is (both
  // read OTHER issues' edges, so folding either onto B's row would make an edge
  // touching A rewrite B).
  const dependentsByIssue = new Map<IssueId, { id: IssueId; type: string }[]>()
  for (const issue of issues) {
    const issueId = asIssueId(issue.id)
    const parentId = issue.parentId ? asIssueId(issue.parentId) : undefined
    if (parentId) {
      const kids = childrenByParent.get(parentId)
      if (kids) kids.push(issueId)
      else childrenByParent.set(parentId, [issueId])
    }
    for (const dep of issue.deps ?? []) {
      const dependent = { id: issueId, type: dep.type }
      const list = dependentsByIssue.get(asIssueId(dep.id))
      if (list) list.push(dependent)
      else dependentsByIssue.set(asIssueId(dep.id), [dependent])
    }
  }

  const views = new Map<string, IssueView>()
  for (const issue of issues) {
    const issueId = asIssueId(issue.id)
    const childIds = childrenByParent.get(issueId) ?? []
    const childDoneCount = childIds.filter((id) => finishedById.get(id) === true).length
    // `blocked`: something this issue depends on is not done yet. An unknown
    // dep id counts as NOT blocking — the alternative is that a replica which
    // has not yet seen a dependency renders every issue blocked, which is worse
    // than briefly rendering one ready.
    const blocked = (issue.deps ?? []).some((dep) => {
      const stage = opts.dependencyStage?.(dep.id)
      const finished = opts.dependencyStage
        ? stage === undefined ? undefined : isFinished({ stage })
        : finishedById.get(dep.id)
      return dep.type === 'blocks' && finished === false
    })
    const deferred = issue.deferUntil != null && Date.parse(issue.deferUntil) > now()
    const next: IssueView = {
      id: issueId,
      memberSessionIds: sessionsByIssue.get(issueId) ?? [],
      displayRef: issueDisplayRef(issue),
      childIds,
      childCount: childIds.length,
      childDoneCount,
      blocked,
      deferred,
      ready: !blocked && !deferred && !isFinished(issue),
      dependents: dependentsByIssue.get(issueId) ?? [],
    }
    const previous = opts.previous?.get(issue.id)
    views.set(issue.id, previous !== undefined && sameIssueView(previous, next) ? previous : next)
  }
  return views
}

export function deriveIssueRollups(
  issue: Pick<IssueViewInput, 'readAt' | 'updatedAt' | 'deletedAt'>,
  memberSessionIds: readonly SessionId[],
  sessionById: (id: SessionId) => SessionViewInput | undefined,
): IssueSessionRollups {
  const byPhase: Record<string, number> = {}
  let total = 0
  // Match the server's authoritative email-style rule: the issue's own row is
  // activity too, so a never-read issue is unread even before it has sessions.
  const readAt = issue.readAt ? Date.parse(issue.readAt) : null
  let unread = readAt === null || !Number.isFinite(readAt)
  if (!unread && readAt !== null) {
    const updatedAt = Date.parse(issue.updatedAt)
    unread = Number.isFinite(updatedAt) && updatedAt > readAt
  }
  for (const id of memberSessionIds) {
    const session = sessionById(id)
    // A member id with no session is normal, not an error: the session may be
    // mid-arrival. Counting it would report a total the user cannot see.
    if (!session) continue
    total++
    const phase = session.phase ?? 'unknown'
    byPhase[phase] = (byPhase[phase] ?? 0) + 1
    if (!unread && session.lastActiveAt) {
      const activeAt = Date.parse(session.lastActiveAt)
      if (Number.isFinite(activeAt) && (readAt === null || activeAt > readAt)) unread = true
    }
  }
  return { unread: issue.deletedAt ? false : unread, sessionSummary: { total, byPhase } }
}

export interface IssueTreeNode {
  view: IssueView
  children: IssueTreeNode[]
}

export function buildIssueTree(
  views: Map<string, IssueView>,
  issues: readonly IssueViewInput[],
): IssueTreeNode[] {
  const parentById = new Map(issues.map((i) => [i.id, i.parentId ?? null]))
  const nodeById = new Map<string, IssueTreeNode>()
  for (const [id, view] of views) nodeById.set(id, { view, children: [] })

  const roots: IssueTreeNode[] = []
  for (const [id, node] of nodeById) {
    const parentId = parentById.get(id) ?? null
    const parent = parentId === null ? undefined : nodeById.get(parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function buildIssueBoard(
  views: Map<string, IssueView>,
  issues: readonly IssueViewInput[],
  stages: readonly string[],
): Map<string, IssueView[]> {
  const board = new Map<string, IssueView[]>(stages.map((s) => [s, []]))
  for (const issue of issues) {
    const view = views.get(issue.id)
    if (!view) continue
    const column = board.get(issue.stage)
    if (column) column.push(view)
  }
  return board
}

export function readViewInputs(
  replica: Replica,
  projections: readonly IssueProjection[] = replica.rows('issueProjections'),
  userStates: readonly IssueUserStateWire[] = replica.rows('issueUserStates'),
): {
  issues: IssueViewInput[]
  sessions: SessionViewInput[]
} {
  const readAtByIssueId = new Map(userStates.map((state) => [state.entityId, state.readAt]))
  const prefixByRepoId = new Map<string, string | null>()
  for (const repo of replica.rows('repos')) prefixByRepoId.set(repo.id, repo.prefix ?? null)
  const depsByFrom = new Map<string, { id: string; type: string }[]>()
  for (const dep of replica.rows('issueDeps')) {
    const list = depsByFrom.get(dep.fromId)
    const edge = { id: dep.toId, type: dep.type }
    if (list) list.push(edge)
    else depsByFrom.set(dep.fromId, [edge])
  }
  return {
    issues: projections.map((p) =>
      projectionToViewInput(p, readAtByIssueId.get(p.id) ?? null, prefixByRepoId, depsByFrom),
    ),
    sessions: replica.rows('sessions').map(toSessionViewInput),
  }
}

function projectionToViewInput(
  p: IssueProjection,
  readAt: string | null,
  prefixByRepoId: Map<string, string | null>,
  depsByFrom: Map<string, { id: string; type: string }[]>,
): IssueViewInput {
  return {
    id: p.id,
    seq: p.seq,
    parentId: p.parentId ?? null,
    prefix: p.repoId ? (prefixByRepoId.get(p.repoId) ?? null) : null,
    stage: p.stage,
    closedReason: p.closedReason,
    deferUntil: p.deferUntil ?? null,
    readAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt ?? null,
    deps: depsByFrom.get(p.id) ?? [],
  }
}

export type SessionMetaSatisfiesViewInput = SessionMeta extends SessionViewInput ? true : never
const _sessionMetaSatisfies: SessionMetaSatisfiesViewInput = true
