import {
  type AgentKind,
  asIssueId,
  asSessionId,
  type IssueId,
  type SessionId,
  type SessionMeta,
  spawnedByParentSessionId,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { sessionPresentOnTask } from './fleet'
import { sessionsForIssueNav } from './session-ownership'
import { motionPhase } from './session-status'
import { type IssueNavigationModel, isEmptyDraftVessel, issueAbandoned } from './slices/issues'
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
  /**
   * A CENSUS, NOT A ROSTER — the sessions a fold is hiding, in person.
   *
   * A collapsed strip shows one harness icon per session rather than a count or
   * a name: names need room the strip does not have, and a count of "3" tells
   * the operator nothing about whether Claude or a shell is in there. The
   * sessions arrive ordered working → present → settled, so a cap that bites
   * drops the quietest first, and each one keeps its identity so the strip can
   * put the whole line (`POD-716-A · Gauge smith · working 08:47`) on a tooltip.
   *
   * Covers the row's OWN sessions as well as its descendants': folding hides
   * both, and the icons stand for everything behind the chevron.
   */
  crew: SessionMeta[]
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
   * Did this row match the view's filter ITSELF, or is it only here as the path
   * to something that did (POD-1245)?
   *
   * The filters keep a match's ancestors so an exception never loses its
   * context, and until now the row carried no record of which it was — so
   * `Needs you` rendered a done parent exactly like the task that was actually
   * asking, and the whole chain read as five things demanding a decision.
   * A context row is scaffolding: it draws the tree and nothing else.
   *
   * Always `true` in `full`, where every row matches by definition.
   */
  matched: boolean
  collapsedSummary: CollapsedSummary
}

function sameRefs<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function sameCollapsedSummary(a: CollapsedSummary, b: CollapsedSummary): boolean {
  return (
    a.tasks === b.tasks &&
    a.done === b.done &&
    a.run === b.run &&
    a.needsYou === b.needsYou &&
    sameRefs(a.kinds, b.kinds) &&
    sameRefs(a.crew, b.crew)
  )
}

function sameFlightDeckRow(a: FlightDeckRow, b: FlightDeckRow): boolean {
  return (
    a.issue === b.issue &&
    a.depth === b.depth &&
    sameRefs(a.sessions, b.sessions) &&
    sameRefs(a.descendantIds, b.descendantIds) &&
    a.actionableCount === b.actionableCount &&
    a.liveAgentCount === b.liveAgentCount &&
    a.workingAgentCount === b.workingAgentCount &&
    a.matched === b.matched &&
    sameCollapsedSummary(a.collapsedSummary, b.collapsedSummary)
  )
}

/**
 * Reuse unchanged Flight Deck row objects by issue id.
 *
 * `buildFlightDeckRows` must derive from the current snapshot, but a session
 * update outside a row's subtree should not invalidate that row's React key or
 * make its motion wrapper measure again. The comparison is intentionally
 * shallow over stable entity references and scalar roll-ups; a changed issue,
 * session, descendant list, or summary still gets the fresh row.
 */
export function reuseFlightDeckRows(
  previous: readonly FlightDeckRow[],
  next: FlightDeckRow[],
): FlightDeckRow[] {
  if (previous.length === 0 || next.length === 0) return next
  const byIssue = new Map(previous.map((row) => [row.issue.id, row]))
  let unchanged = previous.length === next.length
  const reused = next.map((row, index) => {
    const prior = byIssue.get(row.issue.id)
    if (!prior || !sameFlightDeckRow(prior, row)) {
      unchanged = false
      return row
    }
    if (prior !== previous[index]) unchanged = false
    return prior
  })
  return unchanged ? (previous as FlightDeckRow[]) : reused
}

export interface MissionProgress {
  total: number
  done: number
  run: number
  /** Work awaiting the operator's review, not active execution. */
  review: number
  /**
   * Work that BEGAN AND HAS NOBODY ON IT — a started stage with no open session
   * anywhere under the task (POD-1314). Split out of {@link MissionProgress.run}
   * so the meter cannot say `underway` about a mission whose own crew chip says
   * `0 agents`; see {@link missionProgress}.
   */
  stall: number
  block: number
  wait: number
}

/** The mission's name for {@link sessionPresentOnTask} — one presence rule for
 *  the whole client (POD-756), spelled once in `./fleet`. */
const openSession = sessionPresentOnTask

/**
 * A session that is no longer working: retired, or holding a finished turn.
 *
 * The deck DIMS these rather than hiding them (POD-758): "nothing is hidden by
 * default" is the spine's rule, and what removes finished work is the view bar,
 * not a fold. One predicate so the dimmed agent row, the dimmed census icon and
 * the ordering below can never disagree about which agents are still in play.
 */
export function sessionSettled(session: SessionMeta): boolean {
  return !openSession(session) || motionPhase(session) === 'done'
}

/**
 * AN AGENT GENUINELY COMPUTING RIGHT NOW — the only thing that may keep a
 * FINISHED task on the `Active` view (POD-1245).
 *
 * `Active` used to ask {@link openSession} here, and presence is far too weak a
 * question: it means "not archived and not exited", which a PARKED agent
 * satisfies — and parking is how an agent normally ends. So four closed tasks in
 * five kept a hibernated session and were re-admitted to a view whose whole job
 * is hiding finished work, cancelled and duplicate ones included.
 *
 * The escape hatch is still needed — an agent really can still be running on a
 * task somebody already closed, and hiding that would lose it — but it has to
 * ask whether the agent is WORKING, not whether it exists. `motionPhase` is the
 * same verdict the green dot and the braille spinner read, and it demotes a
 * hibernated session to `ready` (session-status.ts), so a parked agent can never
 * answer yes here. Deliberately the same predicate as `workingAgentCount` below:
 * the row's own spinner and this filter must never disagree about who is busy.
 */
function sessionWorking(session: SessionMeta): boolean {
  return openSession(session) && motionPhase(session) === 'working'
}

/** The census behind a fold: deduplicated, ordered working → present → settled,
 *  and capped well above what any strip draws so the caller owns the trim and
 *  the `+N` that goes with it. */
const CREW_CAP = 12

function deckCrew(sessions: readonly SessionMeta[]): SessionMeta[] {
  const seen = new Set<string>()
  const unique: SessionMeta[] = []
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    unique.push(session)
  }
  const rank = (session: SessionMeta): number =>
    openSession(session) && motionPhase(session) === 'working' ? 0 : sessionSettled(session) ? 2 : 1
  return unique.sort((a, b) => rank(a) - rank(b)).slice(0, CREW_CAP)
}

export function sessionNeedsHuman(session: SessionMeta): boolean {
  return (
    session.agentState?.phase === 'needs_user' ||
    (session.agentState?.phase === 'errored' && session.agentState.error?.retryable === true) ||
    Boolean(session.offer)
  )
}

/** Closing is the operator's own "this is finished" flip. `done` and an explicit
 *  `closedReason` are the two spellings of it, and every reader that asks "is
 *  this over" must accept both — the board writes one, `issue close` the other. */
export function issueClosed(issue: Pick<IssueNavigationModel, 'stage' | 'closedReason'>): boolean {
  return issue.stage === 'done' || Boolean(issue.closedReason)
}

/**
 * Does this session ask the operator for something ON THIS TASK?
 *
 * {@link sessionNeedsHuman} is about the session alone and cannot see the task,
 * so it keeps saying yes to a standing offer long after the work closed. This is
 * the version every attention surface should use (POD-1072): the same question,
 * asked where the answer can account for the task being over.
 */
export function sessionAsksOnIssue(
  issue: Pick<IssueNavigationModel, 'stage' | 'closedReason'>,
  session: SessionMeta,
): boolean {
  return !issueClosed(issue) && !session.archived && sessionNeedsHuman(session)
}

export function issueNeedsHuman(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): boolean {
  // A CLOSED TASK NEVER NEEDS YOU (POD-1072). Closing is the operator's own
  // "this is finished" flip, and nothing downstream of it may keep demanding a
  // decision: not a standing offer the agent posted a beat AFTER closing (which
  // the close-time sweep cannot see), not a session parked in `needs_user`, not
  // a question nobody got round to answering. The server retires those offers
  // too — this is the rule that holds even when a race beats it, and the one
  // that quiets the offers already sitting in the store from before it.
  if (issueClosed(issue)) return false
  if (issue.needsHuman === true) return true
  if (sessions.some((session) => !session.archived && sessionNeedsHuman(session))) return true
  // An empty review whose session hopscotched is a signpost, not a review item.
  if (issue.stage === 'review' && isVacatedOrigin(issue, sessions, byId)) return false
  return issue.stage === 'review'
}

export function missionRootFor(
  issues: readonly IssueNavigationModel[],
  selectedIssueId: IssueId | null,
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

/**
 * THE MISSION THE OPERATOR IS SUPERVISING — `missionRootFor` with the cold case
 * answered honestly (POD-1112).
 *
 * `missionRootFor` answers a structural question ("which root does this task
 * hang from?") and every task has an answer. The shell's columns ask a
 * different one: "is there a mission on screen at all?" — and after a reload
 * the persisted selection routinely points at an EMPTY DRAFT VESSEL, a
 * composer placeholder whose session never started. Rendering that as a mission
 * gave the Flight Deck a header, a progress gauge and a view bar for a task
 * that is not work and has no agents, instead of the deck's own empty state.
 *
 * So a vessel with nothing in it resolves to `undefined`: nothing is selected,
 * and the surfaces that read this say so. A draft that IS filling — the live
 * composer case — still has its session and still resolves, because that deck
 * has something to show.
 *
 * AN ARCHIVED MISSION IS NOT ON SCREEN EITHER (POD-1153). Archiving takes the
 * row out of every list the operator can see, and the selection is left
 * pointing at it — so the columns would go on supervising a task the sidebar no
 * longer shows as selected. The walk already refuses to climb THROUGH an
 * archived parent for the same reason; this is the same rule applied to where
 * it lands. Archiving a SUB-task is unaffected: the walk still resolves it to
 * its live ancestor, and that mission is genuinely still on screen.
 */
export function selectedMissionRoot(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  selectedIssueId: IssueId | null,
): IssueNavigationModel | undefined {
  const root = missionRootFor(issues, selectedIssueId)
  if (!root || root.archived || root.deletedAt) return undefined
  if (isEmptyDraftVessel(root, sessions)) return undefined
  return root
}

/**
 * WHAT THE DECK MUST SELECT to put a task on screen — the mission root to
 * re-root onto, or `undefined` when it cannot show that task at all (POD-1151).
 *
 * The sidebar selects MISSIONS: `selectedIssueId` is a root, and focus is the
 * pointer inside it, which `resolveFocus` discards when it names something that
 * mission does not contain. `undefined` covers a task with no deck to arrive at
 * — absent from the replica, archived or deleted, or in a mission
 * {@link selectedMissionRoot} already resolves to "nothing on screen". A surface
 * offering a jump reads this first and offers none rather than landing blank.
 */
export function deckDestinationFor(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  targetId: IssueId | null,
): IssueNavigationModel | undefined {
  if (!targetId) return undefined
  const target = issues.find((issue) => issue.id === targetId)
  // The target's OWN reachability, which `missionRootFor` does not ask: it
  // checks ancestors, so an archived target resolves happily to itself.
  if (!target || target.archived || target.deletedAt) return undefined
  const root = missionRootFor(issues, targetId)
  if (!root || isEmptyDraftVessel(root, sessions)) return undefined
  return root
}

/**
 * The origin a spin-off was discovered from, or null when it is not one.
 *
 * An OUTGOING `discovered-from` dep is what `attach --spinoff` writes (see
 * issue-relations.ts for the verified direction), and it is the model's own
 * statement that this work is nobody's sub-task.
 */
export function spinOffOriginId(issue: {
  deps?: ReadonlyArray<{ id: string; type: string }>
}): string | null {
  return issue.deps?.find((dep) => dep.type === 'discovered-from')?.id ?? null
}

/** Stages that mean nobody has picked the work up yet. Work that has not begun
 *  has not gone anywhere, whatever shape it was filed in. */
const UNSTARTED = new Set(['proposed', 'backlog'])

/**
 * Stages whose own name says the work has BEGUN — the gauge's `run` bucket.
 *
 * Deliberately wider than `in_progress`, and deliberately not the complement of
 * {@link UNSTARTED}: `review` and the closed stages are begun too, and they have
 * their own segments because "waiting for you" and "over" are not "underway".
 * What is left is the three stages that mean someone is on it —
 *
 *   `planning`    an agent is designing; the CLI tells every agent to sit here
 *                 while it investigates and to move to `in_progress` when it
 *                 starts changing code, so this is as picked-up as a stage gets
 *   `in_progress` the obvious one
 *   `shipping`    system-owned custody (`isSystemOwnedIssueStage`), which
 *                 `deckIssueState` and `operationalState` both already read as
 *                 working — the meter was the only surface that did not
 *
 * — and none of them may land in the `wait` remainder, whose word is `to go`.
 */
const UNDERWAY = new Set(['planning', 'in_progress', 'shipping'])

/**
 * A spin-off the operator has STARTED has left the mission that discovered it.
 *
 * Both halves matter. Until it starts it belongs on the origin's spine — the
 * deck is the only surface that shows a proposal at all, and the whole point of
 * showing it there is that the operator triages it in the context that produced
 * it. The moment it is started as its own thing, it is its own thing: it gets a
 * sidebar row, and the origin is released.
 *
 * Without this, mission membership follows `startedBySession` alone — and
 * `issues.create` stamps that field on EVERY agent create — so a spin-off filed
 * by a mission agent was dragged back onto the origin's spine for good, counted
 * in its progress, and the origin could never read as finished (POD-679).
 */
export function hasLeftMission(issue: IssueNavigationModel): boolean {
  return !UNSTARTED.has(issue.stage) && spinOffOriginId(issue) !== null
}

/**
 * A spin-off an AGENT IS SITTING ON. Started, whatever its stage says.
 *
 * `attach --spinoff` files the new issue in `backlog` and re-homes the session
 * onto it in the same breath, and nothing stages it afterwards but the agent
 * remembering to. So for the whole window between the hop and that update — two
 * minutes on POD-1073, unbounded when the agent never gets to it — the stage
 * read "nobody has picked this up" about the one issue an agent had just moved
 * to, {@link hasLeftMission} was false, and the origin went silent again with
 * "Completed · session retired": the exact sentence POD-957 shipped to delete.
 *
 * A session is the strongest possible statement that work has begun, so it is
 * read here as one. Deliberately NOT folded into `hasLeftMission`: that
 * predicate also governs mission MEMBERSHIP through a per-issue-slice index
 * (see MissionIssueIndex), and membership must stay a fact about the issue
 * alone. An unstarted spin-off nobody is on still belongs on the origin's spine
 * for triage — that half of the rule is untouched.
 */
function staffedSpinOff(issue: IssueNavigationModel, sessions: readonly SessionMeta[]): boolean {
  return (
    spinOffOriginId(issue) !== null &&
    sessions.some((session) => session.issueId === issue.id && openSession(session))
  )
}

function spinOffDescendants(
  originId: string,
  byId: ReadonlyMap<string, IssueNavigationModel>,
): IssueNavigationModel[] {
  const out: IssueNavigationModel[] = []
  const seen = new Set<string>()
  const stack = [originId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const issue of byId.values()) {
      if (seen.has(issue.id) || issue.archived || issue.deletedAt) continue
      if (spinOffOriginId(issue) !== id) continue
      seen.add(issue.id)
      out.push(issue)
      stack.push(issue.id)
    }
  }
  return out
}

function lastActiveAt(issue: IssueNavigationModel, sessions: readonly SessionMeta[]): string {
  let latest = issue.updatedAt ?? ''
  for (const session of sessions) {
    if (session.issueId !== issue.id || session.archived) continue
    if (session.lastActiveAt > latest) latest = session.lastActiveAt
  }
  return latest
}

/**
 * Where the work went after a hopscotch spin-off.
 *
 * Walks outgoing `discovered-from` edges that have LEFT the origin — staged out
 * of the backlog, or {@link staffedSpinOff}. Prefers a descendant that still has
 * a live session, then an unfinished one, then the latest hop even if it is done
 * — so an empty origin always has a name to print instead of a blank deck.
 */
export function liveSpinOffTip(
  origin: Pick<IssueNavigationModel, 'id'>,
  byId: ReadonlyMap<string, IssueNavigationModel> | undefined,
  sessions: readonly SessionMeta[] = [],
): IssueNavigationModel | null {
  if (!byId) return null
  const left = spinOffDescendants(origin.id, byId).filter(
    (issue) => hasLeftMission(issue) || staffedSpinOff(issue, sessions),
  )
  if (left.length === 0) return null
  const staffed = left.filter((issue) =>
    sessions.some((session) => session.issueId === issue.id && openSession(session)),
  )
  const pool =
    staffed.length > 0
      ? staffed
      : left.filter((issue) => !issue.closedReason && issue.stage !== 'done')
  const pick = (pool.length > 0 ? pool : left).slice()
  pick.sort((a, b) => lastActiveAt(b, sessions).localeCompare(lastActiveAt(a, sessions)))
  return pick[0] ?? null
}

/** Sessionless, and the work continued on a started spin-off. A signpost, not a task. */
export function isVacatedOrigin(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): boolean {
  if (sessions.some((session) => session.issueId === issue.id && openSession(session))) return false
  if (liveSpinOffTip(issue, byId, sessions)) return true
  return (issue.dependents ?? []).some((dep) => dep.type === 'discovered-from')
}

/**
 * The halves of {@link missionIssueIds} that depend on the ISSUE SLICE ALONE —
 * not on the root, not on the sessions — so they can be built once and reused.
 */
interface MissionIssueIndex {
  /** Live issues by `parentId`: the formal subtree walk's adjacency list. */
  children: Map<string, IssueNavigationModel[]>
  /**
   * The only issues the provenance fallback can ever claim, in `issues` order.
   *
   * Every other clause of that fallback's test depends on the mission being
   * walked; these two — "was started by a session" and "has not LEFT the
   * mission" — are facts about the issue on its own, so evaluating them per
   * pass per call was pure waste. It was expensive waste: `hasLeftMission`
   * scans `deps` through `spinOffOriginId`, and a live profile put those two
   * functions at 13% of all main-thread CPU between them.
   *
   * ARCHIVED AND DELETED ISSUES STAY IN, deliberately. The parent-child walk
   * below drops them (an archived branch takes its descendants with it), but
   * the fallback never filtered them and must not start: an archived issue
   * still belongs to the mission whose agent started it, and dropping it here
   * would silently shrink `missionSessions` for anything it started in turn.
   */
  startedCandidates: Array<{ id: string; startedBySession: SessionId }>
}

let missionIndexBuilds = 0

/**
 * One index per issue slice, KEYED ON THE ARRAY'S IDENTITY.
 *
 * `missionIssueIds` rebuilt the whole `children` map on every call. That is
 * fine when the mission is asked for once per render and ruinous when it is
 * asked for inside a loop over sessions: `knownTabIdsForWorkspace` did exactly
 * that, and a Chrome profile of a live client holding 1,027 issues and 827
 * sessions measured ~849,000 iterations rebuilding one identical map 827 times
 * per inbound feed frame — 21% of all busy CPU in this function alone, at 4-10
 * fps.
 *
 * The identity key is sound because the replica already promises it: the kernel
 * facade documents that "a kind whose CONTENTS did not change keeps the
 * identical `rows` reference … identity stability is part of the contract, not
 * an optimisation", and its incremental reconcile builds a NEW array for any
 * change rather than mutating in place (replica/kernel/facade.ts). The
 * optimistic ledger's `foldOverlays` preserves the array identity only when it
 * folded nothing. So a changed slice is always a different array — which is the
 * one property this memo needs, and the same one every `useMemo([issues])` in
 * the web app and the worklist slice's `sourceEqual` already rest on. A stale
 * index here would mean wrong mission membership, i.e. wrong tabs, so the memo
 * deliberately adds no assumption of its own.
 *
 * A `WeakMap`, so a superseded slice's index dies with the array that named it.
 */
const missionIndexes = new WeakMap<readonly IssueNavigationModel[], MissionIssueIndex>()

function missionIssueIndex(issues: readonly IssueNavigationModel[]): MissionIssueIndex {
  const cached = missionIndexes.get(issues)
  if (cached) return cached
  missionIndexBuilds += 1
  const children = new Map<string, IssueNavigationModel[]>()
  const startedCandidates: Array<{ id: string; startedBySession: SessionId }> = []
  for (const issue of issues) {
    if (issue.startedBySession && !hasLeftMission(issue)) {
      startedCandidates.push({ id: issue.id, startedBySession: issue.startedBySession })
    }
    if (issue.archived || issue.deletedAt || !issue.parentId) continue
    const siblings = children.get(issue.parentId) ?? []
    siblings.push(issue)
    children.set(issue.parentId, siblings)
  }
  const index: MissionIssueIndex = { children, startedCandidates }
  missionIndexes.set(issues, index)
  return index
}

/** How many times the shared mission index has been built — the seam the
 *  regression test uses to assert it is once per issue slice rather than once
 *  per caller. Same shape as `issueViewModelProjectionStats`. */
export function missionIndexStats(): { builds: number } {
  return { builds: missionIndexBuilds }
}

/**
 * THE FORMAL SUBTREE — what the mission is actually MADE OF.
 *
 * `missionIssueIds` answers a wider question ("what belongs on this deck") and
 * has to: a spin-off awaiting triage and a task an agent filed from here are
 * both things the operator must be able to see in the context that produced
 * them, and neither carries a `parentId`. That is provenance, and provenance
 * earns a ROW.
 *
 * It does not earn a SEGMENT OF THE METER, which is a different claim: that the
 * work is part OF this mission, so the mission is not finished until it is.
 * Only decomposition says that, and decomposition is exactly the parent-child
 * edge `--subissue` writes. The litmus the CLI already puts to every agent —
 * "could the current issue close with it untouched?" — is the same line: yes
 * makes it a spin-off, no makes it a sub-issue, and the meter should count the
 * second and not the first.
 *
 * Grafts reaching the deck by `startedBySession` alone were counted as members
 * anyway, which is how POD-993 came to read `1 DONE` at full track while its
 * root sat in review with an agent working: the one unit it was measuring was a
 * top-level task its session had filed and someone had since cancelled.
 */
function formalMemberIds(issues: readonly IssueNavigationModel[], rootId: string): Set<string> {
  const { children } = missionIssueIndex(issues)
  const ids = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (ids.has(id)) continue
    ids.add(id)
    for (const child of children.get(id) ?? []) stack.push(child.id)
  }
  ids.delete(rootId)
  return ids
}

export function missionIssueIds(
  issues: readonly IssueNavigationModel[],
  rootId: string,
  sessions: readonly SessionMeta[] = [],
): Set<string> {
  const { children, startedCandidates } = missionIssueIndex(issues)
  const ids = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (ids.has(id)) continue
    ids.add(id)
    for (const child of children.get(id) ?? []) stack.push(child.id)
  }
  // Agent-started children belong to the mission when their starting session is
  // already in the mission — unless they have LEFT it (see `hasLeftMission`):
  // provenance is not membership once the operator has started the work on its
  // own. The parent-child walk above is untouched; a spin-off never has a
  // parentId, so only this fallback could ever have claimed one.
  //
  // The candidates are pre-filtered (see MissionIssueIndex) but the loop is
  // otherwise the fixpoint it always was, walked in `issues` order: the set's
  // ITERATION ORDER is the provenance walk, and `buildFlightDeckRows` grafts
  // rows in that order before sorting them.
  let changed = startedCandidates.length > 0
  while (changed) {
    changed = false
    const missionSessions = new Set(
      sessions
        .filter((session) => ids.has(session.issueId ?? ''))
        .map((session) => session.sessionId),
    )
    for (const candidate of startedCandidates) {
      if (!ids.has(candidate.id) && missionSessions.has(candidate.startedBySession)) {
        ids.add(candidate.id)
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
 * ---------------------------------------------------------------------------
 * ONE UNIT OF WORK IS ONE TASK IN THE MISSION (POD-710)
 * ---------------------------------------------------------------------------
 *
 * THE RULE: when the mission root has real members besides itself, the root is
 * the CONTAINER BEING MEASURED and is not also a segment; when it stands alone,
 * it is the single unit. So a root with one child is `total = 1`, not 2.
 *
 * This used to count the root as one more task — "it is one, with its own
 * stage" — which is true of the issue and false of the meter. A mission of one
 * sub-issue reported two units and lit two different segments (the root running
 * and the child not started), which is the whole of the operator's complaint:
 * "if there is only one task, it still shows two points of information … that is
 * just confusing." A container's own stage is a roll-up OF its members, so
 * counting it beside them double-counts the same work and puts the bar's
 * denominator one above the number of things anyone can point at.
 *
 * Archived and deleted issues are not units either, at any level. Proposed
 * issues are not units either: they have not been accepted, the spine already
 * keeps them in their own section, and counting them as "to go" makes a
 * mission that is itself being worked read as nothing happening.
 *
 * NOR IS ANYTHING THE MISSION MERELY DISCOVERED. Membership of the DECK is
 * wider than membership of the METER — see {@link formalMemberIds} for why the
 * denominator is the formal parent-child subtree and nothing else.
 *
 * NOR IS ABANDONED WORK, at either end of the fraction (POD-1074). A cancelled
 * task is not a task the mission completed and not one it still owes; it is a
 * task the mission is no longer doing, so it leaves the count entirely rather
 * than filling the done band. That is Linear's rule and the reason its
 * Completed and Canceled categories are kept apart at all. The fallback below
 * then does the honest thing on its own: a root whose every member was
 * cancelled has nothing left to be the container OF, so it becomes the unit
 * again and the bar reports the root's own state instead of `100% done`.
 *
 * Six segments: done / run / stall / review / block / wait. The artifact's arithmetic
 * (`done` by stage, `run` by stage, `review` by stage, `block` by state, `wait` = the
 * remainder) lets one issue land in two buckets, which would push the bar past 100%.
 * Classification here is EXCLUSIVE in the order done → block → review → run/stall
 * → wait: blocked work is not running, and review work is an obligation rather
 * than execution.
 *
 * `wait` IS THE REMAINDER, AND IT USED TO SWALLOW STAGES (POD-1181). `run` matched
 * `in_progress` alone, so `planning` and `shipping` fell through to the remainder
 * and the gauge said `to go` — "nobody has picked this up" — about a task with an
 * agent designing in it, and about one already in Shipping's custody. See
 * {@link UNDERWAY}: the run bucket is every stage that says work has begun, which
 * is also what `deckIssueState` and `operationalState` already read `shipping` as,
 * so the meter and the strips can no longer disagree about the same task.
 *
 * `run` THEN SPLIT IN TWO (POD-1314). Reading the stage alone, the bar said
 * `1 UNDERWAY` about a task whose agent had exited hours before — beside a crew
 * chip correctly reading `0 agents`, a strip reading `Retired` and a `no agent`
 * seat, on the same header. The stage was not wrong; the WORD was, because
 * `underway` is a claim about execution and the only thing executing is a
 * session. So a started task with nobody on it leaves `run` for {@link
 * MissionProgress.stall}, which is the state {@link presenceNote} already names
 * (`Agent left · choose a handoff`) and the state the empty seat is drawn for.
 *
 *   NOBODY IS COUNTED PER SUBTREE, not per issue. A container in a started stage
 *   whose CHILD holds the working agent is not stalled — the work under it is
 *   moving — so the predicate is "no open session on this task or anything
 *   beneath it". The same {@link openSession} presence rule the roster, the
 *   strips and the crew chip use, so all four answer one question one way.
 *
 *   `shipping` IS NEVER STALLED. It is the one started stage whose work is not a
 *   session's: the shipping service has custody (`presenceNote`), and a
 *   sessionless shipping task is exactly what that stage looks like when it is
 *   working correctly.
 */
export function missionProgress(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string | null | undefined,
): MissionProgress {
  const empty = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
  if (!rootId) return empty
  const ids = missionIssueIds(issues, rootId, sessions)
  const scope = issues.filter((issue) => ids.has(issue.id) && !issue.archived && !issue.deletedAt)
  // The units are the accepted members; the root only becomes one when it has
  // no accepted members to be the container of. Proposed work is offered, not
  // remaining — leaving it in `members` is how a working parent with three
  // discoveries read as "3 to go". A root that is itself archived is already
  // out of `scope`, so the fallback never resurrects it.
  const byId = new Map<string, IssueNavigationModel>(issues.map((issue) => [issue.id, issue]))
  const formal = formalMemberIds(issues, rootId)
  const members = scope.filter(
    (issue) => formal.has(issue.id) && issue.stage !== 'proposed' && !issueAbandoned(issue),
  )
  // The root can be abandoned too, and then there is nothing to measure at all
  // rather than one cancelled unit sitting in a band of its own.
  const units = (
    members.length > 0 ? members : scope.filter((issue) => issue.id === rootId)
  ).filter((issue) => {
    if (issueAbandoned(issue)) return false
    const own = sessions.filter((session) => session.issueId === issue.id)
    return !isVacatedOrigin(issue, own, byId)
  })
  const staffed = staffedSubtreeIds(issues, sessions)
  let done = 0
  let run = 0
  let review = 0
  let stall = 0
  let block = 0
  for (const issue of units) {
    if (issueClosed(issue)) done += 1
    else if (issue.blocked) block += 1
    else if (issue.stage === 'review') review += 1
    else if (UNDERWAY.has(issue.stage)) {
      // Shipping's work is the service's, not a session's — see the note above.
      if (issue.stage === 'shipping' || staffed.has(issue.id)) run += 1
      else stall += 1
    }
  }
  const total = units.length
  return {
    total,
    done,
    run,
    review,
    stall,
    block,
    wait: Math.max(0, total - done - run - review - stall - block),
  }
}

/**
 * Every issue that has an open session ON it or ANYWHERE BENEATH it.
 *
 * Built once per call rather than walked per unit: a mission's units are its
 * whole formal subtree, so the per-unit walk is quadratic on exactly the deep
 * missions this is asked about most. One pass marks the issues that hold a
 * session, a second walks each marked issue's ancestor chain — which stops at
 * the first already-marked ancestor, so the whole thing is linear in the tree.
 */
function staffedSubtreeIds(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
): Set<string> {
  const parents = new Map<string, string>()
  for (const issue of issues) if (issue.parentId) parents.set(issue.id, issue.parentId)
  const staffed = new Set<string>()
  for (const session of sessions) {
    if (!session.issueId || !openSession(session)) continue
    let id: string | undefined = session.issueId
    while (id && !staffed.has(id)) {
      staffed.add(id)
      id = parents.get(id)
    }
  }
  return staffed
}

/**
 * What the fleet chip next to the mission gauge says.
 *
 * Activity first: if anyone is computing, that is the number. Otherwise
 * presence, as "N agents" — never "live". A parked agent is on the task
 * (POD-756) and calling the total live is what taught the sidebar to hide it,
 * then taught the gauge to disagree with the one running timer (POD-763).
 */
export function missionCrewLabel(live: number, working: number): string {
  if (working > 0) return `${working} working`
  return `${live} agent${live === 1 ? '' : 's'}`
}

/** Work that was discovered here and is now running as its own task. */
export interface MissionDeparture {
  issue: IssueNavigationModel
  /** The mission member it was discovered from — the root, or a task on it. */
  originId: string
  /** What it is doing now, out there, in the spine's own state vocabulary. */
  state: DeckIssueState
}

/**
 * What LEFT this mission — the departure ticks under the spine (POD-679).
 *
 * A started spin-off is no longer a member (`hasLeftMission`), and a mission
 * that simply dropped the row would be lying by omission: the operator watched
 * an agent file that work here, and "where did it go?" has to stay answerable
 * from the surface it went missing from. So the origin keeps ONE LINE per
 * departure — provenance without membership. It is not a task: it holds no
 * seat, wears no mark, and carries no weight in `missionProgress`.
 *
 * FINISHED DEPARTURES ARE DROPPED when the origin still has a session — the
 * tick exists so the operator can find work that is still happening somewhere
 * else, and a done spin-off is then answered by the issue's own Relations
 * block. An EMPTY origin is different: dropping the finished hop is what left
 * POD-959 silent after the session moved on to a grandchild. In that case the
 * tick names the live tip, even if every hop in between is done.
 */
export function missionDepartures(
  issues: readonly IssueNavigationModel[],
  sessions: readonly SessionMeta[],
  rootId: string | null | undefined,
  allWorktreePaths: readonly string[] = [],
): MissionDeparture[] {
  if (!rootId) return []
  const ids = missionIssueIds(issues, rootId, sessions)
  const sessionList = [...sessions]
  const worktreePaths = [...allWorktreePaths]
  const byId = new Map<string, IssueNavigationModel>(issues.map((issue) => [issue.id, issue]))
  const out: MissionDeparture[] = []
  const seen = new Set<string>()
  for (const origin of issues) {
    if (!ids.has(origin.id) || origin.archived || origin.deletedAt) continue
    const tip = liveSpinOffTip(origin, byId, sessions)
    if (!tip || ids.has(tip.id) || seen.has(tip.id)) continue
    const originSessions = sessionsForIssue(origin, sessionList, worktreePaths)
    const originEmpty = !originSessions.some(openSession)
    if (!originEmpty && (tip.stage === 'done' || tip.closedReason)) continue
    seen.add(tip.id)
    out.push({
      issue: tip,
      originId: origin.id,
      state: deckIssueState(tip, sessionsForIssue(tip, sessionList, worktreePaths), byId),
    })
  }
  return out.sort((a, b) => a.issue.seq - b.issue.seq)
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
    if (mode === 'active') return !issueClosed(issue) || ownSessions.some(sessionWorking)
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
    rows.push({
      issue,
      depth,
      sessions: sessionsByIssue.get(id) ?? [],
      descendantIds,
      actionableCount,
      liveAgentCount: subtreeSessions.filter(openSession).length,
      workingAgentCount: subtreeSessions.filter(sessionWorking).length,
      matched: selfMatches(issue),
      collapsedSummary: {
        tasks: hidden.length,
        // The fold's own two-colour meter, and the same rule the mission gauge
        // follows: abandoned work is not work this branch completed, so it is
        // not painted in the success tier. It stays in `tasks`, because the
        // fold really is hiding that many rows.
        done: hidden.filter((child) => issueClosed(child) && !issueAbandoned(child)).length,
        // This meter's `run` is "started and not done", which is why it takes
        // `review` as well — so it takes every {@link UNDERWAY} stage too, and for
        // the same reason the gauge does (POD-1181): a folded branch hiding a
        // child in `planning` or `shipping` counted it in `tasks` and in neither
        // tier, which paints picked-up work into the trough.
        run: hidden.filter(
          (child) =>
            !child.closedReason && (UNDERWAY.has(child.stage) || child.stage === 'review'),
        ).length,
        kinds: [...new Set(subtreeSessions.filter(openSession).map((s) => s.agentKind))].slice(
          0,
          2,
        ),
        crew: deckCrew(subtreeSessions),
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
  // `done` stays the STATE — an abandoned task is over, and everything keyed on
  // that (the dim tier, the sort) is right about it. Only the WORD was wrong.
  if (issueClosed(issue))
    return { state: 'done', label: issueAbandoned(issue) ? 'Cancelled' : 'Done' }
  if (issue.stage === 'shipping') return { state: 'working', label: 'Shipping' }
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
  | 'cancelled'
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
  // The strip already draws the cancel mark (`issueStatusOf` → `StatusGlyph`).
  // Printing `Done` beside it made the row contradict itself in two glyphs'
  // worth of space; this is the word that mark has always meant.
  cancelled: 'Cancelled',
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
  if (issueAbandoned(issue)) return at('cancelled')
  if (issueClosed(issue)) return at('done')
  if (issue.stage === 'shipping') return at('working')
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
 * task lists only the agents that actually stopped. When the TASK itself is the
 * exception (review, an explicit `needsHuman`) and no session is asking, every
 * session stays: that row IS the thing needing a decision, and hiding its crew
 * would leave it claiming to be unattended when it is not.
 *
 * A CONTEXT ROW SHOWS NO AGENTS AT ALL (POD-1245). The rule above used to run on
 * every row, and a row kept purely as the PATH to a match has nothing asking on
 * it — so it fell through to "every session stays" and arrived carrying its full
 * crew. On a three-deep mission `Needs you` was one stopped agent underneath a
 * parade of busy ones, which reads as the filter having done nothing. The path
 * still draws — {@link FlightDeckRow.matched} is what separates the two — but it
 * draws as scaffolding.
 */
export function deckSessions(
  row: Pick<FlightDeckRow, 'issue' | 'sessions' | 'matched'>,
  mode: FlightDeckMode,
): SessionMeta[] {
  if (mode !== 'needs-you') return row.sessions
  if (!row.matched) return []
  const asking = row.sessions.filter((session) => sessionAsksOnIssue(row.issue, session))
  return asking.length > 0 ? asking : row.sessions
}

/*
 * `rootRoster` LIVED HERE AND IS GONE (POD-758).
 *
 * The mission header's roster used to fold its finished agents away behind an
 * "N finished agents" line, because every session the mission ever had hangs
 * off the header and on a long mission that was a screen of retired rows before
 * the first task. The redesign answers the same problem one level up instead:
 * nothing in the spine is hidden by default, settled agents stay at full height
 * one tier dimmer, and what removes them is the view bar — `Full spine`,
 * `Active`, `Needs you`. A second, in-view disclosure that hid what the chosen
 * view had promised to show was the duplication.
 */

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
  | { kind: 'spawned'; parentSessionId: SessionId }

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
  | 'shipping'

export interface PresenceNote {
  kind: PresenceKind
  text: string
  /** Amber: this row is asking something of the operator. */
  attention: boolean
}

/**
 * The forward lifecycle edge of work that no longer belongs on this issue.
 *
 * `discovered-from` explains where an issue came FROM; this explains where the
 * operator should go NEXT. Keeping those directions separate matters on an
 * empty superseded task: the backward provenance is true, but it is not the
 * answer to "where did the agent go?".
 *
 * The target is optional because a scoped replica may know that the issue was
 * replaced without being allowed to see its replacement. In that case the UI
 * still explains the lifecycle without leaking an internal id.
 */
export interface IssueContinuation {
  kind: 'superseded' | 'duplicate' | 'spinoff'
  target?: IssueNavigationModel
  short: string
  full: string
  /**
   * The sidebar's density: a status PHRASE, not a sentence (POD-1193).
   *
   * Line 2 of a work row is ~22 mono characters, so `full` ("Work continued in
   * POD-1192") ellipsized away the ref — the only part of it that is a route.
   * This keeps the ref and spends the rest on one word, in the same
   * `verb · subject` grammar the merge decision already uses.
   */
  line: string
}

export function issueContinuation(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
  sessions: readonly SessionMeta[] = [],
): IssueContinuation | null {
  const targetId = issue.supersededBy ?? issue.duplicateOf
  if (targetId) {
    const target = byId?.get(targetId)
    const ref = target ? issueDisplayRef(target) : 'another task'
    return issue.supersededBy
      ? {
          kind: 'superseded',
          ...(target ? { target } : {}),
          short: ref,
          full: `Work continued in ${ref}`,
          line: `continued · ${ref}`,
        }
      : {
          kind: 'duplicate',
          ...(target ? { target } : {}),
          short: ref,
          full: `The same work is tracked in ${ref}`,
          line: `duplicate · ${ref}`,
        }
  }
  // Hopscotch: the session left, and a started spin-off is where it went.
  // Do not fire while an agent is still on THIS task — that is a real mission
  // that also discovered something, not a signpost. `sessions` may be the
  // replica-wide slice (the flight deck passes that), so membership is
  // issueId, not "any live session in the list".
  if (sessions.some((session) => session.issueId === issue.id && openSession(session))) return null
  const tip = liveSpinOffTip(issue, byId, sessions)
  if (!tip) return null
  const ref = issueDisplayRef(tip)
  return {
    kind: 'spinoff',
    target: tip,
    short: ref,
    full: `Work continued in ${ref}`,
    line: `continued · ${ref}`,
  }
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
  /**
   * Sessions ANYWHERE, for reading where the work went — `sessions` is this
   * issue's own, and a hop's destination by definition holds none of them.
   * Defaults to the narrow list so a caller with nothing wider still gets the
   * stage-based answer; pass the slice to also catch a spin-off that has an
   * agent on it but no stage yet ({@link staffedSpinOff}).
   */
  allSessions: readonly SessionMeta[] = sessions,
): PresenceNote | null {
  if (sessions.some(openSession)) return null
  const moved = sessions.find((session) => session.handoffTarget)
  if (moved) {
    return { kind: 'moved', text: `Session moved to ${moved.handoffTarget}`, attention: false }
  }
  const continuation = issueContinuation(issue, byId, allSessions)
  if (continuation) {
    return { kind: 'moved', text: continuation.full, attention: false }
  }
  if (issue.blocked) {
    return { kind: 'blocked', text: blockedByLabel(issue, byId), attention: false }
  }
  const waiting = waitingNote(issue, byId)
  if (waiting) return { kind: 'waiting', text: waiting, attention: false }
  if (issueClosed(issue)) {
    const text = issueAbandoned(issue)
      ? 'Cancelled · session retired'
      : 'Completed · session retired'
    return { kind: 'done', text, attention: false }
  }
  if (issue.stage === 'review') {
    return { kind: 'review', text: 'Review ready · session ended', attention: false }
  }
  if (issue.stage === 'shipping') {
    return { kind: 'shipping', text: 'Shipping service has custody', attention: false }
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
/** Where a proposal will live if it is started as it stands. */
export type ProposalPlacement = 'own' | 'mission'

export interface ProposalShape {
  placement: ProposalPlacement
  /** The issue this proposal came out of, when the replica can resolve it. */
  originId: string | null
  originRef: string | null
}

/**
 * The SHAPE of a proposal: does starting it keep it here, or send it away?
 *
 * The agent that filed the work already answered this — a sub-issue is
 * decomposition its parent cannot ship without, a spin-off is independent work
 * with a `discovered-from` edge. It answered it in a CLI litmus test the
 * operator never sees, and then the operator's Start click inherited that
 * answer blind (POD-679). This is the answer, in the operator's language, so it
 * can ride on the strip and be corrected before anything runs.
 *
 * Null for a proposal that came from nowhere in particular: a top-level
 * proposal with no origin has no placement decision to state.
 */
export function proposalShape(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): ProposalShape | null {
  return issue.stage === 'proposed' ? discoveredPlacement(issue, byId) : null
}

/**
 * The same reading, at any stage — what the placement IS right now.
 *
 * `proposalShape` is the chip's gate (a strip only states a shape while the
 * decision is still open). The controls need the answer for work that has left
 * `proposed` too: promoting a proposal to backlog does not decide where it
 * lives, and a placement chosen wrongly stays correctable after it starts.
 */
export function discoveredPlacement(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
): ProposalShape | null {
  const refOf = (id: string | null | undefined): string | null => {
    const target = id ? byId?.get(id) : undefined
    return target ? issueDisplayRef(target) : null
  }
  const spinOrigin = spinOffOriginId(issue)
  if (spinOrigin) {
    return { placement: 'own', originId: spinOrigin, originRef: refOf(spinOrigin) }
  }
  if (issue.parentId) {
    return { placement: 'mission', originId: issue.parentId, originRef: refOf(issue.parentId) }
  }
  return null
}

export interface IssueNote {
  kind: 'blocked' | 'waiting' | 'continued' | 'relation' | 'shape-own' | 'shape-mission'
  /**
   * THE RELATION, WRITTEN OUT — the small-caps half of the chip.
   *
   * A glyph cannot say *spun off from*. `↳ POD-775`, `⊘ POD-869` and
   * `→ POD-1037` are three different facts an operator has to act on
   * differently, and asking them to remember which arrow means which is the
   * one thing a two-word label makes unnecessary. So the chip prints the
   * relation and then the ref, and the whole sentence stays on `full`.
   *
   * Null when `short` is ALREADY the whole phrase — a block with no resolvable
   * edge, where the authored prose is the only thing there is to print.
   */
  label: string | null
  /** What the strip prints beside the label: a display ref, a count, or the
   *  authored prose. */
  short: string
  /** The sentence, for the hover title and the accessible name. */
  full: string
}

export function issueNote(
  issue: IssueNavigationModel,
  byId?: ReadonlyMap<string, IssueNavigationModel>,
  sessions: readonly SessionMeta[] = [],
): IssueNote | null {
  const continuation = issueContinuation(issue, byId, sessions)
  if (continuation) {
    return {
      kind: 'continued',
      label: 'continued in',
      short: continuation.short,
      full: continuation.full,
    }
  }
  const refs = waitingRefs(issue, byId)
  const many = (): string => `${refs.length} tasks`
  if (issue.blocked) {
    const full = blockedByLabel(issue, byId)
    // No resolvable edge leaves only the authored prose, which IS the short form
    // — a chip reading "Blocked by" with nothing after it names nothing.
    const named = refs.length > 0
    return {
      kind: 'blocked',
      label: named ? 'blocked by' : null,
      short: refs.length === 1 ? (refs[0] as string) : named ? many() : full,
      full,
    }
  }
  if (refs.length > 0) {
    return {
      kind: 'waiting',
      label: 'waiting for',
      short: refs.length === 1 ? (refs[0] as string) : many(),
      full: waitingNote(issue, byId) as string,
    }
  }
  // A PROPOSAL SAYS WHERE IT WILL LAND, not where it came from. The provenance
  // chip ("Discovered from POD-516") is a fact about the past; the operator
  // reading this strip is about to decide the future, and the sentence names
  // the consequence rather than the edge type that encodes it.
  const shape = proposalShape(issue, byId)
  if (shape) {
    const origin = shape.originRef
    return shape.placement === 'own'
      ? {
          kind: 'shape-own',
          label: 'starts',
          short: 'on its own',
          full: origin
            ? `Starts on its own — ${origin} can close without it`
            : 'Starts on its own — the task that found it can close without it',
        }
      : {
          kind: 'shape-mission',
          label: 'starts',
          short: 'in this mission',
          full: origin
            ? `Part of ${origin} — that task is not done until this is`
            : 'Part of the task that found it — that task is not done until this is',
        }
  }
  const edge = relationEdge(issue, byId)
  // The edge's own verb IS the label — "Discovered from", "Related to" — so the
  // chip never invents a second vocabulary for a relation the model has already
  // named.
  return edge
    ? { kind: 'relation', label: edge.verb, short: edge.ref, full: `${edge.verb} ${edge.ref}` }
    : null
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
  const add = (issueId: IssueId, session: SessionMeta): void => {
    const list = byIssue.get(issueId) ?? []
    list.push(session)
    byIssue.set(issueId, list)
  }
  const memberOf = new Map<SessionId, IssueId>()
  for (const issue of issues) {
    for (const sessionId of issue.memberSessionIds ?? [])
      memberOf.set(asSessionId(sessionId), asIssueId(issue.id))
  }
  for (const session of sessions) {
    if (session.archived) continue
    const owner = session.issueId ?? memberOf.get(session.sessionId)
    if (owner) add(asIssueId(owner), session)
  }
  return issues.filter((issue) => issueIsActionable(issue, byIssue.get(issue.id) ?? [])).length
}

/**
 * One task, asking something of the operator right now — the predicate behind
 * every attention count in the product.
 *
 * Exported because the number has to be the same number wherever it appears:
 * the rail badge counts it over the portfolio, the issue explorer's "Needs you"
 * tab lists exactly the tasks it returns true for. Two surfaces re-deriving
 * "needs me" independently is how a badge reading 3 comes to sit above a list
 * of 5.
 */
export function issueIsActionable(
  issue: IssueNavigationModel,
  sessions: readonly SessionMeta[],
): boolean {
  return (
    !issue.archived &&
    !issue.deletedAt &&
    issue.stage !== 'done' &&
    !issue.closedReason &&
    issueNeedsHuman(issue, sessions)
  )
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
