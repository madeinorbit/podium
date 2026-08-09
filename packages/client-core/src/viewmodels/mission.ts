import { type AgentKind, type SessionMeta, spawnedByParentSessionId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { sessionsForIssueNav } from './session-ownership'
import { motionPhase } from './session-status'
import type { IssueNavigationModel } from './slices/issues'
import { isCoordinatorSession } from './slices/terminal'

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
  /** Sessions PRESENT in the subtree: open, not archived, not exited. */
  liveAgentCount: number
  /**
   * Sessions in the subtree actually COMPUTING right now.
   *
   * Deliberately narrower than {@link liveAgentCount}: an idle or waiting
   * session is present but is not working, and the braille spinner may only
   * render while an agent computes (DESIGN.md §5 — gating is the caller's job).
   * Driving the spinner off the live count would leave it turning over a mission
   * where nothing is happening, which is the one thing the only perpetual
   * motion in the app must never do.
   */
  workingAgentCount: number
  /**
   * How many things in this subtree stopped and asked the operator something.
   *
   * Counted per SESSION, not per task (POD-516 round 2 §5): a task does not need
   * you — a session did. A task that is itself the exception (review, or an
   * explicit `needsHuman`) with no session asking still counts once, because the
   * operator has to answer it and nothing else would say so. Sessions are
   * de-duplicated across the subtree: one agent that is a member of two issues
   * asked once.
   *
   * Deliberately alongside {@link actionableCount} rather than replacing it —
   * that one counts TASKS and is what column 1 and the portfolio badge promise.
   */
  attentionCount: number
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
      if (
        !ids.has(issue.id) &&
        issue.startedBySession &&
        missionSessions.has(issue.startedBySession)
      ) {
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
  const scope = issues.filter((issue) => ids.has(issue.id) && !issue.archived && !issue.deletedAt)
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
  const byId = new Map<string, IssueNavigationModel>(
    visibleIssues.map((issue) => [issue.id, issue]),
  )
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
      return (issue.stage !== 'done' && !issue.closedReason) || ownSessions.some(openSession)
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
      return candidate ? issueNeedsHuman(candidate, sessionsByIssue.get(issueId) ?? []) : false
    }).length
    const hidden = descendantIds
      .map((issueId) => byId.get(issueId))
      .filter((candidate): candidate is IssueNavigationModel => Boolean(candidate))
    // Sessions asking, de-duplicated; plus the tasks that are the exception
    // themselves. See FlightDeckRow.attentionCount.
    const askingSessionIds = new Set<string>()
    let askingTasks = 0
    for (const issueId of [id, ...descendantIds]) {
      const candidate = byId.get(issueId)
      if (!candidate) continue
      const own = sessionsByIssue.get(issueId) ?? []
      const asking = own.filter((session) => !session.archived && sessionNeedsHuman(session))
      for (const session of asking) askingSessionIds.add(session.sessionId)
      if (asking.length === 0 && issueNeedsHuman(candidate, own)) askingTasks += 1
    }
    rows.push({
      issue,
      depth,
      sessions: sessionsByIssue.get(id) ?? [],
      descendantIds,
      actionableCount,
      liveAgentCount: subtreeSessions.filter(openSession).length,
      workingAgentCount: subtreeSessions.filter(
        (session) => openSession(session) && motionPhase(session) === 'working',
      ).length,
      attentionCount: askingSessionIds.size + askingTasks,
      collapsedSummary: {
        tasks: hidden.length,
        done: hidden.filter((child) => child.stage === 'done' || child.closedReason).length,
        run: hidden.filter(
          (child) =>
            !child.closedReason && (child.stage === 'in_progress' || child.stage === 'review'),
        ).length,
        kinds: [...new Set(subtreeSessions.filter(openSession).map((s) => s.agentKind))].slice(
          0,
          2,
        ),
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
  const refs = byId ? waitingRefs(issue, byId) : []
  if (refs.length === 1) return `Blocked by ${refs[0]}`
  if (refs.length > 1) return `Blocked by ${refs.length} tasks`
  // No resolvable edge. `blockedByNotes` is the model's LLM-authored prose about
  // what is blocking (fields/issue.ts D-2), and it is the last thing here that
  // NAMES anything — an operator cannot act on "Waiting on dependency", so the
  // sentence someone actually wrote beats the placeholder whenever it exists.
  const note = (issue.blockedByNotes ?? []).map((line) => line.trim()).find(Boolean)
  return note ?? 'Waiting on dependency'
}

/**
 * The named reason a task is blocked, or null when it is not.
 *
 * Split out from {@link presenceNote} because a blocked task can have live
 * agents on it: `presenceNote` goes quiet the moment a session is present, but
 * "Blocked by POD-507" is exactly what the operator needs while an agent is
 * still sitting there. The right-hand slot says the one word `Blocked`; this is
 * the line underneath that says by what.
 */
export function blockedNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string | null {
  return issue.blocked ? blockedByLabel(issue, byId) : null
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
  if (active.length === 0 && sessions.length > 0)
    return { state: 'retired', label: 'Agent retired' }
  if (active.length === 0 && issue.ready) return { state: 'ready', label: 'Ready to run' }
  if (active.some((session) => motionPhase(session) === 'waiting'))
    return { state: 'needs-you', label: 'Waiting on you' }
  return active.length > 0
    ? { state: 'idle', label: 'Standing by' }
    : { state: 'ready', label: 'Ready' }
}

// ---------------------------------------------------------------------------
// The Flight Deck's own row vocabulary.
//
// Deliberately a SECOND function beside `operationalState` rather than a change
// to it: the Task inspector and the compact issue controls read that one, and
// they still want "Needs you" as a state. The deck does not — see DeckIssueState.
// ---------------------------------------------------------------------------

/** One word per state, and the same word every time it appears in the spine. */
export type DeckState =
  | 'working'
  | 'moved'
  | 'done'
  | 'blocked'
  | 'waiting'
  | 'retired'
  | 'proposed'
  | 'next'
  | 'idle'

export interface DeckIssueState {
  state: DeckState
  /** The right-aligned word beside the mark. */
  label: string
  /**
   * Something inside this task stopped and asked — rendered as a COLOUR
   * INDICATOR, never as words (POD-516 round 2 §5).
   *
   * A task does not need you. A session did, and the session row is where the
   * operator can answer it, so that is where the marker and the words live. The
   * task strip only has to be findable from a distance.
   */
  attention: boolean
}

/**
 * `Next` was a promise the spine could not keep (POD-516 round 3 §7a).
 *
 * It said "scheduled after this" about work nobody has accepted yet, on the one
 * surface an operator uses to decide what to run. Podium's own word for a
 * proposal is the stage's — `Proposed` (ISSUE_STAGE_LABELS) — and everything
 * else that simply has nobody on it is `Not started`, which claims no order.
 */
const DECK_LABEL: Record<DeckState, string> = {
  working: 'Running',
  moved: 'Moving',
  done: 'Done',
  blocked: 'Blocked',
  waiting: 'Waiting',
  retired: 'Retired',
  proposed: 'Proposed',
  next: 'Not started',
  idle: 'Standing by',
}

/**
 * What a task strip says on its right-hand side, and whether it carries the
 * attention colour.
 *
 * The state channel answers "what is this task doing" and is orthogonal to the
 * attention channel — which is the whole point of the round-2 change. An issue
 * whose only session is waiting on the operator therefore reads `Standing by`
 * with the indicator lit, not `Needs you`: the task genuinely is standing by,
 * and the row below it says who is asking.
 */
export function deckIssueState(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): DeckIssueState {
  const active = sessions.filter(openSession)
  const attention = issueNeedsHuman(issue, active)
  const at = (state: DeckState): DeckIssueState => ({ state, label: DECK_LABEL[state], attention })
  if (active.some((session) => session.handoffTarget)) return at('moved')
  if (active.some((session) => motionPhase(session) === 'working')) return at('working')
  if (issue.stage === 'done' || issue.closedReason) return at('done')
  if (issue.blocked) return at('blocked')
  if (waitingRefs(issue, byId).length > 0) return at('waiting')
  if (active.length === 0 && sessions.length > 0) return at('retired')
  // A proposal says so in its own word. It is the one stage the deck treats as a
  // different KIND of row (no reserved session slot, a narrower strip), so the
  // state channel has to name it rather than lumping it in with backlog work.
  if (active.length === 0) return at(issue.stage === 'proposed' ? 'proposed' : 'next')
  return at('idle')
}

/**
 * Which sessions a row shows in the given view.
 *
 * `Needs you` is a filter over SESSIONS shown with their task path, so a matched
 * task lists only the agents that actually stopped. When nothing on the row is
 * asking — the row is pure path, or the TASK is the exception (review, an
 * explicit `needsHuman`) — every session stays, because hiding them would leave
 * the row claiming to be unattended when it is not.
 */
export function deckSessions(
  row: Pick<FlightDeckRow, 'sessions'>,
  mode: FlightDeckMode,
): SessionMeta[] {
  if (mode !== 'needs-you') return row.sessions
  const asking = row.sessions.filter((session) => !session.archived && sessionNeedsHuman(session))
  return asking.length > 0 ? asking : row.sessions
}

/**
 * What a session IS on this task — the dim mono word after its name.
 *
 * A nine-agent mission where only the coordinator is named reads as eight
 * anonymous rows. Every arm here is derived from a fact the model already holds:
 * the issue's designated coordinator, the spawn edge, or the absence of both.
 */
export type SessionRole =
  | { kind: 'coordinator' }
  | { kind: 'phase-lead' }
  | { kind: 'peer' }
  | { kind: 'spawned'; parentSessionId: string }

export function sessionRole(
  issue: IssueNavigationModel,
  session: SessionMeta,
  ctx: {
    /** The mission root, so its coordinator reads `coordinator` and a child's
     *  reads `phase lead` — the same fact at two altitudes. */
    rootId: string | null | undefined
    /** Every session rendered on this task, including this one. */
    siblings: readonly SessionMeta[]
    /** Session ids present anywhere in the mission: a spawn parent outside it
     *  cannot be named, so the row must not claim it. */
    inMission: ReadonlySet<string>
  },
): SessionRole | null {
  if (isCoordinatorSession(issue, session.sessionId)) {
    return issue.id === ctx.rootId ? { kind: 'coordinator' } : { kind: 'phase-lead' }
  }
  const parentSessionId = spawnedByParentSessionId(session.spawnedBy)
  if (
    parentSessionId &&
    parentSessionId !== session.sessionId &&
    ctx.inMission.has(parentSessionId)
  ) {
    return { kind: 'spawned', parentSessionId }
  }
  // No agent put it here and it does not lead the task, so the operator did.
  // A LONE session gets no label: "operator-added peer" on the only agent on a
  // task is a word that distinguishes it from nothing.
  return ctx.siblings.length > 1 ? { kind: 'peer' } : null
}

/**
 * A session's native subagents as rows.
 *
 * The wire carries an id and an optional type per worker, plus a count that may
 * exceed the identified list — a harness can report "three running" before it
 * reports which three. The unnamed remainder still gets a row, because the
 * operator's question is "how much is fanned out under this agent".
 */
export interface NativeSubagentRow {
  id: string
  type: string
  /**
   * Native workers carry no phase of their own, so a row follows the SESSION
   * that owns it: while that session computes — or is holding a finished turn
   * open *for* them (`awaitingSubagents`) — they are working. Anything else and
   * the fan-out is parked with its parent.
   */
  working: boolean
  /** Counted by the harness but not yet identified; the row has no real id. */
  anonymous: boolean
}

export function nativeSubagentRows(session: SessionMeta): NativeSubagentRow[] {
  const state = session.agentState
  const named = state?.nativeSubagents ?? []
  const missing = Math.max(0, (state?.nativeSubagentCount ?? 0) - named.length)
  const working =
    openSession(session) &&
    (motionPhase(session) === 'working' || state?.awaitingSubagents === true)
  return [
    ...named.map((agent) => ({
      id: agent.id,
      type: agent.type?.trim() || 'subagent',
      working,
      anonymous: false,
    })),
    ...Array.from({ length: missing }, (_, index) => ({
      id: `native-${index + 1}`,
      type: 'subagent',
      working,
      anonymous: true,
    })),
  ]
}

/**
 * Which tree guide lines pass DOWN the left of each row of a rendered spine.
 *
 * The spine renders flat (one row per issue, indented) so it can be filtered,
 * searched and eventually virtualized without re-parenting anything. The tree
 * still has to be visible, so each row draws the rail segments that cross it:
 * `guides[i][level - 1]` is true when the line at that nesting level continues
 * below row `i`, i.e. the ancestor sitting on it still has a sibling to come.
 * A rail that does not continue stops at the row's own elbow, which is what
 * makes the last child of a branch read as the last child.
 */
export function treeGuides(rows: readonly { depth: number }[]): boolean[][] {
  const out: boolean[][] = new Array(rows.length)
  // `moreAtDepth[d]` — walking backwards, is there a further row at depth d
  // before the branch containing it closes?
  const moreAtDepth: boolean[] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const depth = rows[index]?.depth ?? 0
    const carries: boolean[] = []
    for (let level = 1; level <= depth; level += 1) carries.push(moreAtDepth[level] === true)
    out[index] = carries
    // Everything deeper than this row belongs to a subtree that ends here.
    moreAtDepth.length = depth + 1
    moreAtDepth[depth] = true
  }
  return out
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
 *
 * TOTAL over the stage vocabulary, deliberately: the ONLY null is "this issue
 * has live sessions, and its agent rows speak for it". An unhandled stage used
 * to fall through to null as well, which made every caller invent its own
 * fallback line — which is the drift this shared vocabulary exists to prevent
 * (the Task dock hit exactly that on `proposed`). Adding a stage to the model
 * without a note here is now a visible gap in one place, not a silent blank in
 * every column.
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
  // `proposed` is the remaining stage. It is not "ready" — nobody has accepted
  // it yet — so it gets its own words rather than borrowing the ready line.
  return { kind: 'ready', text: 'Proposed · not started', attention: false }
}

const RELATION_VERB: Record<string, string> = {
  'discovered-from': 'Discovered from',
  related: 'Related to',
  tracks: 'Tracks',
  supersedes: 'Supersedes',
  'caused-by': 'Caused by',
  validates: 'Validates',
}

/** The first non-hierarchy, non-blocking edge this issue carries, split into the
 *  verb and the target ref so a caller can render either the sentence or just
 *  the ref. `blocks` is excluded — that edge is the blocked/waiting note's job,
 *  and saying it twice reads as two dependencies. */
function relationEdge(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): { verb: string; ref: string } | null {
  if (!byId) return null
  for (const dep of issue.deps ?? []) {
    if (dep.type === 'blocks' || dep.type === 'parent-child') continue
    const target = byId.get(dep.id)
    if (!target) continue
    return { verb: RELATION_VERB[dep.type] ?? dep.type, ref: issueDisplayRef(target) }
  }
  return null
}

/**
 * The `↳ …` line: where this issue came from, when that is not already being
 * said by a waiting or moved note.
 */
export function relationNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): string | null {
  const edge = relationEdge(issue, byId)
  return edge ? `${edge.verb} ${edge.ref}` : null
}

/**
 * ONE fact about the ISSUE, for the issue's own visual area (POD-516 round 3 §5).
 *
 * "Discovered from POD-516", "Blocked by POD-507" and "Waiting for POD-507" are
 * facts about the TASK. They used to hang below the task's session rows, in the
 * slot the spine reserves for agents, where the operator read them as one more
 * agent. They belong on the strip.
 *
 * Two forms, because the strip has room for a ref and a tooltip has room for a
 * sentence: `short` is what the strip prints (a display ref wherever one exists,
 * so the operator can go and act on it), `full` is the sentence that names the
 * relationship. Precedence matches the notes it replaces — a server-declared
 * block outranks an unfinished dependency, which outranks provenance — because
 * only one of them can be the reason this task is not moving.
 *
 * Presence stays OUT of this: "session moved to POD-612" and "no session yet"
 * are facts about the agent SLOT, and the slot is where they belong.
 */
export interface IssueNote {
  kind: 'blocked' | 'waiting' | 'relation'
  /** What the strip prints: a display ref, a count, or the authored prose. */
  short: string
  /** The sentence, for the hover title and the accessible name. */
  full: string
}

export function issueNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): IssueNote | null {
  const refs = waitingRefs(issue, byId)
  const many = (): string => `${refs.length} tasks`
  if (issue.blocked) {
    const full = blockedByLabel(issue, byId)
    // No resolvable edge leaves only the authored prose, which IS the short form
    // — a chip reading "Blocked by" with nothing after it names nothing.
    return {
      kind: 'blocked',
      short: refs.length === 1 ? (refs[0] as string) : refs.length > 1 ? many() : full,
      full,
    }
  }
  if (refs.length > 0) {
    return {
      kind: 'waiting',
      short: refs.length === 1 ? (refs[0] as string) : many(),
      full: waitingNote(issue, byId) as string,
    }
  }
  const edge = relationEdge(issue, byId)
  return edge ? { kind: 'relation', short: edge.ref, full: `${edge.verb} ${edge.ref}` } : null
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
