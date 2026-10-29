import { missionTaskBucket, type MissionTaskBucket } from '@podium/client-core/values'
import { type CoordinatedSeat, coordinatedSeat, coordinatorLive, NO_INTERACTIONS, type SeatInteractions, type SeatRole, type SeatSessionFacts, taskOwnAsks } from '@podium/model/browser'
import { isFinished } from '../shared/predicates'
/**
 * The row roll-ups: `phase`, `working`, `asking`,
 * `progressDone` / `progressTotal` and `workingSince` (L1b, spec §3 R-SUM and
 * R-ROLL, corrected by L1d), as a COMPOSITION over declared relations.
 *
 * THE COMBINE FUNCTIONS HAVE NO STORE. `aggregate({ own, children })` and
 * `unitsOf({ children })` take values and return a value; they cannot reach
 * a row, a relation or a pool (`rollup.types.test.ts` holds that at compile
 * time). The node parts below gather their inputs: a row's own part reads its
 * own row and its own seats, and a composition reads only its children's
 * CACHED results. So a change re-runs its own row's part and then each
 * ancestor's composition once, and nothing below or beside the chain.
 *
 * TWO COMPOSITIONS, because the legacy derivation has two trees:
 *
 * - ATTENTION (`phase`, `working`, `asking`) composes over the VISIBLE
 *   subtree (L1d): a row's own seats plus the aggregates of the rows NESTED
 *   under it (`rows.ts:331-334`, `attach`). The nest children are derived
 *   per row from the nearest present ancestor by the raw `parentId`: each
 *   row's own `nested` value, read cached. A hidden
 *   issue has no row and so no own part; its visible descendants nest under
 *   the nearest visible ancestor, which is the legacy walk-past
 *   (`rows.ts:272-283`).
 * - PROGRESS (`progressDone` / `progressTotal`) composes over the declared
 *   `issue.parent` / `issue.children` relation, the formal closure
 *   `missionRollup` counts (`mission.ts:1353-1404`, members
 *   `formalMemberIds`, `mission.ts:1054`). The relation drops archived and
 *   deleted children (schema `where`, `missionParentId`), which is the legacy
 *   cut of an archived branch. The children are read from the engine's
 *   `children` bucket through the relation reader, and each child's cached
 *   unit — never a second index.
 *
 * THE ROOT, WITHOUT A WALK (audit §3.3). A session's motion phase depends on
 * the ROW being derived, not on the session's own issue: on a finished row an
 * offer-only ask is not waiting (`motionPhase(s, row.issue)`,
 * `session-status.ts:455-474`, called with the row's issue by
 * `rowMotionPhase` and `rowWaitingCount`, `row-attention.ts:45-125`). Round
 * two's hand chain stopped early on a value that ignored the root and went
 * red on an offer removal. Here every aggregate carries BOTH verdicts, the
 * one an open root reads and the one a finished root reads, so an aggregate
 * is a function of (own, children) alone and every ancestor reuses it; the
 * row picks its verdict at the end (`rollupOf`), from its own `finished`.
 *
 * COLD ROWS: A PENDING MARKER, ONE LEVEL PER WINDOW. A part that needs a
 * cold row's fields reads it through the one row reader (`loadedIssue` /
 * `seat`), which answers `LOADING` and queues the row's load; the queued rows
 * land together in the next window (`residency.ts`). The part counts a
 * PENDING marker meanwhile, and the row view shows `loading` while any marker
 * below it is pending. A cold row is ONLY its marker: nothing below it is
 * composed until it lands, so a read asks for one level of cold rows per
 * window, and a deep chain converges one level at a time.
 * - PROGRESS (operator decision 2026-09-28: load the family on demand, no
 *   server-maintained counters). A formal child that is cold (under the
 *   declared rule `unlessShown`, a closed child nothing can show) gives its
 *   unit a pending marker (`PENDING_UNIT`) and queues its load. The loads
 *   follow the reads: a drawn row's progress reads its formal children's
 *   units, so drawing it queues exactly its cold children, in one batch; a
 *   row nobody draws is read by nobody and loads nothing.
 * - ATTENTION (Ma3 addendum). A seat's verdict or a spin-off's standing on a
 *   cold row is the same marker. Under `unlessShown` a visible row and its
 *   seats are hot, so markers arise only from cold spin-offs (the review
 *   withdrawal's continuation) and transient cold rows.
 *
 * Attention remains independent for parity checks. Execution buckets use the
 * shared pure task rule and the live pool's shared issue fact.
 */

import { LOADING, type Loaded } from '../loading'
import type { RowView } from '../shared/row-view'
import { unmergedDeliveryOf } from '../shared/schema'
import type { SliceIssue, SlicePhase, SliceSession } from '../shared/slice-types'
import { issueAbandoned } from '../views'
import {
  combineSidebarSessions,
  combineSidebarSessionField,
  delegatedSidebarFacts,
  exceptionSidebarFacts,
  NO_SIDEBAR_SESSIONS,
  roleSidebarFacts,
  type SidebarSessionFacts,
  type SidebarSessionOrder,
  sidebarSessionFacts,
  sidebarSessionOrder,
  sortedSidebarSessions,
} from './sidebar-row'

// ------------------------------------------------------------ session rules

interface AgentStateRead {
  readonly phase?: unknown
  readonly since?: string
  readonly observationGap?: unknown
  readonly idle?: { readonly kind?: unknown }
}

function stateOf(session: SliceSession): AgentStateRead | undefined {
  return (session.agentState ?? undefined) as AgentStateRead | undefined
}

function idleKindOf(session: SliceSession): unknown {
  return stateOf(session)?.idle?.kind
}

/** `idleVerdictNeedsHuman` (`model/src/predicates/idle-verdict.ts`). */
function idleNeedsHuman(kind: unknown): boolean {
  return kind === 'question' || kind === 'approval' || kind === 'interrupted'
}

/** `idleVerdictFinishedTurn` (same file). */
function idleFinishedTurn(kind: unknown): boolean {
  return kind === 'done' || kind === 'open_todos'
}

function busy(session: SliceSession): boolean {
  return (session as { readonly busy?: unknown }).busy === true
}

/**
 * `attentionGroup` (`client-core/src/focus.ts:25-60`); `withOffer: false`
 * asks it as if the session had no standing offer (`hasNonOfferNeedsYou`).
 */
export function attentionGroup(
  session: SliceSession,
  withOffer = true,
): 'needsYou' | 'working' | 'idle' {
  if (withOffer && session.offer) return 'needsYou'
  const phase = stateOf(session)?.phase
  if (phase === 'needs_user' || phase === 'errored') return 'needsYou'
  if (phase === 'idle') return idleNeedsHuman(idleKindOf(session)) ? 'needsYou' : 'idle'
  if (phase === 'working' || phase === 'compacting') {
    return session.status === 'exited' || session.status === 'hibernated' ? 'idle' : 'working'
  }
  if (session.agentKind === 'shell') return busy(session) ? 'working' : 'idle'
  return session.status === 'live' ||
    session.status === 'starting' ||
    session.status === 'reconnecting'
    ? 'working'
    : 'idle'
}

/** `agentBadge(meta).tone` on an unfinished issue (`session-status.ts:154-230`). */
function badgeTone(session: SliceSession): string | null {
  if (session.offer) return 'attention'
  const state = stateOf(session)
  if (state === undefined) return null
  switch (state.phase) {
    case 'unknown':
      return state.observationGap ? 'muted' : null
    case 'working':
    case 'compacting':
      return 'working'
    case 'idle': {
      const kind = idleKindOf(session)
      return kind === 'question' || kind === 'approval' ? 'attention' : 'idle'
    }
    case 'needs_user':
      return 'attention'
    case 'errored':
      return 'error'
    case 'ended':
      return 'muted'
    default:
      return null
  }
}

/** `isSessionWorking` = `sessionDotTone(s) === 'working'` (`session-status.ts:361-386, 428`). */
export function isSessionWorking(session: SliceSession): boolean {
  if (session.status === 'exited') return false
  if (session.status === 'starting' || session.status === 'reconnecting') return false
  const tone = badgeTone(session)
  if (tone !== null) return tone === 'working' && session.status !== 'hibernated'
  return session.agentKind === 'shell' && busy(session)
}

/** `hasNonOfferNeedsYou` (`session-status.ts:491-495`). */
function hasNonOfferNeedsYou(session: SliceSession): boolean {
  return attentionGroup(session, false) === 'needsYou'
}

/** `isOfferOnlyAttention` (`session-status.ts:484-486`). */
export function isOfferOnlyAttention(session: SliceSession): boolean {
  return Boolean(session.offer) && !hasNonOfferNeedsYou(session)
}

/**
 * `motionPhase(s, rowIssue)` (`session-status.ts:455-474`), with the row's
 * issue reduced to the one fact it reads: whether the ROW is finished.
 */
export function motionPhase(session: SliceSession, rowFinished: boolean, executing: () => boolean = () => isSessionWorking(session)): SlicePhase {
  if (attentionGroup(session) === 'needsYou') {
    if (!(rowFinished && session.offer && !hasNonOfferNeedsYou(session))) return 'waiting'
  }
  const state = stateOf(session)
  if (state?.phase === 'ended' || (state?.phase === 'idle' && idleFinishedTurn(state.idle?.kind))) {
    return 'done'
  }
  if (executing()) return 'working'
  return 'queued'
}

/**
 * A seat's verdict in one role on a coordinated task (POD-2171): the model's
 * `coordinatedSeat`, the one derivation, in the sidebar's terms. Its work is
 * read apart from any ask; it waits only when the role lets its ask reach the
 * human, and from when that began.
 */
export interface RoleVerdict {
  readonly phase: SlicePhase
  readonly working: boolean
  readonly workingSinceMs: number | null
  readonly waitingSinceMs: number | null
  readonly errorClass: string | null
}

export function roleVerdictOf(seat: CoordinatedSeat, stateSinceMs: number): RoleVerdict {
  const since = Number.isFinite(stateSinceMs) ? stateSinceMs : null
  return {
    phase: seat.asks ? 'waiting' : seat.done ? 'done' : seat.working ? 'working' : 'queued',
    working: seat.working,
    workingSinceMs: seat.working ? since : null,
    waitingSinceMs: seat.asks ? (seat.asksSince ?? since) : null,
    errorClass: seat.errorClass,
  }
}

/** `sessionPresentOnTask` (`fleet.ts:36`, mission.ts's `openSession`). */
export function presentOnTask(session: {
  readonly archived?: boolean
  readonly exited: boolean
}): boolean {
  return session.archived !== true && !session.exited
}

// ------------------------------------------------------------ one seat

/** One seat's contribution, under either kind of row. Per session, cached. */
export interface SeatVerdict {
  /** `motionPhase` under an open (unfinished) row. */
  readonly open: SlicePhase
  /** `motionPhase` under a finished row: an offer-only ask is not waiting. */
  readonly finished: SlicePhase
  /** The seat in each role on a coordinated task (POD-2171): what `asRoleSeat` shows. */
  readonly roles: { readonly coordinator: RoleVerdict; readonly delegate: RoleVerdict }
  /** Neither archived nor exited: as a coordinator, it is live (`coordinatorLive`). */
  readonly present: boolean
  /** `isSessionWorking`. */
  readonly working: boolean
  /**
   * `workingSinceMs` (`time-indicators.tsx:34-43`, the oracle's
   * `workingSinceOf`): `agentState.since ?? lastActiveAt` while working.
   */
  readonly workingSinceMs: number | null
  /**
   * The seat's id. POD-5423 (review finding 9): roll-ups carry ids, never the
   * row object, so a heartbeat (a new row object) does not travel up the nest.
   */
  readonly id?: string
  readonly sidebarFacts?: SidebarSessionFacts
  readonly sidebarOrder?: SidebarSessionOrder
}

/**
 * One seat's verdict. `interactions` are its open pending interactions and
 * `taskOpen` whether its own task is open: two of the seat facts the role
 * verdicts read (`coordinatedSeat`).
 */
export function seatVerdictOf(
  session: SliceSession,
  interactions: SeatInteractions = NO_INTERACTIONS,
  taskOpen = true,
): SeatVerdict {
  const working = isSessionWorking(session)
  const stateSince = Date.parse(stateOf(session)?.since ?? session.lastActiveAt)
  const role = (name: SeatRole): RoleVerdict =>
    roleVerdictOf(coordinatedSeat(session as SeatSessionFacts, name, interactions, taskOpen), stateSince)
  const roles = { coordinator: role('coordinator'), delegate: role('delegate') }
  return {
    open: motionPhase(session, false),
    finished: motionPhase(session, true),
    roles,
    present: coordinatorLive(session),
    working,
    workingSinceMs: working && Number.isFinite(stateSince) ? stateSince : null,
    id: session.sessionId,
    sidebarFacts: sidebarSessionFacts(session, roles.delegate),
    sidebarOrder: sidebarSessionOrder(session),
  }
}

// ------------------------------------------------------------ attention

/** What a set of seats says under one kind of root (`aggregateMotionPhase`'s inputs). */
export interface PhaseFlags {
  /** Some seat is `waiting`. */
  readonly waiting: boolean
  /** Some seat is `working`. */
  readonly working: boolean
  /** Every seat is `done` (true for no seats; `rollupOf` pairs it with `seated`). */
  readonly allDone: boolean
}

/**
 * The attention roll-up of a row's visible subtree, or of one row's own part
 * (the same shape: a row alone is a subtree of one). Plain data.
 */
export interface Aggregate {
  /** Rail badge facts, composed with attention rather than walking descendants. */
  readonly railWaiting?: {
    readonly open: number
    readonly finished: number
    readonly decisions: number
    /** Seats waiting as delegates (exceptions only): the counts `asDelegated` shows. */
    readonly delegated: number
  }
  /**
   * Its seats' ids (`rowSessions(row)`, by id): own seats in sidebar order,
   * then each nest child's. A row reads the rows it draws by id.
   */
  readonly sessionIds?: readonly string[]
  readonly sidebarFacts?: SidebarSessionFacts
  readonly updatedAt?: string
  readonly order?: { sortKey?: string | null; createdAt: string; seq: number; id: string }
  readonly decidingAt?: number
  readonly seated: boolean
  /** Some seat computing (`rowHasWorkingSession`, `row-attention.ts:95-97`). */
  readonly working: boolean
  /** Some row in it awaits a decision (`pendingDecisionStats(row).count > 0`). */
  readonly deciding: boolean
  /** The seats' verdicts under an open root. */
  readonly open: PhaseFlags
  /** The seats' verdicts under a finished root. */
  readonly finished: PhaseFlags
  /**
   * Every seat's verdict as a DELEGATE (`SeatVerdict.delegate`), over the
   * whole subtree whatever its own coordination: what it shows a parent whose
   * coordinator is live (`asDelegated`).
   */
  readonly delegated: PhaseFlags
  /** Cold rows it could not read yet (queued): the row shows `loading`. */
  readonly pending: number
  /** On a row's own part only: see `OwnAttention.coordinated`. */
  readonly coordinated?: boolean
}

/** A row's own part: its own seats and decision, plus its own working stamp. */
export interface OwnAttention extends Aggregate {
  /** The sorted own roster's head, reused by issue-only sidebar redraws. */
  readonly firstSessionId?: string | null
  /** The earliest working seat's start on THIS row (not rolled up: the oracle reads own seats). */
  readonly workingSince: number | null
  /** Its row is cold: the part is only a pending marker, and nothing below it is composed yet. */
  readonly cold: boolean
  /**
   * Its row's coordinator is live (POD-2171, `coordinatorLive`): its other
   * seats count as delegates here, and `aggregate` shows its nest children
   * `asDelegated`.
   */
  readonly coordinated: boolean
}

const NO_FLAGS: PhaseFlags = { waiting: false, working: false, allDone: true }

/** No seats, no decision, nothing pending: a row that is not on screen, or has nothing. */
export const EMPTY_OWN: OwnAttention = {
  seated: false,
  working: false,
  deciding: false,
  open: NO_FLAGS,
  finished: NO_FLAGS,
  delegated: NO_FLAGS,
  pending: 0,
  workingSince: null,
  cold: false,
  coordinated: false,
}

/** A row whose own row is cold: nothing known yet, one marker pending. */
export const PENDING_OWN: OwnAttention = { ...EMPTY_OWN, pending: 1, cold: true }

function flagsWith(flags: PhaseFlags, phase: SlicePhase): PhaseFlags {
  return {
    waiting: flags.waiting || phase === 'waiting',
    working: flags.working || phase === 'working',
    allDone: flags.allDone && phase === 'done',
  }
}

/** Fold one seat's flags and facts into a row's own part. */
export function withSeat(own: OwnAttention, seat: SeatVerdict): OwnAttention {
  const since =
    seat.workingSinceMs !== null &&
    (own.workingSince === null || seat.workingSinceMs < own.workingSince)
      ? seat.workingSinceMs
      : own.workingSince
  // The seat's id is the caller's to place (`ownAttentionPartOf` sorts them once).
  return {
    ...own,
    seated: true,
    sidebarFacts: combineSidebarSessions(
      own.sidebarFacts ?? NO_SIDEBAR_SESSIONS,
      seat.sidebarFacts ?? NO_SIDEBAR_SESSIONS,
    ),
    working: own.working || seat.working,
    open: flagsWith(own.open, seat.open),
    finished: flagsWith(own.finished, seat.finished),
    delegated: flagsWith(own.delegated, seat.roles.delegate.phase),
    workingSince: since,
  }
}

/**
 * A seat as a coordinated row shows it (POD-2171): in its role there, the
 * coordinator or a delegate, from its role verdict alone. Its phase is the
 * same under an open or a finished row (a role verdict has no offer-only
 * case), and its timers and error line are the role's. A view over the seat.
 */
export function asRoleSeat(seat: SeatVerdict, role: SeatRole): SeatVerdict {
  return {
    get open() { return seat.roles[role].phase },
    get finished() { return seat.roles[role].phase },
    get roles() { return seat.roles },
    get present() { return seat.present },
    get working() { return seat.roles[role].working },
    get workingSinceMs() { return seat.roles[role].workingSinceMs },
    get id() { return seat.id },
    get sidebarFacts() {
      const facts = seat.sidebarFacts
      return facts === undefined ? undefined : roleSidebarFacts(facts, seat.roles[role])
    },
    get sidebarOrder() { return seat.sidebarOrder },
  }
}

/** The role a seat holds on a row whose live coordinator is `coordinator` (null: the row is not coordinated). */
function roleOn(coordinator: string | null, id: string | undefined): SeatRole | null {
  return coordinator === null ? null : id === coordinator ? 'coordinator' : 'delegate'
}

/**
 * A row's seats off its roster whose exception still stands (`exceptionSeatIds`:
 * exited, not archived, crashed). Admitted by the task's and the session's
 * lifecycle, never by the display retention window: the delegate role verdict
 * already asks nothing once the seat's task closed. They add only that
 * exception (POD-2171): to what the row shows a coordinated parent, and on a
 * coordinated row to the row's own asks. A cold one is skipped, not counted
 * pending; reading it queues its load.
 */
export function* exceptionSeatsOf(
  input: Pick<RollupInputs, 'seat'>,
  self: { readonly exceptionSeatIds?: readonly string[] },
): Iterable<SeatVerdict> {
  for (const id of self.exceptionSeatIds ?? []) {
    const seat = input.seat(id)
    if (seat !== LOADING && seat !== undefined && seat.roles.delegate.phase === 'waiting') yield seat
  }
}

/** A flag set with `waiting` raised. */
function waitingWith(flags: PhaseFlags): PhaseFlags {
  return flags.waiting ? flags : { ...flags, waiting: true }
}

/**
 * The live coordinator of a row (POD-2171): its `coordinatorSessionId` when
 * that session is resident and live (`SeatVerdict.present`). The coordinator
 * may sit on another row (a parent's coordinator holds its children's seats).
 * A cold or unknown coordinator is not live: a session nothing has kept hot
 * has exited or been archived.
 */
export function liveCoordinatorOf(input: Pick<RollupInputs, 'seat'>, facts: OwnFacts): string | null {
  const id = facts.state === 'ready' ? facts.coordinatorSessionId : undefined
  if (!id) return null
  const seat = input.seat(id)
  return seat !== LOADING && seat !== undefined && seat.present ? id : null
}

/**
 * THE COORDINATED RULE'S ONE STEP (POD-2171, `seat-attention.ts`):
 * what a nest child shows a parent whose coordinator is live. Its work, seats,
 * activity and exceptions pass; its asks do not. Its seats read as delegates,
 * its decision is the coordinator's to take, and its waiting counts and timer
 * keep only exceptions. A view over the child, so a live reader still reads
 * only the fields it asks for.
 */
export function asDelegated(part: Aggregate): Aggregate {
  return {
    get railWaiting() {
      const counts = part.railWaiting
      if (counts === undefined) return undefined
      const waiting = counts.delegated
      return { open: waiting, finished: waiting, decisions: 0, delegated: waiting }
    },
    get sessionIds() { return part.sessionIds },
    get sidebarFacts() {
      const facts = part.sidebarFacts
      return facts === undefined ? undefined : delegatedSidebarFacts(facts)
    },
    get updatedAt() { return part.updatedAt },
    get order() { return part.order },
    decidingAt: undefined,
    get seated() { return part.seated },
    // Its delegates' work, read apart from their suppressed offers.
    get working() { return part.delegated.working },
    deciding: false,
    get open() { return part.delegated },
    get finished() { return part.delegated },
    get delegated() { return part.delegated },
    get pending() { return part.pending },
  }
}

function joinFlags(a: PhaseFlags, b: PhaseFlags): PhaseFlags {
  return {
    waiting: a.waiting || b.waiting,
    working: a.working || b.working,
    allDone: a.allDone && b.allDone,
  }
}

/**
 * THE COMBINE: a row's visible-subtree aggregate from its own part and its
 * nest children's aggregates (`rowSessions` = own sessions plus attached
 * children's aggregate sessions, `rows.ts:331-334`). Under a live coordinator
 * (`own.coordinated`) each child is read `asDelegated`. No store, no row, no
 * relation: values in, a value out.
 */
export function aggregate(input: {
  readonly own: Aggregate
  readonly children: readonly Aggregate[]
}): Aggregate {
  let { seated, working, deciding, open, finished, delegated, pending } = input.own
  const sessionIds = [...(input.own.sessionIds ?? [])]
  let sidebarFacts = input.own.sidebarFacts ?? NO_SIDEBAR_SESSIONS
  let updatedAt = input.own.updatedAt ?? ''
  let decidingAt = input.own.decidingAt
  let railWaiting = input.own.railWaiting ?? { open: 0, finished: 0, decisions: 0, delegated: 0 }
  for (const nested of input.children) {
    const child = input.own.coordinated === true ? asDelegated(nested) : nested
    sessionIds.push(...(child.sessionIds ?? []))
    sidebarFacts = combineSidebarSessions(sidebarFacts, child.sidebarFacts ?? NO_SIDEBAR_SESSIONS)
    if ((child.updatedAt ?? '') > updatedAt) updatedAt = child.updatedAt ?? ''
    if (
      child.decidingAt !== undefined &&
      (decidingAt === undefined || child.decidingAt < decidingAt)
    )
      decidingAt = child.decidingAt
    seated ||= child.seated
    working ||= child.working
    deciding ||= child.deciding
    open = joinFlags(open, child.open)
    finished = joinFlags(finished, child.finished)
    delegated = joinFlags(delegated, child.delegated)
    pending += child.pending
    if (child.railWaiting)
      railWaiting = {
        open: railWaiting.open + child.railWaiting.open,
        finished: railWaiting.finished + child.railWaiting.finished,
        decisions: railWaiting.decisions + child.railWaiting.decisions,
        delegated: railWaiting.delegated + child.railWaiting.delegated,
      }
  }
  return {
    seated,
    working,
    deciding,
    open,
    finished,
    delegated,
    pending,
    sessionIds,
    sidebarFacts,
    updatedAt,
    decidingAt,
    railWaiting,
  }
}

/**
 * `rowWaitingCount(row) > 0` (`row-attention.ts:116-125`): a pending decision,
 * or a seat waiting under this row. The offer-only dedupe only lowers a count
 * that the decision already makes positive, so it never changes this boolean.
 */
export function askingOf(agg: Aggregate, rowFinished: boolean): boolean {
  return agg.deciding || (rowFinished ? agg.finished : agg.open).waiting
}

/** `rowMotionPhase` (`row-attention.ts:45-65`) over the aggregate. */
export function phaseOf(agg: Aggregate, rowFinished: boolean): SlicePhase {
  if (agg.deciding) return 'waiting'
  if (!agg.seated && rowFinished) return 'done'
  const flags = rowFinished ? agg.finished : agg.open
  if (flags.waiting) return 'waiting'
  if (flags.working) return 'working'
  // All seats done: only a finished row wears `done` (`row-attention.ts:57-63`).
  return agg.seated && flags.allDone && rowFinished ? 'done' : 'queued'
}

// ------------------------------------------------------------ decisions

/** `issuePendingDecision` (`slices/issues.ts:391-404`); `merge` reads the merge axis off the composed row. */
export function pendingDecisionOf(issue: SliceIssue): 'review' | 'merge' | null {
  const finished = isFinished(issue)
  if (!finished && issue.stage !== 'review') return null
  if (issue.blocked === true) return null
  if (issueAbandoned(issue)) return null
  if (unmergedDeliveryOf(issue)) return 'merge'
  return issue.stage === 'review' ? 'review' : null
}

/** `hasLeftMission` (`mission.ts:523-525`) for an issue already known to be a spin-off. */
function leftMission(issue: SliceIssue): boolean {
  return issue.stage !== 'proposed' && issue.stage !== 'backlog'
}

/** A continuation target on the row itself (`issueContinuation`, `mission.ts:2213`). */
function continuedByField(issue: SliceIssue): boolean {
  const extra = issue as { readonly supersededBy?: unknown; readonly duplicateOf?: unknown }
  return Boolean(extra.supersededBy) || Boolean(extra.duplicateOf)
}

// ------------------------------------------------------------ progress

/** One issue's own contribution to an ancestor's progress (`computeMissionRollup`). */
export type UnitState = MissionTaskBucket

export interface UnitOwn {
  readonly state?: UnitState
  readonly staffed?: boolean
  /** Non-phase task in the accepted tree, including abandoned leaves that suppress parent fallback. */
  readonly member: boolean
  /** A non-abandoned member that is not a vacated origin; counted only without tasks below. */
  readonly unit: boolean
  /** A unit that is closed (`issueClosed`, `mission.ts:349-351`). */
  readonly done: boolean
  /** As a lone root: an accepted, non-phase, non-abandoned, non-vacated task. */
  readonly solo: boolean
  /** Its row is cold: the unit is only a pending marker (its load is queued), and nothing below it is composed yet. */
  readonly cold: boolean
}

export const NO_UNIT: UnitOwn = {
  member: false,
  unit: false,
  done: false,
  solo: false,
  cold: false,
}

/** A unit whose row is cold: nothing known yet, one marker pending. */
export const PENDING_UNIT: UnitOwn = { ...NO_UNIT, cold: true }

/**
 * Exactly the own-row fields R-ROLL's progress reads (`computeMissionRollup`:
 * `stage` for proposed and closed, `closedReason` for abandoned and closed),
 * and no more.
 */
export type ProgressFacts = Pick<SliceIssue, 'stage' | 'closedReason' | 'type'>

/** The progress counts of a formal closure (the root excluded). Plain data. */
export interface Units {
  readonly progress?: Readonly<Record<UnitState, number>>
  readonly staffed?: boolean
  readonly members: number
  readonly units: number
  readonly done: number
  /** Cold units in it whose load is queued: the counts are partial and the row shows `loading`. */
  readonly pending: number
}

export const NO_UNITS: Units = { members: 0, units: 0, done: 0, pending: 0 }

/**
 * THE PROGRESS COMBINE: a row's formal closure from each formal child's own
 * contribution and that child's own closure. A cold child is only its
 * pending marker: its closure is not asked for (the caller passes
 * `NO_UNITS`) until it lands. No store.
 */
export function unitsOf(input: {
  readonly children: readonly { readonly own: UnitOwn; readonly below: Units }[]
}): Units {
  let { members, units, done, pending } = NO_UNITS
  const progress: Record<UnitState, number> = {
    done: 0,
    working: 0,
    waiting: 0,
    todo: 0,
  }
  let staffed = false
  for (const { own, below } of input.children) {
    if (own.cold) {
      pending += 1
      continue
    }
    staffed ||= own.staffed === true || below.staffed === true
    if (own.unit && below.members === 0) progress[own.state ?? (own.done ? 'done' : 'todo')] += 1
    for (const state of Object.keys(progress) as UnitState[])
      progress[state] += below.progress?.[state] ?? 0
    members += (own.member ? 1 : 0) + below.members
    units += (own.unit && below.members === 0 ? 1 : 0) + below.units
    done += (own.done && below.members === 0 ? 1 : 0) + below.done
    pending += below.pending
  }
  return { members, units, done, pending, progress, staffed }
}

export function unitOwnOf(facts: ProgressFacts, vacated: boolean): UnitOwn {
  const gone = issueAbandoned(facts)
  const member = facts.stage !== 'proposed' && facts.type !== 'phase'
  const unit = member && !gone && !vacated
  const closed = isFinished(facts)
  return { member, unit, done: unit && closed, solo: unit, cold: false }
}

// ------------------------------------------------------------ the row

/** The roll-up fields of one row view, plus whether any of it is still loading. */
export interface Rollup
  extends Pick<
    RowView,
    'phase' | 'progressDone' | 'progressTotal' | 'working' | 'asking' | 'workingSince'
  > {
  readonly loading: boolean
  /**
   * The latest `lastActiveAt` among the seats of the row's visible subtree
   * (own seats included), or null: the row view's `activityAt` is the max of
   * this and its own-row stamp (`rows.ts:336-339`, `attach`).
   */
  readonly seatActivity: number | null
}

/**
 * A row's roll-up fields from its parts: its own `finished` picks the root
 * verdict, units come from the members when there are any, else the row
 * stands alone (`units = fromChildren ? members : [root]`, `mission.ts:1374`).
 */
export function rollupOf(input: {
  readonly finished: boolean
  readonly own: OwnAttention
  readonly agg: Aggregate
  readonly self: UnitOwn
  readonly below: Units
  readonly seatActivity: number | null
}): Rollup {
  const { finished, own, agg, self, below, seatActivity } = input
  const fromChildren = below.members > 0
  return {
    phase: phaseOf(agg, finished),
    working: agg.working,
    asking: askingOf(agg, finished),
    progressDone: fromChildren ? below.done : self.done ? 1 : 0,
    progressTotal: fromChildren ? below.units : self.solo ? 1 : 0,
    workingSince: own.workingSince,
    loading: agg.pending > 0 || below.pending > 0,
    seatActivity,
  }
}

/** THE ACTIVITY COMBINE: the latest of own seats' stamps and each nest child's. No store. */
export function latestOf(input: {
  readonly own: readonly (number | null)[]
  readonly children: readonly (number | null)[]
}): number | null {
  let latest: number | null = null
  for (const at of [...input.own, ...input.children]) {
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
}

// ------------------------------------------------------------ node parts

export { LOADING, type Loaded } from '../loading'

/** What the roll-up parts read. Tracked in the live pool; plain in the rebuild. */
export interface RollupInputs {
  readonly missionBucket?: (id: string) => MissionTaskBucket | null
  readonly tipActivityAt?: (id: string) => string | undefined
  reached?(at: number): boolean
  /** The row when resident; `LOADING` when cold (the read queues its load); undefined when unknown. */
  loadedIssue(id: string): Loaded<SliceIssue>
  /** The `spinOffs` bucket's size (free, like `Map.size`; tracked). */
  spinOffCount(id: string): number
  /** The nest children: present rows whose `nestParent` is `id` (the live pool's derived `nested` group). */
  nested(id: string): Iterable<string>
  /** The formal children: known issues whose declared `issue.parent` is `id` (the engine's `children` bucket). */
  formalChildren(id: string): Iterable<string>
  /** Another issue's parts (its node). */
  rollupNode(id: string): RollupParts | undefined
  /** A session's cached seat verdict (`LOADING` while its row is cold). */
  seat(id: string): Loaded<SeatVerdict>
  /** A session's cached `lastActiveAt` (Mb1's `activityMs`). */
  seatActivity(id: string): number | null
  spinOffIds(id: string): readonly string[]
}

/** The own row's facts the own part reads, cached apart from the seats. */
export interface OwnFacts {
  /** `ready`: resident; `cold`: its load is queued; `unknown`: not in the pool. */
  readonly state: 'ready' | 'cold' | 'unknown'
  readonly finished: boolean
  readonly decision: 'review' | 'merge' | null
  /** Its own explicit request to a human: open, and `needsHuman` or a decision-type issue (`taskOwnAsks`). */
  readonly requests?: boolean
  readonly continuedByField: boolean
  readonly updatedAt?: string
  readonly closedAt?: string | null
  readonly coordinatorSessionId?: string | null
  readonly order?: Aggregate['order']
}

/** The roll-up parts of one issue node. */
export interface RollupParts {
  /** Borrowed parsed record stamp; plain rebuilds may supply only the wire row. */
  readonly updatedMs?: number | null
  /** The own row's decision facts (re-run only when the own row changes). */
  readonly ownFacts: OwnFacts
  /** The declared `issue.parent` forward key: where this node is filed for progress. */
  readonly formalParent: string | null
  readonly ownAttention: OwnAttention
  readonly aggregate: Aggregate
  readonly unitOwn: UnitOwn
  readonly unitsBelow: Units
  /** The latest seat activity in the visible subtree (`Rollup.seatActivity`). */
  readonly seatActivity: number | null
  /** Some explicit session of its own is on the task (`openIssues`, `mission.ts:582-590`). */
  readonly openOwn: boolean
  /** A live spin-off descendant that started or is staffed (`liveSpinOffTip`), and cold ones pending. */
  readonly tip: Tip
  /** The row's roll-up fields; undefined when the issue is unknown. */
  readonly rollup: Rollup | undefined
}

/** What the roll-up parts read from their own issue (its visibility parts included). */
export interface RollupSelf extends RollupParts {
  readonly present: boolean
  readonly finished: boolean | undefined
  readonly rosterIds: readonly string[]
  readonly seatIds: readonly string[]
  /** Exited seats whose exception stands (`Members.exceptionSeatIds`): they add only that exception. */
  readonly exceptionSeatIds?: readonly string[]
}

const UNKNOWN_FACTS: OwnFacts = {
  state: 'unknown',
  finished: false,
  decision: null,
  continuedByField: false,
}
const COLD_FACTS: OwnFacts = { ...UNKNOWN_FACTS, state: 'cold' }

/** The own row's decision facts (`rowPendingDecision`'s row half). */
export function ownFactsPartOf(input: RollupInputs, id: string): OwnFacts {
  return ownFactsOf(input.loadedIssue(id))
}

/** The decision facts of an own row as the in-memory read answers it. */
export function ownFactsOf(issue: Loaded<SliceIssue>): OwnFacts {
  if (issue === LOADING) return COLD_FACTS
  if (issue === undefined) return UNKNOWN_FACTS
  return {
    state: 'ready',
    finished: isFinished(issue),
    decision: pendingDecisionOf(issue),
    requests: taskOwnAsks(issue),
    continuedByField: continuedByField(issue),
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    coordinatorSessionId: issue.coordinatorSessionId,
    order: { id: issue.id, seq: issue.seq, createdAt: issue.createdAt, sortKey: issue.sortKey },
  }
}

/**
 * Whether a live spin-off descendant has started or is staffed (the tip
 * `liveSpinOffTip` would name exists, `mission.ts:740-791`), over the declared
 * `spinOffs` relation: each spin-off's own verdict, then its own `tip`.
 */
export interface TipTarget {
  readonly id: string
  readonly seq: number
  readonly repoId?: string | null
  readonly staffed: boolean
  readonly finished: boolean
  readonly activeAt: string
}
export interface Tip {
  readonly found: boolean
  readonly pending: number
  readonly target?: TipTarget
}

export function tipPartOf(input: RollupInputs, id: string): Tip {
  let pending = 0
  let target: TipTarget | undefined
  for (const spinOffId of input.spinOffIds(id)) {
    const issue = input.loadedIssue(spinOffId)
    if (issue === LOADING) {
      pending += 1
      continue
    }
    if (issue === undefined || issue.archived === true || issue.deletedAt != null) continue
    const node = input.rollupNode(spinOffId)
    const ownTarget: TipTarget | undefined =
      leftMission(issue) || node?.openOwn === true
        ? {
            id: issue.id,
            seq: issue.seq,
            repoId: issue.repoId,
            staffed: node?.openOwn === true,
            finished: node?.ownFacts.finished ?? isFinished(issue),
            activeAt: new Date(
              Math.max(
                node && 'updatedMs' in node ? node.updatedMs ?? 0 : Date.parse(issue.updatedAt) || 0,
                input.tipActivityAt === undefined
                  ? (node?.seatActivity ?? 0)
                  : Date.parse(input.tipActivityAt(spinOffId) ?? '') || 0,
              ),
            ).toISOString(),
          }
        : undefined
    const below = node?.tip
    for (const candidate of [ownTarget, below?.target]) {
      if (candidate === undefined) continue
      // Staffed tips prefer recency regardless of closure. Only the unstaffed
      // fallback prefers unfinished work (mission.ts preferredSpinOffTip).
      if (
        target === undefined ||
        Number(candidate.staffed) > Number(target.staffed) ||
        (candidate.staffed === target.staffed &&
          !candidate.staffed &&
          Number(candidate.finished) < Number(target.finished)) ||
        (candidate.staffed === target.staffed &&
          (candidate.staffed || candidate.finished === target.finished) &&
          candidate.activeAt > target.activeAt)
      )
        target = candidate
    }
    pending += below?.pending ?? 0
  }
  return target === undefined ? { found: false, pending } : { found: true, pending: 0, target }
}

/**
 * The row's own part: its seats (Mb1's roster: retained, not exited, no
 * shell, not archived) and its own pending decision (`rowPendingDecision`,
 * `row-attention.ts:136-152`). Empty for an issue with no row.
 */
export function ownAttentionPartOf(
  input: RollupInputs,
  self: Pick<RollupSelf, 'present' | 'ownFacts' | 'rosterIds' | 'openOwn' | 'tip' | 'exceptionSeatIds'>,
): OwnAttention {
  if (!self.present) return EMPTY_OWN
  const facts = self.ownFacts
  if (facts.state === 'cold') return PENDING_OWN
  if (facts.state === 'unknown') return EMPTY_OWN
  const coordinator = liveCoordinatorOf(input, facts)
  let own = EMPTY_OWN
  let pending = 0
  // One pass over the roster; the own part is assembled once, never copied per seat.
  const seats = new Map<string, SeatVerdict>()
  const ids: string[] = []
  for (const sessionId of self.rosterIds) {
    const verdict = input.seat(sessionId)
    if (verdict === LOADING) pending += 1
    else if (verdict !== undefined) {
      const role = roleOn(coordinator, verdict.id)
      const seat = role === null ? verdict : asRoleSeat(verdict, role)
      own = withSeat(own, seat)
      if (seat.id !== undefined) {
        seats.set(seat.id, seat)
        ids.push(seat.id)
      }
    }
  }
  let deciding = false
  if (facts.decision !== null && (facts.finished || !own.working)) {
    deciding = true
    if (facts.decision === 'review') {
      // `issueContinuation` (`mission.ts:2207-2250`): the work went elsewhere.
      if (facts.continuedByField) deciding = false
      else if (!self.openOwn) {
        const tip = self.tip
        if (tip.found) deciding = false
        pending += tip.pending
      }
    }
  }
  // A coordinated row's own explicit requests ask as its decision does (POD-2171).
  if (coordinator !== null && facts.requests) deciding = true
  const orderFor = (id: string): SidebarSessionOrder =>
    (seats.get(id) as SeatVerdict).sidebarOrder as SidebarSessionOrder
  const sessionIds = sortedSidebarSessions(
    ids,
    input.reached ?? (() => false),
    facts.coordinatorSessionId,
    orderFor,
  )
  let sidebarFacts = sessionIds.reduce(
    (combined, id) =>
      combineSidebarSessions(combined, seats.get(id)?.sidebarFacts ?? NO_SIDEBAR_SESSIONS),
    NO_SIDEBAR_SESSIONS,
  )
  const railWaiting = { open: 0, finished: 0, decisions: deciding ? 1 : 0, delegated: 0 }
  for (const id of sessionIds) {
    const verdict = seats.get(id) as SeatVerdict
    if (verdict.roles.delegate.phase === 'waiting') railWaiting.delegated += 1
    if (deciding && orderFor(id).offerOnly) continue
    if (verdict.open === 'waiting') railWaiting.open += 1
    if (verdict.finished === 'waiting') railWaiting.finished += 1
  }
  for (const seat of exceptionSeatsOf(input, self)) {
    const asks = coordinator !== null
    own = { ...own, delegated: waitingWith(own.delegated),
      ...(asks ? { open: waitingWith(own.open), finished: waitingWith(own.finished) } : {}) }
    sidebarFacts = combineSidebarSessions(sidebarFacts, exceptionSidebarFacts(seat.sidebarFacts ?? NO_SIDEBAR_SESSIONS, asks))
    railWaiting.delegated += 1
    if (asks) { railWaiting.open += 1; railWaiting.finished += 1 }
  }
  return {
    ...own,
    coordinated: coordinator !== null,
    deciding,
    pending: own.pending + pending,
    sessionIds,
    firstSessionId: sessionIds[0] ?? null,
    sidebarFacts,
    railWaiting,
    updatedAt: facts.updatedAt,
    order: facts.order,
    decidingAt: deciding
      ? Date.parse(facts.closedAt ?? facts.updatedAt ?? '') || undefined
      : undefined,
  }
}

/**
 * The declared `issue.parent` forward key, from the node's own row (Mb1's
 * `standing`, the engine's `relationRef`): the progress filing's key. Not
 * `one()`: that also reads the parent's presence, so loading a parent would
 * re-run every cold child's filing (one presence probe each).
 */
export function formalParentPartOf(self: {
  readonly standing: { readonly formalParent: string | null } | undefined
}): string | null {
  return self.standing?.formalParent ?? null
}

/** The visible-subtree aggregate: own part plus each nest child's cached aggregate. */
export function aggregatePartOf(
  input: RollupInputs,
  id: string,
  self: Pick<RollupSelf, 'ownAttention'>,
): Aggregate {
  const own = self.ownAttention
  if (own.cold) return aggregate({ own, children: [] })
  const children: Aggregate[] = []
  for (const childId of input.nested(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push(child.aggregate)
  }
  children.sort((a, b) => {
    const x = a.order,
      y = b.order
    if (x === undefined || y === undefined) return 0
    const keyed = Number(!x.sortKey) - Number(!y.sortKey)
    if (keyed) return keyed
    if (x.sortKey && y.sortKey && x.sortKey !== y.sortKey) return x.sortKey < y.sortKey ? -1 : 1
    return (
      (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0) ||
      y.seq - x.seq ||
      x.id.localeCompare(y.id)
    )
  })
  const combined = aggregate({ own, children })
  return { ...combined, order: own.order }
}

/**
 * This issue's own contribution to its formal ancestors' progress: its row
 * through the one reader (a cold row is a pending marker and its load is
 * queued), and `vacated` (`isVacatedOrigin`, `mission.ts:794-808`: no own
 * session on the task, and a spin-off), asked in that order so a row with
 * no spin-off never reads its sessions.
 */
function missionUnitState(input: RollupInputs, id: string, issue: ProgressFacts, hasSessions: boolean): UnitState | undefined {
  const bucket = input.missionBucket ? input.missionBucket(id) : missionTaskBucket(issue, hasSessions, false)
  return bucket ?? undefined
}

export function unitOwnPartOf(
  input: RollupInputs,
  id: string,
  self: Pick<RollupSelf, 'openOwn' | 'unitsBelow'>,
): UnitOwn {
  const issue = input.loadedIssue(id)
  if (issue === LOADING) return PENDING_UNIT
  if (issue === undefined) return NO_UNIT
  const vacated = input.spinOffCount(id) > 0 && !self.openOwn
  const staffed = self.openOwn || self.unitsBelow.staffed === true
  const unit = unitOwnOf(issue, vacated)
  const state = missionUnitState(input, id, issue, self.openOwn)
  return { ...unit, staffed, state }
}

/**
 * The formal closure's counts: each formal child's own contribution and its
 * own closure. A cold child's closure is not read (so not composed) until the
 * child lands: one level of cold rows per window. Within a parent cycle the
 * legacy closure visits each member once and excludes the requested root.
 */
export function unitsBelowPartOf(input: RollupInputs, id: string): Units {
  const childIds = [...input.formalChildren(id)]
  if (childIds.length > 0) {
    const cycle = formalCycleOf(input, id)
    if (cycle !== undefined) return cyclicUnitsBelowOf(input, id, childIds, cycle)
  }
  const children: { own: UnitOwn; below: Units }[] = []
  for (const childId of childIds) {
    const child = input.rollupNode(childId)
    if (child === undefined) continue
    const own = child.unitOwn
    children.push({ own, below: own.cold ? NO_UNITS : child.unitsBelow })
  }
  return unitsOf({ children })
}

/** Relations alone detect whether this root belongs to a formal parent cycle. */
function formalCycleOf(input: RollupInputs, id: string): Set<string> | undefined {
  const cycle = new Set<string>([id])
  let parentId = input.rollupNode(id)?.formalParent ?? null
  while (parentId !== null && !cycle.has(parentId)) {
    cycle.add(parentId)
    parentId = input.rollupNode(parentId)?.formalParent ?? null
  }
  return parentId === id ? cycle : undefined
}

/**
 * Cycle members cannot compose each other's cached units. Read their own
 * facts instead, retaining cached composition for every branch off the cycle.
 * Staffing reaches every cycle member (legacy `staffedSubtreeIds`), including
 * when the only session belongs to the root excluded from the progress count.
 */
function cyclicUnitsBelowOf(
  input: RollupInputs,
  id: string,
  childIds: readonly string[],
  cycle: ReadonlySet<string>,
): Units {
  const children: { own: UnitOwn; below: Units }[] = []
  const members: { id: string; node: RollupParts }[] = []
  const seen = new Set<string>([id])
  const pending = [...childIds]
  let staffed = input.rollupNode(id)?.openOwn === true
  while (pending.length > 0) {
    const childId = pending.pop() as string
    if (seen.has(childId)) continue
    seen.add(childId)
    const child = input.rollupNode(childId)
    if (child === undefined) continue
    if (!cycle.has(childId)) {
      const own = child.unitOwn
      const below = own.cold ? NO_UNITS : child.unitsBelow
      children.push({ own, below })
      staffed ||= own.staffed === true || below.staffed === true
      continue
    }
    const issue = input.loadedIssue(childId)
    if (issue === LOADING) {
      children.push({ own: PENDING_UNIT, below: NO_UNITS })
      continue
    }
    if (issue === undefined) continue
    members.push({ id: childId, node: child })
    staffed ||= child.openOwn
    pending.push(...input.formalChildren(childId))
  }
  const staffing = { ...NO_UNITS, staffed }
  for (const member of members) {
    children.push({
      own: unitOwnPartOf(input, member.id, {
        openOwn: member.node.openOwn,
        unitsBelow: staffing,
      }),
      below: NO_UNITS,
    })
  }
  return unitsOf({ children })
}

/**
 * The latest seat activity of the visible subtree: own seats' cached stamps
 * and each nest child's result. Its own composition, apart from `aggregate`,
 * so a phase change never runs it and a heartbeat never runs `aggregate`.
 */
export function seatActivityPartOf(
  input: RollupInputs,
  id: string,
  self: Pick<RollupSelf, 'present' | 'ownFacts' | 'rosterIds'>,
): number | null {
  if (!self.present || self.ownFacts.state === 'cold') return null
  const own = self.rosterIds.map((sessionId) => input.seatActivity(sessionId))
  const children: (number | null)[] = []
  for (const childId of input.nested(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push(child.seatActivity)
  }
  return latestOf({ own, children })
}

export function rollupPartOf(
  self: Pick<
    RollupSelf,
    'finished' | 'ownAttention' | 'aggregate' | 'unitOwn' | 'unitsBelow' | 'seatActivity'
  >,
): Rollup | undefined {
  if (self.finished === undefined) return undefined
  return rollupOf({
    finished: self.finished,
    own: self.ownAttention,
    agg: self.aggregate,
    self: self.unitOwn,
    below: self.unitsBelow,
    seatActivity: self.seatActivity,
  })
}

/** For the fold verdict (R-GROUP 3's "nothing waiting"): the aggregate alone, not the progress. */
export function waitingPartOf(self: Pick<RollupSelf, 'finished' | 'aggregate'>): boolean {
  return self.finished !== undefined && askingOf(self.aggregate, self.finished)
}

// ------------------------------------------------------------ the groups

/**
 * The attention group: the row's own part and its visible subtree's
 * aggregate. The latest seat activity is its own group (`seatActivityPartOf`,
 * POD-5423): a heartbeat moves that number up the nest, never this.
 */
export interface Attention {
  readonly ownAttention: OwnAttention
  readonly aggregate: Aggregate
}

/**
 * The attention group of issue `id`: one composition over its nest children's
 * cached groups. The own facts are read only for a present row (a cold own
 * row queues its load).
 */
export function attentionOf(
  input: RollupInputs,
  id: string,
  self: Pick<RollupSelf, 'present' | 'ownFacts' | 'rosterIds' | 'openOwn' | 'tip' | 'exceptionSeatIds'>,
): Attention {
  const ownAttention = ownAttentionPartOf(input, self)
  return { ownAttention, aggregate: aggregatePartOf(input, id, { ownAttention }) }
}

/** The progress group: this issue's own unit and its formal closure's counts. */
export interface Progress {
  readonly unitOwn: UnitOwn
  readonly unitsBelow: Units
}

/** The progress group of issue `id`: one composition over its formal children's cached groups. */
export function progressOf(
  input: RollupInputs,
  id: string,
  self: Pick<RollupSelf, 'openOwn' | 'unitsBelow'>,
): Progress {
  const unitsBelow = unitsBelowPartOf(input, id)
  return { unitOwn: unitOwnPartOf(input, id, { openOwn: self.openOwn, unitsBelow }), unitsBelow }
}

// ------------------------------------------------------------ live scalar answers

/** Uncached getter views: a model @lazy asks only its own question. The eager
 * part functions above remain the independent rebuild/parity reference. */
function sidebarFields(read: <K extends keyof SidebarSessionFacts>(key: K) => SidebarSessionFacts[K]): SidebarSessionFacts {
  return {
    get fleet() { return read('fleet') },
    get working() { return read('working') },
    get waitingOpen() { return read('waitingOpen') },
    get waitingFinished() { return read('waitingFinished') },
    get workingDelegated() { return read('workingDelegated') },
    get waitingDelegated() { return read('waitingDelegated') },
    get errorClassDelegated() { return read('errorClassDelegated') },
    get doneSince() { return read('doneSince') },
    get totalMs() { return read('totalMs') },
    get errorClass() { return read('errorClass') },
    get allUnstarted() { return read('allUnstarted') },
  }
}

function sidebarField<K extends keyof SidebarSessionFacts>(
  key: K, parts: Iterable<SidebarSessionFacts>,
): SidebarSessionFacts[K] {
  let value = NO_SIDEBAR_SESSIONS[key], hasValue = false
  for (const facts of parts) {
    if (facts === NO_SIDEBAR_SESSIONS) continue
    value = hasValue ? combineSidebarSessionField(key, value, facts[key]) : facts[key]
    hasValue = true
  }
  return value
}

export function ownAttentionFields(input: RollupInputs, self: RollupSelf): OwnAttention {
  const ready = () => self.present && self.ownFacts.state === 'ready'
  function* seats(): Iterable<SeatVerdict> {
    for (const id of self.rosterIds) {
      const seat = input.seat(id)
      if (seat !== LOADING && seat !== undefined) yield seat
    }
  }
  const coordinator = () => ready() ? liveCoordinatorOf(input, self.ownFacts) : null
  /** The seats as this row shows them: under a live coordinator, the others as delegates. */
  function* rowSeats(): Iterable<SeatVerdict> {
    const live = coordinator()
    // An uncoordinated row reads no seat's id here: its working reader stays as narrow as it was.
    if (live === null) yield* seats()
    else for (const seat of seats()) yield asRoleSeat(seat, seat.id === live ? 'coordinator' : 'delegate')
  }
  /** Exited seats' exceptions (`exceptionSeatsOf`): the delegate flags always, the row's own on a coordinated row. */
  const excepted = () => {
    for (const _seat of exceptionSeatsOf(input, self)) return true
    return false
  }
  const exceptions = () => {
    let count = 0
    for (const _seat of exceptionSeatsOf(input, self)) count++
    return count
  }
  const flags = (phase: (seat: SeatVerdict) => SlicePhase, exceptionsAsk: () => boolean): PhaseFlags => {
    return {
      get waiting() {
        if (ready()) for (const seat of rowSeats()) if (phase(seat) === 'waiting') return true
        return ready() && exceptionsAsk() && excepted()
      },
      get working() {
        if (ready()) for (const seat of rowSeats()) if (phase(seat) === 'working') return true
        return false
      },
      get allDone() {
        if (ready()) for (const seat of rowSeats()) if (phase(seat) !== 'done') return false
        return true
      },
    }
  }
  const railWaiting = (finished: boolean) => {
    let count = 0
    const deciding = self.ownAttention.deciding
    for (const seat of rowSeats()) {
      if (seat.id === undefined) continue
      if (deciding && seat.sidebarOrder?.offerOnly) continue
      if ((finished ? seat.finished : seat.open) === 'waiting') count++
    }
    return coordinator() !== null ? count + exceptions() : count
  }
  return {
    get cold() { return self.present && self.ownFacts.state === 'cold' },
    get coordinated() { return coordinator() !== null },
    get seated() {
      if (ready()) for (const _seat of seats()) return true
      return false
    },
    get working() {
      if (ready()) for (const seat of rowSeats()) if (seat.working) return true
      return false
    },
    get workingSince() {
      let since: number | null = null
      if (ready()) for (const seat of rowSeats()) {
        const at = seat.workingSinceMs
        if (at !== null && (since === null || at < since)) since = at
      }
      return since
    },
    get deciding() {
      if (!ready()) return false
      const facts = self.ownFacts
      if (facts.requests && self.ownAttention.coordinated) return true
      if (facts.decision === null || (!facts.finished && self.ownAttention.working)) return false
      return facts.decision !== 'review' ||
        (!facts.continuedByField && (self.openOwn || !self.tip.found))
    },
    get pending() {
      if (!self.present) return 0
      if (self.ownFacts.state === 'cold') return 1
      if (!ready()) return 0
      let pending = 0
      for (const id of self.rosterIds) if (input.seat(id) === LOADING) pending++
      const facts = self.ownFacts
      if (facts.decision === 'review' && (facts.finished || !self.ownAttention.working) &&
        !facts.continuedByField && !self.openOwn) pending += self.tip.pending
      return pending
    },
    get open() { return flags(seat => seat.open, () => coordinator() !== null) },
    get finished() { return flags(seat => seat.finished, () => coordinator() !== null) },
    get delegated() { return flags(seat => seat.roles.delegate.phase, () => true) },
    get sessionIds() {
      if (!ready()) return undefined
      const ids: string[] = []
      for (const seat of seats()) if (seat.id !== undefined) ids.push(seat.id)
      return sortedSidebarSessions(ids, input.reached ?? (() => false),
        self.ownFacts.coordinatorSessionId, id => {
          const seat = input.seat(id)
          if (seat === undefined || seat === LOADING || seat.sidebarOrder === undefined)
            throw new Error(`Missing roster order: ${id}`)
          return seat.sidebarOrder
        })
    },
    get firstSessionId() { return ready() ? self.ownAttention.sessionIds?.[0] ?? null : undefined },
    get railWaiting() {
      if (!ready()) return undefined
      return {
        get open() { return railWaiting(false) },
        get finished() { return railWaiting(true) },
        get decisions() { return self.ownAttention.deciding ? 1 : 0 },
        get delegated() {
          let count = 0
          for (const seat of seats()) if (seat.id !== undefined && seat.roles.delegate.phase === 'waiting') count++
          return count + exceptions()
        },
      }
    },
    get sidebarFacts() {
      if (!ready()) return undefined
      return sidebarFields(<K extends keyof SidebarSessionFacts>(key: K) => {
        // Order matters for fleet glyphs, error choice and tied timer anchors.
        function* facts(): Iterable<SidebarSessionFacts> {
          const live = coordinator()
          for (const id of self.ownAttention.sessionIds ?? []) {
            const seat = input.seat(id)
            if (seat !== LOADING && seat !== undefined)
            {
              const role = roleOn(live, id)
              yield (role === null ? seat : asRoleSeat(seat, role)).sidebarFacts ?? NO_SIDEBAR_SESSIONS
            }
          }
          for (const seat of exceptionSeatsOf(input, self))
            yield exceptionSidebarFacts(seat.sidebarFacts ?? NO_SIDEBAR_SESSIONS, live !== null)
        }
        return sidebarField(key, facts())
      })
    },
    get updatedAt() { return ready() ? self.ownFacts.updatedAt : undefined },
    get order() { return ready() ? self.ownFacts.order : undefined },
    get decidingAt() {
      return self.ownAttention.deciding
        ? Date.parse(self.ownFacts.closedAt ?? self.ownFacts.updatedAt ?? '') || undefined
        : undefined
    },
  }
}

export function aggregateFields(input: RollupInputs, id: string, self: RollupSelf): Aggregate {
  function* parts(): Iterable<Aggregate> {
    yield self.ownAttention
    if (self.ownAttention.cold) return
    const coordinated = self.ownAttention.coordinated
    for (const childId of input.nested(id)) {
      const child = input.rollupNode(childId)
      if (child !== undefined) yield coordinated ? asDelegated(child.aggregate) : child.aggregate
    }
  }
  const any = (key: 'working' | 'deciding' | 'seated') => {
    for (const part of parts()) if (part[key]) return true
    return false
  }
  const flags = (key: 'open' | 'finished' | 'delegated'): PhaseFlags => ({
    get waiting() { for (const part of parts()) if (part[key].waiting) return true; return false },
    get working() { for (const part of parts()) if (part[key].working) return true; return false },
    get allDone() { for (const part of parts()) if (!part[key].allDone) return false; return true },
  })
  const rail = (key: 'open' | 'finished' | 'decisions' | 'delegated') => {
    let total = 0
    for (const part of parts()) total += part.railWaiting?.[key] ?? 0
    return total
  }
  const orderedParts = (): Aggregate[] => {
    const [own, ...children] = parts()
    children.sort((a, b) => {
      const x = a.order, y = b.order
      if (x === undefined || y === undefined) return 0
      const keyed = Number(!x.sortKey) - Number(!y.sortKey)
      if (keyed) return keyed
      if (x.sortKey && y.sortKey && x.sortKey !== y.sortKey) return x.sortKey < y.sortKey ? -1 : 1
      return (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0) ||
        y.seq - x.seq || x.id.localeCompare(y.id)
    })
    return [own!, ...children]
  }
  return {
    get working() { return any('working') },
    get deciding() { return any('deciding') },
    get seated() { return any('seated') },
    get open() { return flags('open') },
    get finished() { return flags('finished') },
    get delegated() { return flags('delegated') },
    get pending() { let total = 0; for (const part of parts()) total += part.pending; return total },
    get railWaiting() {
      return {
        get open() { return rail('open') },
        get finished() { return rail('finished') },
        get decisions() { return rail('decisions') },
        get delegated() { return rail('delegated') },
      }
    },
    get sessionIds() {
      const ids: string[] = []
      for (const part of orderedParts()) ids.push(...(part.sessionIds ?? []))
      return ids
    },
    get sidebarFacts() {
      return sidebarFields(<K extends keyof SidebarSessionFacts>(key: K) => {
        function* facts(): Iterable<SidebarSessionFacts> {
          for (const part of orderedParts()) yield part.sidebarFacts ?? NO_SIDEBAR_SESSIONS
        }
        return sidebarField(key, facts())
      })
    },
    get updatedAt() {
      let latest = ''
      for (const part of parts()) if ((part.updatedAt ?? '') > latest) latest = part.updatedAt ?? ''
      return latest
    },
    get order() { return self.ownAttention.order },
    get decidingAt() {
      let earliest: number | undefined
      for (const part of parts()) {
        const at = part.decidingAt
        if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
      }
      return earliest
    },
  }
}

export function unitOwnFields(
  input: RollupInputs, id: string, self: Pick<RollupSelf, 'openOwn' | 'unitsBelow'> & Partial<Pick<RollupSelf, 'ownFacts'>>,
): UnitOwn {
  const issue = input.loadedIssue(id)
  if (issue === LOADING) return PENDING_UNIT
  if (issue === undefined) return NO_UNIT
  const vacated = () => input.spinOffCount(id) > 0 && !self.openOwn
  const member = () => issue.stage !== 'proposed' && issue.type !== 'phase'
  const unit = () => member() && !issueAbandoned(issue) && !vacated()
  const staffed = () => self.openOwn || self.unitsBelow.staffed === true
  const finished = () => self.ownFacts?.finished ?? isFinished(issue)
  return {
    cold: false,
    get member() { return member() },
    get unit() { return unit() },
    get done() { return unit() && finished() },
    get solo() { return unit() },
    get staffed() { return staffed() },
    get state() {
      return missionUnitState(input, id, issue, self.openOwn)
    },
  }
}

type UnitChild = { readonly own: UnitOwn; readonly below: Units }

function unitsFields(children: () => Iterable<UnitChild>): Units {
  const count = (key: 'members' | 'units' | 'done') => {
    const ownKey = key === 'members' ? 'member' : key === 'units' ? 'unit' : 'done'
    let total = 0
    for (const { own, below } of children())
      if (!own.cold) total += (own[ownKey] && (key === 'members' || below.members === 0) ? 1 : 0) + below[key]
    return total
  }
  return {
    get members() { return count('members') },
    get units() { return count('units') },
    get done() { return count('done') },
    get pending() {
      let total = 0
      for (const { own, below } of children()) total += own.cold ? 1 : below.pending
      return total
    },
    get staffed() {
      for (const { own, below } of children())
        if (!own.cold && (own.staffed === true || below.staffed === true)) return true
      return false
    },
    get progress() {
      const progress = { done: 0, working: 0, waiting: 0, todo: 0 }
      for (const { own, below } of children()) {
        if (own.cold) continue
        if (own.unit && below.members === 0) progress[own.state ?? (own.done ? 'done' : 'todo')]++
        const nested = below.progress
        for (const state of Object.keys(progress) as (keyof typeof progress)[])
          progress[state] += nested?.[state] ?? 0
      }
      return progress
    },
  }
}

export function unitsBelowFields(input: RollupInputs, id: string): Units {
  function* children(): Iterable<UnitChild> {
    const ids = [...input.formalChildren(id)]
    const cycle = ids.length > 0 ? formalCycleOf(input, id) : undefined
    if (cycle !== undefined) {
      // The same once-per-member closure as the eager oracle. Only staffing
      // asks for cycle-wide staffing; plain counts never acquire those seats.
      const members: { id: string; node: RollupParts }[] = []
      const branches: UnitChild[] = []
      const seen = new Set<string>([id]), pending = [...ids]
      while (pending.length > 0) {
        const childId = pending.pop()!
        if (seen.has(childId)) continue
        seen.add(childId)
        const child = input.rollupNode(childId)
        if (child === undefined) continue
        if (!cycle.has(childId)) {
          branches.push({ own: child.unitOwn, get below() { return child.unitOwn.cold ? NO_UNITS : child.unitsBelow } })
          continue
        }
        const issue = input.loadedIssue(childId)
        if (issue === LOADING) { branches.push({ own: PENDING_UNIT, below: NO_UNITS }); continue }
        if (issue === undefined) continue
        members.push({ id: childId, node: child })
        pending.push(...input.formalChildren(childId))
      }
      const staffing: Units = {
        ...NO_UNITS,
        get staffed() {
          if (input.rollupNode(id)?.openOwn) return true
          for (const member of members) if (member.node.openOwn) return true
          for (const { own, below } of branches)
            if (!own.cold && (own.staffed === true || below.staffed === true)) return true
          return false
        },
      }
      yield* branches
      for (const member of members) yield {
        own: unitOwnFields(input, member.id, {
          get openOwn() { return member.node.openOwn },
          get ownFacts() { return member.node.ownFacts }, unitsBelow: staffing,
        }), below: NO_UNITS,
      }
      return
    }
    for (const childId of ids) {
      const child = input.rollupNode(childId)
      if (child !== undefined) yield {
        own: child.unitOwn,
        get below() { return child.unitOwn.cold ? NO_UNITS : child.unitsBelow },
      }
    }
  }
  return unitsFields(children)
}
