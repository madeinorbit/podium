import {
  isCoordinatorSession,
  motionPhase,
  type IssueNavigationModel,
  sessionsForIssueNav,
} from '@podium/client-core/viewmodels'
import type { AgentKind, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'

export type FlightDeckMode = 'full' | 'active' | 'needs-you'

/**
 * What a folded branch is hiding, so the fold can still say it.
 *
 * Counts describe the DESCENDANTS (the tasks the fold removes from the spine);
 * `kinds` and `needsYou` also cover the row's OWN sessions, because folding
 * hides those too and the row's own state mark is replaced by this payload.
 */
export interface CollapsedSummary {
  tasks: number
  done: number
  run: number
  /** Up to two distinct harness kinds among the live sessions being hidden. */
  kinds: AgentKind[]
  needsYou: boolean
}

export interface FlightDeckRow {
  issue: IssueNavigationModel
  depth: number
  sessions: SessionMeta[]
  descendantIds: string[]
  actionableCount: number
  liveAgentCount: number
  collapsedSummary: CollapsedSummary
}

export interface MissionProgress {
  total: number
  done: number
  run: number
  block: number
  wait: number
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

/**
 * Mission progress over the WHOLE mission, never the filtered spine.
 *
 * The filter is a display preference; the mission's shape is not. Computing this
 * from the rendered rows made `Active` (which hides done work) report `0 / N`,
 * which is the one number the operator is most likely to read as truth.
 *
 * Four segments, from the artifact's `progress()`: done / run / block / wait.
 * The root counts as a task — it is one, with its own stage — matching the
 * artifact, whose `issues` array includes it.
 *
 * The artifact's arithmetic (`done` by stage, `run` by stage, `block` by state,
 * `wait` = the remainder) lets one issue land in two buckets, which would push
 * the bar past 100%. Classification here is EXCLUSIVE in the order
 * done → block → run → wait: blocked work is not running, and that is the
 * segment the operator needs to see.
 */
export function missionProgress(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string | null | undefined,
): MissionProgress {
  const empty = { total: 0, done: 0, run: 0, block: 0, wait: 0 }
  if (!rootId) return empty
  const ids = missionIssueIds(issues, rootId, sessions)
  const scope = issues.filter(
    (issue) => ids.has(issue.id) && !issue.archived && !issue.deletedAt,
  )
  let done = 0
  let run = 0
  let block = 0
  for (const issue of scope) {
    if (issue.stage === 'done' || issue.closedReason) done += 1
    else if (issue.blocked) block += 1
    else if (issue.stage === 'in_progress' || issue.stage === 'review') run += 1
  }
  const total = scope.length
  return { total, done, run, block, wait: Math.max(0, total - done - run - block) }
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
    const hidden = descendantIds
      .map((issueId) => byId.get(issueId))
      .filter((candidate): candidate is IssueNavigationModel => Boolean(candidate))
    rows.push({
      issue,
      depth,
      sessions: sessionsByIssue.get(id) ?? [],
      descendantIds,
      actionableCount,
      liveAgentCount: subtreeSessions.filter(openSession).length,
      collapsedSummary: {
        tasks: hidden.length,
        done: hidden.filter((child) => child.stage === 'done' || child.closedReason).length,
        run: hidden.filter(
          (child) =>
            !child.closedReason && (child.stage === 'in_progress' || child.stage === 'review'),
        ).length,
        kinds: [...new Set(subtreeSessions.filter(openSession).map((s) => s.agentKind))].slice(0, 2),
        needsYou: actionableCount > 0,
      },
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

// ---------------------------------------------------------------------------
// Presence: what a row says when it has no agent on it, and what it says about
// a dependency even when it does.
// ---------------------------------------------------------------------------

/** The unfinished issues this one is waiting on, as display refs. Outgoing
 *  `blocks` deps mean "blocked BY the target" (issue-relations.ts). */
function waitingRefs(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string[] {
  if (!byId) return []
  return (issue.deps ?? [])
    .filter((dep) => dep.type === 'blocks')
    .map((dep) => byId.get(dep.id))
    .filter((target): target is IssueNavigationModel => Boolean(target))
    .filter((target) => target.stage !== 'done' && !target.closedReason)
    .map((target) => issueDisplayRef(target))
}

/**
 * "Waiting for X to complete" — the note that appears ALONGSIDE live sessions.
 *
 * An agent can be working flat out on something that still cannot land until a
 * dependency clears; the artifact says so on the row rather than making the
 * operator open the task to find out. Distinct from `blocked`, which is the
 * server's verdict that nothing can proceed at all.
 */
export function waitingNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string | null {
  const refs = waitingRefs(issue, byId)
  if (refs.length === 0) return null
  return refs.length === 1
    ? `Waiting for ${refs[0]} to complete`
    : `Waiting for ${refs.length} tasks to complete`
}

export type PresenceKind =
  | 'moved'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'review'
  | 'ready'
  | 'attention'

export interface PresenceNote {
  kind: PresenceKind
  text: string
  /** Amber: this row is asking something of the operator. */
  attention: boolean
}

/**
 * Why this issue has nobody on it — the artifact's `presenceNote`.
 *
 * A blank where an agent row would be is the one thing the deck must never do:
 * "no session" is four different situations and only one of them is a problem.
 * Returns null when the issue HAS live sessions (the agent rows speak for it)
 * or when there is genuinely nothing to say.
 *
 * Only vacated in-progress work becomes attention. Done, review, ready and
 * blocked are all states the operator can read and leave alone.
 */
export function presenceNote(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): PresenceNote | null {
  if (sessions.some(openSession)) return null
  const moved = sessions.find((session) => session.handoffTarget)
  if (moved) {
    return { kind: 'moved', text: `Session moved to ${moved.handoffTarget}`, attention: false }
  }
  if (issue.blocked) {
    return { kind: 'blocked', text: blockedByLabel(issue, byId), attention: false }
  }
  const waiting = waitingNote(issue, byId)
  if (waiting) return { kind: 'waiting', text: waiting, attention: false }
  if (issue.stage === 'done' || issue.closedReason) {
    return { kind: 'done', text: 'Completed · session retired', attention: false }
  }
  if (issue.stage === 'review') {
    return { kind: 'review', text: 'Review ready · session ended', attention: false }
  }
  if (issue.stage === 'planning' || issue.stage === 'backlog') {
    return { kind: 'ready', text: 'Ready to start', attention: false }
  }
  if (issue.stage === 'in_progress') {
    return { kind: 'attention', text: 'Agent left · choose a handoff', attention: true }
  }
  return null
}

const RELATION_VERB: Record<string, string> = {
  'discovered-from': 'Discovered from',
  related: 'Related to',
  tracks: 'Tracks',
  supersedes: 'Supersedes',
  'caused-by': 'Caused by',
  validates: 'Validates',
}

/**
 * The `↳ …` line: where this issue came from, when that is not already being
 * said by a waiting or moved note. `blocks` is excluded — that edge is the
 * blocked/waiting note's job, and saying it twice reads as two dependencies.
 */
export function relationNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string | null {
  if (!byId) return null
  for (const dep of issue.deps ?? []) {
    if (dep.type === 'blocks' || dep.type === 'parent-child') continue
    const target = byId.get(dep.id)
    if (!target) continue
    return `${RELATION_VERB[dep.type] ?? dep.type} ${issueDisplayRef(target)}`
  }
  return null
}

/**
 * How many tasks across the WHOLE portfolio are asking something of the
 * operator — the number on the Superagent rail badge.
 *
 * Deliberately not mission-scoped: the badge's promise ("N tasks across your
 * portfolio need a decision") is about the work you cannot see from here. Same
 * predicate as every deck count, so the two can never disagree.
 */
export function portfolioActionableCount(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
): number {
  const byIssue = new Map<string, SessionMeta[]>()
  const add = (issueId: string, session: SessionMeta): void => {
    const list = byIssue.get(issueId) ?? []
    list.push(session)
    byIssue.set(issueId, list)
  }
  const memberOf = new Map<string, string>()
  for (const issue of issues) {
    for (const sessionId of issue.memberSessionIds ?? []) memberOf.set(sessionId, issue.id)
  }
  for (const session of sessions) {
    if (session.archived) continue
    const owner = session.issueId ?? memberOf.get(session.sessionId)
    if (owner) add(owner, session)
  }
  return issues.filter(
    (issue) =>
      !issue.archived &&
      !issue.deletedAt &&
      issue.stage !== 'done' &&
      !issue.closedReason &&
      issueNeedsHuman(issue, byIssue.get(issue.id) ?? []),
  ).length
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
