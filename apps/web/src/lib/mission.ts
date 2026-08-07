import {
  isCoordinatorSession,
  motionPhase,
  type IssueNavigationModel,
  sessionsForIssueNav,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'

export type FlightDeckMode = 'full' | 'active' | 'needs-you'

export interface FlightDeckRow {
  issue: IssueNavigationModel
  depth: number
  sessions: SessionMeta[]
  descendantIds: string[]
  actionableCount: number
  liveAgentCount: number
}

export interface MissionProgress {
  done: number
  total: number
  percent: number
}

const openSession = (session: SessionMeta): boolean =>
  !session.archived && session.status !== 'exited'

export function sessionNeedsHuman(session: SessionMeta): boolean {
  return (
    session.agentState?.phase === 'needs_user' ||
    (session.agentState?.phase === 'errored' && session.agentState.error?.retryable === true) ||
    Boolean(session.offer)
  )
}

export function issueNeedsHuman(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
): boolean {
  return (
    issue.needsHuman === true ||
    issue.stage === 'review' ||
    sessions.some((session) => !session.archived && sessionNeedsHuman(session))
  )
}

export function missionRootFor(
  issues: readonly IssueNavigationModel[],
  selectedIssueId: string | null,
): IssueNavigationModel | undefined {
  if (!selectedIssueId) return undefined
  const byId = new Map<string, IssueNavigationModel>(issues.map((issue) => [issue.id, issue]))
  let current = byId.get(selectedIssueId)
  if (!current) return undefined
  const seen = new Set<string>()
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentId)
    if (!parent || parent.archived || parent.deletedAt) break
    current = parent
  }
  return current
}

export function missionIssueIds(
  issues: readonly IssueNavigationModel[],
  rootId: string,
  sessions: readonly SessionMeta[] = [],
): Set<string> {
  const children = new Map<string, IssueNavigationModel[]>()
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || !issue.parentId) continue
    const siblings = children.get(issue.parentId) ?? []
    siblings.push(issue)
    children.set(issue.parentId, siblings)
  }
  const ids = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (ids.has(id)) continue
    ids.add(id)
    for (const child of children.get(id) ?? []) stack.push(child.id)
  }
  // Agent-started children belong to the mission when their starting session
  // is already in the mission; discovered-from relations remain separate.
  let changed = true
  while (changed) {
    changed = false
    const missionSessions = new Set(
      sessions
        .filter((session) => ids.has(session.issueId ?? ''))
        .map((session) => session.sessionId),
    )
    for (const issue of issues) {
      if (!ids.has(issue.id) && issue.startedBySession && missionSessions.has(issue.startedBySession)) {
        ids.add(issue.id)
        changed = true
      }
    }
  }
  return ids
}

export function missionSessions(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string,
  includeArchived = false,
): SessionMeta[] {
  const ids = missionIssueIds(issues, rootId, sessions)
  const memberIds = new Set<string>()
  for (const issue of issues) {
    if (!ids.has(issue.id)) continue
    for (const sessionId of issue.memberSessionIds ?? []) memberIds.add(sessionId)
  }
  return sessions.filter(
    (session) =>
      (includeArchived || !session.archived) &&
      (memberIds.has(session.sessionId) || Boolean(session.issueId && ids.has(session.issueId))),
  )
}

/** `sessionsForIssueNav` takes mutable arrays; the callers here hold readonly
 *  store slices, so the copy happens once per build rather than per issue. */
function sessionsForIssue(
  issue: IssueNavigationModel,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): SessionMeta[] {
  return sessionsForIssueNav(issue, sessions, allWorktreePaths, { includeShells: true })
}

export function missionProgress(rows: readonly FlightDeckRow[]): MissionProgress {
  const total = Math.max(0, rows.length - 1)
  const done = rows
    .slice(1)
    .filter((row) => row.issue.stage === 'done' || Boolean(row.issue.closedReason)).length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * Stable, issue-first mission projection. Sessions remain references resolved
 * from the client session slice; no aggregate or session object is stored on an
 * issue. Filters preserve ancestor paths so an exception never loses context.
 */
export function buildFlightDeckRows(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string,
  mode: FlightDeckMode = 'full',
  allWorktreePaths: readonly string[] = [],
): FlightDeckRow[] {
  const visibleIssues = issues.filter((issue) => !issue.archived && !issue.deletedAt)
  const byId = new Map<string, IssueNavigationModel>(visibleIssues.map((issue) => [issue.id, issue]))
  if (!byId.has(rootId)) return []
  const children = new Map<string, IssueNavigationModel[]>()
  for (const issue of visibleIssues) {
    if (!issue.parentId) continue
    const siblings = children.get(issue.parentId) ?? []
    siblings.push(issue)
    children.set(issue.parentId, siblings)
  }
  // Graft agent-started work onto the issue whose session started it — not onto
  // the root. `missionIssueIds` follows that provenance recursively, so a
  // second-generation spawn is in the mission; grafting only root-started,
  // parentless issues would put it in the set but give it no row to render in.
  const missionIds = missionIssueIds(issues, rootId, sessions)
  const issueOwningSession = new Map<string, string>()
  for (const session of sessions) {
    if (session.issueId) issueOwningSession.set(session.sessionId, session.issueId)
  }
  for (const id of missionIds) {
    const issue = byId.get(id)
    if (!issue || id === rootId) continue
    // Already reachable by a formal parent edge inside the mission? Leave it.
    if (issue.parentId && missionIds.has(issue.parentId)) continue
    const startedBy = issue.startedBySession
    const owner = startedBy ? issueOwningSession.get(startedBy) : undefined
    const parentId = owner && missionIds.has(owner) && owner !== id ? owner : rootId
    const siblings = children.get(parentId) ?? []
    if (!siblings.some((candidate) => candidate.id === issue.id)) siblings.push(issue)
    children.set(parentId, siblings)
  }
  // Sorted AFTER grafting: `missionIds` is a Set whose iteration order is the
  // provenance walk, so sorting first would leave grafted siblings in whatever
  // order that walk happened to reach them.
  for (const siblings of children.values()) {
    siblings.sort((a, b) => {
      const aKey = a.sortKey ?? ''
      const bKey = b.sortKey ?? ''
      return aKey && bKey && aKey !== bKey ? aKey.localeCompare(bKey) : a.seq - b.seq
    })
  }

  // Memoizing under a parentId cycle would cache an issue as its OWN
  // descendant, which then double-counts its sessions in the roll-ups. Seeding
  // `seen` with the start node makes that impossible, and the walk is
  // per-start-node so the cache stays sound.
  const descendantMemo = new Map<string, string[]>()
  const descendants = (id: string): string[] => {
    const cached = descendantMemo.get(id)
    if (cached) return cached
    const out: string[] = []
    const seen = new Set<string>([id])
    // Children pushed in reverse so popping walks them in order: the result is
    // depth-first PRE-ORDER, matching the order the rows render in.
    const stack = [...(children.get(id) ?? [])].reverse()
    while (stack.length > 0) {
      const next = stack.pop() as IssueNavigationModel
      if (seen.has(next.id)) continue
      seen.add(next.id)
      out.push(next.id)
      stack.push(...[...(children.get(next.id) ?? [])].reverse())
    }
    descendantMemo.set(id, out)
    return out
  }
  const sessionList = [...sessions]
  const worktreePaths = [...allWorktreePaths]
  const sessionsByIssue = new Map<string, SessionMeta[]>(
    visibleIssues.map((issue) => [issue.id, sessionsForIssue(issue, sessionList, worktreePaths)]),
  )
  const selfMatches = (issue: IssueNavigationModel): boolean => {
    const ownSessions = sessionsByIssue.get(issue.id) ?? []
    if (mode === 'needs-you') return issueNeedsHuman(issue, ownSessions)
    if (mode === 'active') {
      return (
        (issue.stage !== 'done' && !issue.closedReason) || ownSessions.some(openSession)
      )
    }
    return true
  }
  // Walk up the RENDERED tree, not raw parentId edges: a grafted agent-started
  // issue has no parentId, so a parentId-only walk would drop the ancestors a
  // filtered row needs to stay in context.
  const parentOf = new Map<string, string>()
  for (const [parentId, siblings] of children) {
    for (const child of siblings) if (!parentOf.has(child.id)) parentOf.set(child.id, parentId)
  }
  const included = new Set<string>()
  const includePath = (issue: IssueNavigationModel): void => {
    let currentId: string | undefined = issue.id
    const seen = new Set<string>()
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId)
      included.add(currentId)
      if (currentId === rootId) break
      currentId = parentOf.get(currentId)
    }
  }
  for (const id of missionIds) {
    const issue = byId.get(id)
    if (issue && selfMatches(issue)) includePath(issue)
  }
  included.add(rootId)

  const rows: FlightDeckRow[] = []
  const walk = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id) || !included.has(id)) return
    const issue = byId.get(id)
    if (!issue) return
    const descendantIds = descendants(id)
    const subtreeSessions = [id, ...descendantIds].flatMap(
      (issueId) => sessionsByIssue.get(issueId) ?? [],
    )
    const actionableCount = [id, ...descendantIds].filter((issueId) => {
      const candidate = byId.get(issueId)
      return candidate
        ? issueNeedsHuman(candidate, sessionsByIssue.get(issueId) ?? [])
        : false
    }).length
    rows.push({
      issue,
      depth,
      sessions: sessionsByIssue.get(id) ?? [],
      descendantIds,
      actionableCount,
      liveAgentCount: subtreeSessions.filter(openSession).length,
    })
    const nextPath = new Set(path).add(id)
    for (const child of children.get(id) ?? []) walk(child.id, depth + 1, nextPath)
  }
  walk(rootId, 0, new Set())
  return rows
}

export type OperationalState =
  | 'working'
  | 'needs-you'
  | 'waiting'
  | 'moved'
  | 'retired'
  | 'ready'
  | 'done'
  | 'idle'

/**
 * An outgoing `blocks` dep means "this issue is blocked BY the target" (see
 * issue-relations.ts for the verified direction). Naming the blocker turns a
 * dead end into something the operator can go and act on.
 */
function blockedByLabel(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string {
  if (!byId) return 'Waiting on dependency'
  const refs = (issue.deps ?? [])
    .filter((dep) => dep.type === 'blocks')
    .map((dep) => byId.get(dep.id))
    .filter((target): target is IssueNavigationModel => Boolean(target))
    .filter((target) => target.stage !== 'done' && !target.closedReason)
    .map((target) => issueDisplayRef(target))
  if (refs.length === 0) return 'Waiting on dependency'
  return refs.length === 1 ? `Blocked by ${refs[0]}` : `Blocked by ${refs.length} tasks`
}

export function operationalState(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): { state: OperationalState; label: string } {
  // "Active" means the process is still there: an exited-but-unarchived session
  // is gone, and reading it as "standing by" would tell the operator an agent
  // is on this task when none is. Same predicate the row counts use.
  const active = sessions.filter(openSession)
  if (issueNeedsHuman(issue, active)) return { state: 'needs-you', label: 'Needs you' }
  if (active.some((session) => session.handoffTarget)) return { state: 'moved', label: 'Moving' }
  if (active.some((session) => motionPhase(session) === 'working'))
    return { state: 'working', label: 'Running' }
  if (issue.stage === 'done' || issue.closedReason) return { state: 'done', label: 'Done' }
  if (issue.blocked) return { state: 'waiting', label: blockedByLabel(issue, byId) }
  if (active.length === 0 && sessions.length > 0) return { state: 'retired', label: 'Agent retired' }
  if (active.length === 0 && issue.ready) return { state: 'ready', label: 'Ready to run' }
  if (active.some((session) => motionPhase(session) === 'waiting'))
    return { state: 'needs-you', label: 'Waiting on you' }
  return active.length > 0 ? { state: 'idle', label: 'Standing by' } : { state: 'ready', label: 'Ready' }
}

/** How many distinct sessions are leading something in this mission. One agent
 *  leading both an epic and one of its sub-issues is one lead, not two. */
export function coordinatorCount(
  rows: readonly FlightDeckRow[],
  sessions: readonly SessionMeta[],
): number {
  const leads = new Set<string>()
  for (const row of rows) {
    for (const session of sessions) {
      if (isCoordinatorSession(row.issue, session.sessionId)) leads.add(session.sessionId)
    }
  }
  return leads.size
}
