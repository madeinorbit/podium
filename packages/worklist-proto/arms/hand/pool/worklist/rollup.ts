/**
 * POD-4584 (Hb3) — the row roll-ups: `phase`, `working`, `asking`,
 * `progressDone` / `progressTotal` and `workingSince` (L1b, spec §3 R-SUM and
 * R-ROLL, corrected by L1d), as a COMPOSITION over declared relations, over
 * the hand pool's graph.
 *
 * Built after the MobX build: the combines, the per-session rules and the
 * node parts mirror Mb3 (`arms/mobx/pool/worklist/rollup.ts`, POD-4571) and
 * its milestone note, so the two arms hold the same derivation. No contract
 * amendment to reuse (MobX filed none; the cold-rule amendment is shared).
 * The substrate differs: where Mb3 is computeds on nodes, every part here is
 * a cell (`../cells.ts`) that recorded what it read, and the two child
 * indexes are filings maintained from per-issue filing cells, not reactions.
 *
 * THE COMBINE FUNCTIONS HAVE NO STORE. `aggregate({ own, children })` and
 * `unitsOf({ children })` take values and return a value; they cannot reach
 * a row, a relation or a pool (`rollup.types.test.ts` holds that at compile
 * time). The node parts below gather their inputs: a row's own part reads its
 * own row and its own seats, and a composition reads only its children's
 * CACHED results. So a change re-runs its own row's part and then each
 * ancestor's composition once, and nothing below or beside the chain. The
 * chain needs no walk: a child's cached result changing dirties exactly its
 * parent's composition through the cell graph, and an unchanged value keeps
 * its object and stops there (`sameData`).
 *
 * TWO COMPOSITIONS, because the legacy derivation has two trees, plus the
 * activity stamp the legacy raises through the same nesting:
 *
 * - ATTENTION (`phase`, `working`, `asking`) composes over the VISIBLE
 *   subtree (L1d): a row's own seats plus the aggregates of the rows NESTED
 *   under it (`rows.ts:331-334`, `attach`). The nest children are the inverse
 *   of Hb1's `nestParent` (the nearest present ancestor by the raw `parentId`,
 *   or the started-by owner), filed per node like the visible set: every
 *   known issue holds a `fileNest` cell over its visibility `nestParent`
 *   part, and the collection files each id under its current parent, moving
 *   exactly the reported ids after the drain. A hidden issue has no row and
 *   so no own part; its visible descendants nest under the nearest visible
 *   ancestor, which is the legacy walk-past (`rows.ts:272-283`).
 * - PROGRESS (`progressDone` / `progressTotal`) composes over the declared
 *   `issue.parent` / `issue.children` relation, the formal closure
 *   `missionRollup` counts (`mission.ts:1353-1404`). The relation drops
 *   archived and deleted children (schema `where`, `missionParentId`), which
 *   is the legacy cut of an archived branch. The children are filed from each
 *   node's own forward slot (`PoolRelations.forward`), not by re-listing the
 *   `children` bucket: a re-listing reads every sibling id (the fence counts
 *   each), so a re-parent would cost both families, where the filing costs
 *   the moved row's own slot (#7's budget, POD-4609).
 * - ACTIVITY (`seatActivity`) composes over the same nest children: the
 *   latest seat stamp below the row, which the view takes the max with its
 *   own-row stamp (`rows.ts:336-339`, `attach`). Its own composition, apart
 *   from `aggregate`, so a phase change never runs it and a heartbeat never
 *   runs `aggregate`.
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
 * COLD ROWS, TWO WAYS (coordinator ruling 2026-09-24, option A, as Mb3).
 * - PROGRESS never loads. A formal child that is cold (under the declared
 *   rule `unlessShown`, exactly a closed child nothing can show) gives its
 *   unit facts through the cold-read path (`RollupInputs.progressFacts`:
 *   the resident row, else `Residency.peek` by id — counted as a feed read,
 *   tracked under the row's `coldRows` key and re-read on its next update),
 *   limited by type to the fields R-ROLL's progress reads (`ProgressFacts`:
 *   `stage`, `closedReason`), plus the `spinOffs` bucket's size and the
 *   cached session presence for `vacated`. Loading them instead would queue
 *   hundreds of closed issues at first paint and, by relinking every row it
 *   loaded, hide the pool gate's `coldRelinkSkipped` plant.
 * - ATTENTION keeps the pending marker (Ma3 addendum). A part that needs a
 *   cold row's fields for a seat's verdict or a spin-off's standing does not
 *   read it: it counts a PENDING marker and the read queues the row's load
 *   (`loadedIssue` / `seat` answer `LOADING`), which lands in the next window
 *   with every other queued row (`residency.ts`). A cold row is ONLY its
 *   marker: its own compositions do not run until it lands, so a read asks for
 *   one level of cold rows per window. The row view shows `loading` while any
 *   marker is pending. Under `unlessShown` a visible row and its seats are
 *   hot, so markers arise only from cold spin-offs (the review withdrawal's
 *   continuation) and transient cold rows.
 *
 * NO LEGACY IMPORT. The per-session rules are re-expressed from the spec with
 * the legacy line each follows cited, as `views.ts` does.
 */

import type { RelationReader } from '../../../../shared/src/instrument/reads'
import type { RowView } from '../../../../shared/src/row-view'
import type { EntityName } from '../../../../shared/src/schema'
import type { SliceIssue, SlicePhase, SliceSession } from '../../../../shared/src/slice-types'
import { type Cell, type CellGraph, DepIndex, type Equals, sameData } from '../cells'
import type { SessionVisibleParts, VisibleParts } from './visible'

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
export function motionPhase(session: SliceSession, rowFinished: boolean): SlicePhase {
  if (attentionGroup(session) === 'needsYou') {
    if (!(rowFinished && session.offer && !hasNonOfferNeedsYou(session))) return 'waiting'
  }
  const state = stateOf(session)
  if (state?.phase === 'ended' || (state?.phase === 'idle' && idleFinishedTurn(state.idle?.kind))) {
    return 'done'
  }
  if (isSessionWorking(session)) return 'working'
  return 'queued'
}

/** `sessionPresentOnTask` (`fleet.ts:36`, mission.ts's `openSession`). */
export function presentOnTask(session: {
  readonly archived?: boolean
  readonly exited: boolean
}): boolean {
  return session.archived !== true && !session.exited
}

// ------------------------------------------------------------ one seat

/** One seat's contribution, under either kind of root. Per session, cached. */
export interface SeatVerdict {
  /** `motionPhase` under an open (unfinished) row. */
  readonly open: SlicePhase
  /** `motionPhase` under a finished row: an offer-only ask is not waiting. */
  readonly finished: SlicePhase
  /** `isSessionWorking`. */
  readonly working: boolean
  /**
   * `workingSinceMs` (`time-indicators.tsx:34-43`, the oracle's
   * `workingSinceOf`): `agentState.since ?? lastActiveAt` while working.
   */
  readonly workingSinceMs: number | null
}

export function seatVerdictOf(session: SliceSession): SeatVerdict {
  const working = isSessionWorking(session)
  const at = working ? Date.parse(stateOf(session)?.since ?? session.lastActiveAt) : Number.NaN
  return {
    open: motionPhase(session, false),
    finished: motionPhase(session, true),
    working,
    workingSinceMs: Number.isFinite(at) ? at : null,
  }
}

// ------------------------------------------------------------ attention

/** What a set of seats says under one kind of root. */
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
  /** Some seat anywhere in it. */
  readonly seated: boolean
  /** Some seat computing (`rowHasWorkingSession`, `row-attention.ts:95-97`). */
  readonly working: boolean
  /** Some row in it awaits a decision (`pendingDecisionStats(row).count > 0`). */
  readonly deciding: boolean
  /** The seats' verdicts under an open root. */
  readonly open: PhaseFlags
  /** The seats' verdicts under a finished root. */
  readonly finished: PhaseFlags
  /** Cold rows it could not read yet (queued): the row shows `loading`. */
  readonly pending: number
}

/** A row's own part: its own seats and decision, plus its own working stamp. */
export interface OwnAttention extends Aggregate {
  /** The earliest working seat's start on THIS row (not rolled up: the oracle reads own seats). */
  readonly workingSince: number | null
  /** Its row is cold: the part is only a pending marker, and nothing below it is composed yet. */
  readonly cold: boolean
}

const NO_FLAGS: PhaseFlags = { waiting: false, working: false, allDone: true }

/** No seats, no decision, nothing pending: a row that is not on screen, or has nothing. */
export const EMPTY_OWN: OwnAttention = {
  seated: false,
  working: false,
  deciding: false,
  open: NO_FLAGS,
  finished: NO_FLAGS,
  pending: 0,
  workingSince: null,
  cold: false,
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

/** Fold one seat into a row's own part. */
export function withSeat(own: OwnAttention, seat: SeatVerdict): OwnAttention {
  const since =
    seat.workingSinceMs !== null &&
    (own.workingSince === null || seat.workingSinceMs < own.workingSince)
      ? seat.workingSinceMs
      : own.workingSince
  return {
    ...own,
    seated: true,
    working: own.working || seat.working,
    open: flagsWith(own.open, seat.open),
    finished: flagsWith(own.finished, seat.finished),
    workingSince: since,
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
 * nest children's aggregates. No store, no row, no relation: values in, a
 * value out.
 */
export function aggregate(input: {
  readonly own: Aggregate
  readonly children: readonly Aggregate[]
}): Aggregate {
  let { seated, working, deciding, open, finished, pending } = input.own
  for (const child of input.children) {
    seated ||= child.seated
    working ||= child.working
    deciding ||= child.deciding
    open = joinFlags(open, child.open)
    finished = joinFlags(finished, child.finished)
    pending += child.pending
  }
  return { seated, working, deciding, open, finished, pending }
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

/** `issuePendingDecision` (`slices/issues.ts:391-404`); `merge` needs git state no slice row has. */
export function pendingDecisionOf(issue: SliceIssue): 'review' | null {
  const finished = issue.stage === 'done' || issue.closedReason != null
  if (!finished && issue.stage !== 'review') return null
  if (issue.blocked === true) return null
  if (abandoned(issue)) return null
  return issue.stage === 'review' ? 'review' : null
}

const LEGACY_CLOSE_REASONS: Readonly<Record<string, string>> = {
  wontfix: 'cancelled',
  wont_fix: 'cancelled',
  "won't fix": 'cancelled',
  canceled: 'cancelled',
  dupe: 'duplicate',
}

/** `issueAbandoned` (the canonical close reason). */
function abandoned(issue: ProgressFacts): boolean {
  const raw = issue.closedReason
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  const reason =
    key === ''
      ? null
      : Object.hasOwn(LEGACY_CLOSE_REASONS, key)
        ? (LEGACY_CLOSE_REASONS[key] as string)
        : key === 'done' || key === 'cancelled' || key === 'duplicate' || key === 'superseded'
          ? key
          : null
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
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
export interface UnitOwn {
  /** Accepted formal member: not proposed, not abandoned (`mission.ts:1368-1370`). */
  readonly member: boolean
  /** A member that is not a vacated origin (`mission.ts:1375-1388`). */
  readonly unit: boolean
  /** A unit that is closed (`issueClosed`, `mission.ts:349-351`). */
  readonly done: boolean
  /** As a LONE root (no accepted members): not abandoned, not vacated. */
  readonly solo: boolean
}

export const NO_UNIT: UnitOwn = { member: false, unit: false, done: false, solo: false }

/**
 * Exactly the own-row fields R-ROLL's progress reads (`computeMissionRollup`:
 * `stage` for proposed and closed, `closedReason` for abandoned and closed),
 * and no more: the only fields a cold child's read may give it.
 */
export type ProgressFacts = Pick<SliceIssue, 'stage' | 'closedReason'>

/** The progress counts of a formal closure (the root excluded). Plain data. */
export interface Units {
  readonly members: number
  readonly units: number
  readonly done: number
}

export const NO_UNITS: Units = { members: 0, units: 0, done: 0 }

/**
 * THE PROGRESS COMBINE: a row's formal closure from each formal child's own
 * contribution and that child's own closure. No store.
 */
export function unitsOf(input: {
  readonly children: readonly { readonly own: UnitOwn; readonly below: Units }[]
}): Units {
  let { members, units, done } = NO_UNITS
  for (const { own, below } of input.children) {
    members += (own.member ? 1 : 0) + below.members
    units += (own.unit ? 1 : 0) + below.units
    done += (own.done ? 1 : 0) + below.done
  }
  return { members, units, done }
}

export function unitOwnOf(facts: ProgressFacts, vacated: boolean): UnitOwn {
  const gone = abandoned(facts)
  const member = facts.stage !== 'proposed' && !gone
  const unit = member && !vacated
  const closed = facts.stage === 'done' || Boolean(facts.closedReason)
  return { member, unit, done: unit && closed, solo: !gone && !vacated }
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
    loading: agg.pending > 0,
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

/** A cold row asked for: its load is queued. */
export const LOADING = Symbol('loading')
export type Loaded<T> = T | typeof LOADING | undefined

/** What the roll-up parts read. Tracked in the live pool; plain in the rebuild. */
export interface RollupInputs {
  /** The row when resident; `LOADING` when cold (the read queues its load); undefined when unknown. */
  loadedIssue(id: string): Loaded<SliceIssue>
  /**
   * R-ROLL's progress facts of a known issue, hot or cold, WITHOUT loading
   * it: a cold one through the cold-read path (counted, fenced, tracked);
   * undefined when unknown.
   */
  progressFacts(id: string): ProgressFacts | undefined
  /** The `spinOffs` bucket's size (free, like `Map.size`; tracked). */
  spinOffCount(id: string): number
  /** The nest children: present rows whose `nestParent` is `id` (filed, not walked). */
  nested(id: string): Iterable<string>
  /**
   * The formal children: known issues whose declared `issue.parent` is `id`
   * (filed from each node's own forward slot, not re-listed).
   */
  formalChildren(id: string): Iterable<string>
  /** Another issue's parts (its node). */
  rollupNode(id: string): RollupSelf | undefined
  /** A session's cached seat verdict (`LOADING` while its row is cold). */
  seat(id: string): Loaded<SeatVerdict>
  /** A session's cached `lastActiveAt` (the pool's per-session activity cell). */
  seatActivity(id: string): number | null
  /** A session's cached presence facts (hot or cold). */
  presence(
    id: string,
  ): { readonly issueId: string | null | undefined; readonly open: boolean } | null
  spinOffIds(id: string): readonly string[]
  /** Count one composition run (the shared `ArmStats.rollupsDerived`). */
  counted(): void
}

/** The own row's facts the own part reads, cached apart from the seats. */
export interface OwnFacts {
  /** `ready`: resident; `cold`: its load is queued; `unknown`: not in the pool. */
  readonly state: 'ready' | 'cold' | 'unknown'
  readonly finished: boolean
  readonly decision: 'review' | null
  readonly continuedByField: boolean
}

/**
 * The roll-up parts of one issue node. The live pool holds one set of cells
 * per known issue; the rebuild computes them directly with the same
 * functions.
 */
export interface RollupSelf {
  readonly present: boolean
  readonly finished: boolean | undefined
  readonly rosterIds: readonly string[]
  readonly seatIds: readonly string[]
  readonly ownFacts: OwnFacts
  readonly ownAttention: OwnAttention
  readonly aggregate: Aggregate
  readonly unitOwn: UnitOwn
  readonly unitsBelow: Units
  /** Some explicit session of its own is on the task (`openIssues`, `mission.ts:582-590`). */
  readonly openOwn: boolean
  /** The latest seat activity in the visible subtree (`Rollup.seatActivity`). */
  readonly seatActivity: number | null
  /** A live spin-off descendant that started or is staffed (`liveSpinOffTip`), and cold ones pending. */
  readonly tip: { readonly found: boolean; readonly pending: number }
  /** The row's roll-up fields; undefined when the issue is unknown. */
  readonly rollup: Rollup | undefined
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
  const issue = input.loadedIssue(id)
  if (issue === LOADING) return COLD_FACTS
  if (issue === undefined) return UNKNOWN_FACTS
  return {
    state: 'ready',
    finished: issue.stage === 'done' || issue.closedReason != null,
    decision: pendingDecisionOf(issue),
    continuedByField: continuedByField(issue),
  }
}

/** `openIssues.has(id)`: an explicit session with this `issueId` present on the task. */
export function openOwnPartOf(input: RollupInputs, id: string, self: RollupSelf): boolean {
  for (const sessionId of self.seatIds) {
    const presence = input.presence(sessionId)
    if (presence !== null && presence.issueId === id && presence.open) return true
  }
  return false
}

/**
 * Whether a live spin-off descendant has started or is staffed (the tip
 * `liveSpinOffTip` would name exists, `mission.ts:740-791`), over the declared
 * `spinOffs` relation: each spin-off's own verdict, then its own `tip`.
 */
export function tipPartOf(
  input: RollupInputs,
  id: string,
): { readonly found: boolean; readonly pending: number } {
  let pending = 0
  for (const spinOffId of input.spinOffIds(id)) {
    const issue = input.loadedIssue(spinOffId)
    if (issue === LOADING) {
      pending += 1
      continue
    }
    if (issue === undefined || issue.archived === true || issue.deletedAt != null) continue
    const node = input.rollupNode(spinOffId)
    if (leftMission(issue) || node?.openOwn === true) return { found: true, pending: 0 }
    const below = node?.tip
    if (below?.found === true) return { found: true, pending: 0 }
    pending += below?.pending ?? 0
  }
  return { found: false, pending }
}

/**
 * The row's own part: its seats (the retained roster: retained, not exited,
 * no shell, not archived) and its own pending decision (`rowPendingDecision`,
 * `row-attention.ts:136-152`). Empty for an issue with no row.
 */
export function ownAttentionPartOf(input: RollupInputs, self: RollupSelf): OwnAttention {
  if (!self.present) return EMPTY_OWN
  const facts = self.ownFacts
  if (facts.state === 'cold') return PENDING_OWN
  if (facts.state === 'unknown') return EMPTY_OWN
  let own = EMPTY_OWN
  let pending = 0
  for (const sessionId of self.rosterIds) {
    const seat = input.seat(sessionId)
    if (seat === LOADING) pending += 1
    else if (seat !== undefined) own = withSeat(own, seat)
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
  return pending === 0 && !deciding ? own : { ...own, deciding, pending: own.pending + pending }
}

/** The visible-subtree aggregate: own part plus each nest child's cached aggregate. */
export function aggregatePartOf(input: RollupInputs, id: string, self: RollupSelf): Aggregate {
  input.counted()
  const own = self.ownAttention
  if (own.cold) return aggregate({ own, children: [] })
  const children: Aggregate[] = []
  for (const childId of input.nested(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push(child.aggregate)
  }
  return aggregate({ own, children })
}

/**
 * This issue's own contribution to its formal ancestors' progress, hot or
 * cold, never loading it (option A): its progress facts, and `vacated`
 * (`isVacatedOrigin`, `mission.ts:794-808`: no own session on the task, and
 * a spin-off), asked in that order so a row with no spin-off never reads
 * its sessions.
 */
export function unitOwnPartOf(input: RollupInputs, id: string, self: RollupSelf): UnitOwn {
  const facts = input.progressFacts(id)
  if (facts === undefined) return NO_UNIT
  const vacated = input.spinOffCount(id) > 0 && !self.openOwn
  return unitOwnOf(facts, vacated)
}

/** The formal closure's counts: each formal child's own contribution and its own closure. */
export function unitsBelowPartOf(input: RollupInputs, id: string): Units {
  input.counted()
  const children: { own: UnitOwn; below: Units }[] = []
  for (const childId of input.formalChildren(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push({ own: child.unitOwn, below: child.unitsBelow })
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
  self: RollupSelf,
): number | null {
  input.counted()
  if (!self.present || self.ownFacts.state === 'cold') return null
  const own = self.rosterIds.map((sessionId) => input.seatActivity(sessionId))
  const children: (number | null)[] = []
  for (const childId of input.nested(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push(child.seatActivity)
  }
  return latestOf({ own, children })
}

export function rollupPartOf(self: RollupSelf): Rollup | undefined {
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
export function waitingPartOf(self: RollupSelf): boolean {
  return self.finished !== undefined && askingOf(self.aggregate, self.finished)
}

// ------------------------------------------------------------ live cells

/**
 * What the roll-up collection needs from the pool. Every door is tracked in
 * the live pool (cells record their reads) and plain in the rebuild's
 * inputs, which are built separately.
 */
export interface RollupHost {
  readonly graph: CellGraph
  readonly relations: RelationReader
  /** The engine's raw forward key (tracked on the row's own slot; no presence read). */
  forward(from: EntityName, id: string, relation: string): string | null
  /** An issue's row, resident or cold (cold without loading it). */
  issueRow(id: string): SliceIssue | undefined
  /** A session's row, resident or cold (cold without loading it). */
  sessionRow(id: string): SliceSession | undefined
  /** Whether the row is in the pool's tables (its presence only). */
  resident(entity: 'issue' | 'session', id: string): boolean
  /** Whether the row is known but not resident (queues its load). */
  loading(entity: 'issue' | 'session', id: string): boolean
  /** Whether the issue is known at all, hot or cold (untracked: maintenance). */
  knownIssue(id: string): boolean
  /** A known issue's visibility parts; undefined otherwise. */
  visibleIssue(id: string): VisibleParts | undefined
  /** A known session's parts; undefined otherwise. */
  sessionParts(id: string): SessionVisibleParts | undefined
  /** A session's cached `lastActiveAt` (the pool's per-session activity cell). */
  seatActivity(id: string): number | null
  /** The issue's retained live roster (its seats at the clock, id order). */
  rosterOf(id: string): readonly string[]
  /** Count one composition run (the shared `ArmStats.rollupsDerived`). */
  counted(): void
}

/** One issue's roll-up cells, each its own cell, created on first read. */
class IssueRollup implements RollupSelf {
  private readonly cells = new Map<string, Cell<unknown>>()

  constructor(
    readonly id: string,
    private readonly collection: RollupCollection,
  ) {}

  private read<K>(name: string, compute: () => K, equals: Equals<K>): K {
    let cell = this.cells.get(name) as Cell<K> | undefined
    if (cell === undefined) {
      const { graph } = this.collection.host
      const made: Cell<K> = graph.cell(`rollup:${name}:${this.id}`, compute, equals)
      cell = made
      this.cells.set(name, cell)
    }
    return this.collection.host.graph.read(cell)
  }

  private get inputs(): RollupInputs {
    return this.collection.inputs
  }

  get present(): boolean {
    return this.collection.host.visibleIssue(this.id)?.present ?? false
  }

  get finished(): boolean | undefined {
    return this.collection.host.visibleIssue(this.id)?.standing?.finished
  }

  get rosterIds(): readonly string[] {
    return this.collection.host.rosterOf(this.id)
  }

  get seatIds(): readonly string[] {
    return this.collection.host.visibleIssue(this.id)?.seatIds ?? EMPTY_IDS
  }

  get ownFacts(): OwnFacts {
    return this.read('ownFacts', () => ownFactsPartOf(this.inputs, this.id), sameData)
  }

  get ownAttention(): OwnAttention {
    return this.read('ownAttention', () => ownAttentionPartOf(this.inputs, this), sameData)
  }

  get aggregate(): Aggregate {
    return this.read('aggregate', () => aggregatePartOf(this.inputs, this.id, this), sameData)
  }

  get unitOwn(): UnitOwn {
    return this.read('unitOwn', () => unitOwnPartOf(this.inputs, this.id, this), sameData)
  }

  get unitsBelow(): Units {
    return this.read('unitsBelow', () => unitsBelowPartOf(this.inputs, this.id), sameData)
  }

  get openOwn(): boolean {
    return this.read('openOwn', () => openOwnPartOf(this.inputs, this.id, this), Object.is)
  }

  get seatActivity(): number | null {
    return this.read('seatActivity', () => seatActivityPartOf(this.inputs, this.id, this), Object.is)
  }

  get tip(): { readonly found: boolean; readonly pending: number } {
    return this.read('tip', () => tipPartOf(this.inputs, this.id), sameData)
  }

  get rollup(): Rollup | undefined {
    return this.read('rollup', () => rollupPartOf(this), sameData)
  }

  get waiting(): boolean {
    return this.read('waiting', () => waitingPartOf(this), Object.is)
  }

  /** Cells held (tests: the bootstrap census). */
  cellCount(): number {
    return this.cells.size
  }

  dispose(): void {
    const { graph } = this.collection.host
    for (const cell of this.cells.values()) graph.dispose(cell)
    this.cells.clear()
  }
}

const EMPTY_IDS: readonly string[] = Object.freeze([])
const EMPTY_SET: ReadonlySet<string> = new Set()

function verdictEquals(a: Loaded<SeatVerdict>, b: Loaded<SeatVerdict>): boolean {
  if (a === LOADING || b === LOADING || a === undefined || b === undefined) return a === b
  return sameData(a, b)
}

/**
 * The roll-up collection: per-issue roll-up cells and per-session seat
 * verdicts (created on first read, disposed with their row), and the two
 * maintained child filings the compositions read.
 *
 * THE FILINGS. `nestedBy` files every known issue under its `nestParent`
 * (the attention tree); `formalBy` under its declared `issue.parent` forward
 * key (the progress tree). Each is maintained from per-issue filing cells —
 * `fileNest` over the visibility `nestParent` part, `fileFormal` over the
 * engine's forward slot — which report their id when their value moves; the
 * pool calls `settleFilings` after the drain, which moves exactly the
 * reported ids and dirties the old and new parents' slots. Nothing lists
 * dependencies by hand: each filing cell recorded what it read. The
 * compositions read the filings through tracked doors (`nested`,
 * `formalChildren`), so a move re-runs exactly the old and new parents'
 * compositions.
 */
export class RollupCollection {
  readonly inputs: RollupInputs
  private readonly issues = new Map<string, IssueRollup>()
  private readonly verdicts = new Map<string, Cell<Loaded<SeatVerdict>>>()
  private readonly fileNestCells = new Map<string, Cell<string | null>>()
  private readonly fileFormalCells = new Map<string, Cell<string | null>>()
  private readonly filedNest = new Map<string, string | null>()
  private readonly filedFormal = new Map<string, string | null>()
  private readonly nestedBy = new Map<string, Set<string>>()
  private readonly formalBy = new Map<string, Set<string>>()
  private readonly nestedSlots = new DepIndex<string>('rollup.nested')
  private readonly formalSlots = new DepIndex<string>('rollup.formal')
  private readonly reportedNest = new Set<string>()
  private readonly reportedFormal = new Set<string>()

  constructor(readonly host: RollupHost) {
    const collection = this
    this.inputs = {
      loadedIssue: (id) => collection.loadedIssue(id),
      progressFacts: (id) => collection.progressFacts(id),
      spinOffCount: (id) => host.relations.size('issue', id, 'spinOffs'),
      nested: (id) => collection.nested(id),
      formalChildren: (id) => collection.formalChildren(id),
      rollupNode: (id) => collection.node(id),
      seat: (id) => collection.seat(id),
      seatActivity: (id) => host.seatActivity(id),
      presence: (id) => collection.presence(id),
      spinOffIds: (id) => [...host.relations.many('issue', id, 'spinOffs')].sort(),
      counted: () => host.counted(),
    }
  }

  // ------------------------------------------------------------ input doors

  private loadedIssue(id: string): Loaded<SliceIssue> {
    const { host } = this
    if (host.resident('issue', id)) return host.issueRow(id)
    return host.loading('issue', id) ? LOADING : undefined
  }

  private progressFacts(id: string): ProgressFacts | undefined {
    const row = this.host.issueRow(id)
    return row === undefined ? undefined : { stage: row.stage, closedReason: row.closedReason }
  }

  /** The nest children filed under `id` (tracked: a move dirties the composition). */
  nested(id: string): Iterable<string> {
    this.host.graph.track(this.nestedSlots, id)
    return this.nestedBy.get(id) ?? EMPTY_SET
  }

  /** The formal children filed under `id` (tracked: a move dirties the composition). */
  formalChildren(id: string): Iterable<string> {
    this.host.graph.track(this.formalSlots, id)
    return this.formalBy.get(id) ?? EMPTY_SET
  }

  /** A known issue's parts; undefined otherwise. Public for tests. */
  node(id: string): RollupSelf | undefined {
    if (!this.host.knownIssue(id)) return undefined
    let held = this.issues.get(id)
    if (held === undefined) {
      held = new IssueRollup(id, this)
      this.issues.set(id, held)
    }
    return held
  }

  /** A session's cached seat verdict (`LOADING` while its row is cold). */
  seat(id: string): Loaded<SeatVerdict> {
    let cell = this.verdicts.get(id)
    if (cell === undefined) {
      const { host } = this
      cell = host.graph.cell<Loaded<SeatVerdict>>(
        `rollup:verdict:${id}`,
        () => {
          if (host.resident('session', id)) {
            const row = host.sessionRow(id)
            return row === undefined ? undefined : seatVerdictOf(row)
          }
          return host.loading('session', id) ? LOADING : undefined
        },
        verdictEquals,
      )
      this.verdicts.set(id, cell)
    }
    return this.host.graph.read(cell)
  }

  private presence(id: string): { readonly issueId: string | null | undefined; readonly open: boolean } | null {
    const parts = this.host.sessionParts(id)
    const retention = parts?.retention ?? null
    if (retention === null) return null
    return {
      issueId: retention.issueId,
      open: retention.archived !== true && retention.exited !== true,
    }
  }

  // ------------------------------------------------------------ public parts

  /** A known issue's aggregate (its attention composition); undefined otherwise. */
  aggregateOf(id: string): Aggregate | undefined {
    return this.node(id)?.aggregate
  }

  /** A known issue's formal closure counts; undefined otherwise. */
  unitsBelowOf(id: string): Units | undefined {
    return this.node(id)?.unitsBelow
  }

  /** A known issue's roll-up fields; undefined otherwise. */
  rollupViewOf(id: string): Rollup | undefined {
    return this.node(id)?.rollup
  }

  /** A known issue's own attention part; undefined otherwise (tests). */
  ownAttentionOf(id: string): OwnAttention | undefined {
    return this.node(id)?.ownAttention
  }

  /** A known issue's own progress contribution; undefined otherwise (tests). */
  unitOwnOf(id: string): UnitOwn | undefined {
    return this.node(id)?.unitOwn
  }

  /** Whether an explicit session of the issue is on the task (tests). */
  openOwnOf(id: string): boolean | undefined {
    return this.node(id)?.openOwn
  }

  /** A known issue's spin-off tip verdict; undefined otherwise (tests). */
  tipOf(id: string): { readonly found: boolean; readonly pending: number } | undefined {
    return this.node(id)?.tip
  }

  /** Whether anything in the issue's subtree waits on the human. */
  waitingOf(id: string): boolean {
    const node = this.node(id)
    return node === undefined ? false : waitingPartOf(node)
  }

  // ------------------------------------------------------------ filings

  /**
   * Bring the filings in line with which issues are known (call with the
   * issues a commit's deltas named, after invalidation): a newly known issue
   * gets its filing cells, read once and filed; a gone one loses them and is
   * unfiled. Raw doors only (maintenance reads nothing tracked).
   */
  sync(ids: Iterable<string>): void {
    for (const id of ids) {
      if (this.host.knownIssue(id)) {
        if (!this.fileNestCells.has(id)) {
          this.file(id)
          this.reportedNest.add(id)
          this.reportedFormal.add(id)
        }
      } else if (this.fileNestCells.has(id)) {
        this.unfile(id)
      }
    }
  }

  /**
   * Bring the filings in line with every known issue (a `replace`
   * re-partitions residency: enumerate once, raw doors, no fence).
   */
  syncAll(knownIds: Iterable<string>): void {
    const known = new Set(knownIds)
    for (const id of known) {
      if (!this.fileNestCells.has(id)) {
        this.file(id)
        this.reportedNest.add(id)
        this.reportedFormal.add(id)
      }
    }
    for (const id of [...this.fileNestCells.keys()]) {
      if (!known.has(id)) this.unfile(id)
    }
  }

  private file(id: string): void {
    const { graph } = this.host
    const nest = graph.cell<string | null>(
      `rollup:fileNest:${id}`,
      () => this.host.visibleIssue(id)?.nestParent ?? null,
      Object.is,
      () => {
        this.reportedNest.add(id)
      },
    )
    this.fileNestCells.set(id, nest)
    const formal = graph.cell<string | null>(
      `rollup:fileFormal:${id}`,
      () => this.host.forward('issue', id, 'parent'),
      Object.is,
      () => {
        this.reportedFormal.add(id)
      },
    )
    this.fileFormalCells.set(id, formal)
  }

  private unfile(id: string): void {
    const { graph } = this.host
    const nest = this.fileNestCells.get(id)
    if (nest !== undefined) {
      graph.dispose(nest)
      this.fileNestCells.delete(id)
    }
    const formal = this.fileFormalCells.get(id)
    if (formal !== undefined) {
      graph.dispose(formal)
      this.fileFormalCells.delete(id)
    }
    this.moveFile(this.filedNest, this.nestedBy, this.nestedSlots, id, null)
    this.moveFile(this.filedFormal, this.formalBy, this.formalSlots, id, null)
    this.reportedNest.delete(id)
    this.reportedFormal.delete(id)
    const held = this.issues.get(id)
    if (held !== undefined) {
      held.dispose()
      this.issues.delete(id)
    }
  }

  /**
   * The filing handler (after the drain): move exactly the reported ids and
   * dirty their old and new parents' slots. Reads no row.
   */
  settleFilings(): void {
    const { graph } = this.host
    if (this.reportedNest.size > 0) {
      const reported = [...this.reportedNest]
      this.reportedNest.clear()
      for (const id of reported) {
        const cell = this.fileNestCells.get(id)
        if (cell === undefined) continue
        this.moveFile(this.filedNest, this.nestedBy, this.nestedSlots, id, graph.read(cell))
      }
    }
    if (this.reportedFormal.size > 0) {
      const reported = [...this.reportedFormal]
      this.reportedFormal.clear()
      for (const id of reported) {
        const cell = this.fileFormalCells.get(id)
        if (cell === undefined) continue
        this.moveFile(this.filedFormal, this.formalBy, this.formalSlots, id, graph.read(cell))
      }
    }
  }

  private moveFile(
    filed: Map<string, string | null>,
    by: Map<string, Set<string>>,
    slots: DepIndex<string>,
    id: string,
    parent: string | null,
  ): void {
    const before = filed.get(id)
    if (before === parent) return
    if (before !== undefined && before !== null) {
      const siblings = by.get(before)
      if (siblings !== undefined) {
        siblings.delete(id)
        if (siblings.size === 0) by.delete(before)
      }
      this.host.graph.invalidateKey(slots, before)
    }
    if (parent !== null) {
      let siblings = by.get(parent)
      if (siblings === undefined) {
        siblings = new Set()
        by.set(parent, siblings)
      }
      siblings.add(id)
      this.host.graph.invalidateKey(slots, parent)
    }
    if (parent === null) filed.delete(id)
    else filed.set(id, parent)
  }

  /** A session left the pool: its verdict cell goes (its readers re-run). */
  forgetSession(id: string): void {
    const cell = this.verdicts.get(id)
    if (cell === undefined) return
    this.host.graph.dispose(cell)
    this.verdicts.delete(id)
  }

  /** Filing cells held (tests: lifecycle). */
  held(): number {
    return this.fileNestCells.size
  }

  /** Cells held, by kind (tests: the bootstrap census names every live cell). */
  heldCells(): { filings: number; verdicts: number; rollupParts: number } {
    let rollupParts = 0
    for (const held of this.issues.values()) rollupParts += held.cellCount()
    return {
      filings: this.fileNestCells.size + this.fileFormalCells.size,
      verdicts: this.verdicts.size,
      rollupParts,
    }
  }

  /** Dispose every cell and forget the filings (the pool's dispose). */
  clear(): void {
    const { graph } = this.host
    for (const cells of this.issues.values()) cells.dispose()
    this.issues.clear()
    for (const cell of this.verdicts.values()) graph.dispose(cell)
    this.verdicts.clear()
    for (const cell of this.fileNestCells.values()) graph.dispose(cell)
    this.fileNestCells.clear()
    for (const cell of this.fileFormalCells.values()) graph.dispose(cell)
    this.fileFormalCells.clear()
    this.filedNest.clear()
    this.filedFormal.clear()
    this.nestedBy.clear()
    this.formalBy.clear()
    this.nestedSlots.clear()
    this.formalSlots.clear()
    this.reportedNest.clear()
    this.reportedFormal.clear()
  }
}

// ------------------------------------------------------------ direct (rebuild)

/** The direct roll-up parts of `id` (the rebuild), memoized for one pass. */
export function directRollupParts(
  input: RollupInputs,
  id: string,
  memo: Map<string, RollupSelf>,
  self: {
    readonly present: boolean
    readonly finished: boolean | undefined
    readonly rosterIds: readonly string[]
    readonly seatIds: readonly string[]
  },
): RollupSelf {
  const held = memo.get(id)
  if (held !== undefined) return held
  const values = new Map<string, unknown>()
  const once = <T>(key: string, compute: () => T): T => {
    if (!values.has(key)) values.set(key, compute())
    return values.get(key) as T
  }
  const parts: RollupSelf = {
    get present() {
      return self.present
    },
    get finished() {
      return self.finished
    },
    get rosterIds() {
      return self.rosterIds
    },
    get seatIds() {
      return self.seatIds
    },
    get ownFacts() {
      return once('ownFacts', () => ownFactsPartOf(input, id))
    },
    get ownAttention() {
      return once('ownAttention', () => ownAttentionPartOf(input, parts))
    },
    get aggregate() {
      return once('aggregate', () => aggregatePartOf(input, id, parts))
    },
    get unitOwn() {
      return once('unitOwn', () => unitOwnPartOf(input, id, parts))
    },
    get unitsBelow() {
      return once('unitsBelow', () => unitsBelowPartOf(input, id))
    },
    get openOwn() {
      return once('openOwn', () => openOwnPartOf(input, id, parts))
    },
    get seatActivity() {
      return once('seatActivity', () => seatActivityPartOf(input, id, parts))
    },
    get tip() {
      return once('tip', () => tipPartOf(input, id))
    },
    get rollup() {
      return once('rollup', () => rollupPartOf(parts))
    },
  }
  memo.set(id, parts)
  return parts
}
