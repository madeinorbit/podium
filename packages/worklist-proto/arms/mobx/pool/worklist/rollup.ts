/**
 * POD-4571 (Mb3) — the row roll-ups: `phase`, `working`, `asking`,
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
 *   under it (`rows.ts:331-334`, `attach`). The nest children are the inverse
 *   of Mb1's `nestParent` (the nearest present ancestor by the raw `parentId`,
 *   or the started-by owner), maintained per node like the visible set
 *   (`visible.ts` `VisibleCollection.sync`). A hidden issue has no row and so
 *   no own part; its visible descendants nest under the nearest visible
 *   ancestor, which is the legacy walk-past (`rows.ts:272-283`).
 * - PROGRESS (`progressDone` / `progressTotal`) composes over the declared
 *   `issue.parent` / `issue.children` relation, the formal closure
 *   `missionRollup` counts (`mission.ts:1353-1404`, members
 *   `formalMemberIds`, `mission.ts:1054`). The relation drops archived and
 *   deleted children (schema `where`, `missionParentId`), which is the legacy
 *   cut of an archived branch. The children are read from a filing of each
 *   node's own `parent` forward slot (`VisibleCollection.childrenBy`), not by
 *   re-listing the `children` bucket: a re-listing reads every sibling id
 *   (the fence counts each), so a re-parent would cost both families, where
 *   the filing costs the moved row's own slot (#7's budget, POD-4609).
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
 * COLD ROWS, TWO WAYS (coordinator ruling 2026-09-24, option A).
 * - PROGRESS never loads. A formal child that is cold (under the declared
 *   rule `unlessShown`, exactly a closed child nothing can show) gives its
 *   unit facts through the cold-read path (`RollupInputs.progressFacts`:
 *   the pool's `coldRow`, a counted, fenced read by id through the feed,
 *   tracked by residency's per-id atom), limited by type to the fields
 *   R-ROLL's progress reads (`ProgressFacts`: `stage`, `closedReason`), plus
 *   the `spinOffs` bucket's size and Mb1's cached session presence for
 *   `vacated`. Loading them instead queued 282 closed issues at 1x first
 *   paint and, by relinking every row it loaded, hid the pool gate's
 *   `coldRelinkSkipped` plant on two of three seeds.
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

import type { RowView } from '../../../../shared/src/row-view'
import type { SliceIssue, SlicePhase, SliceSession } from '../../../../shared/src/slice-types'

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

/** `attentionGroup` (`client-core/src/focus.ts:25-60`). */
export function attentionGroup(session: SliceSession): 'needsYou' | 'working' | 'idle' {
  if (session.offer) return 'needsYou'
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
  if (!session.offer) return attentionGroup(session) === 'needsYou'
  return attentionGroup({ ...session, offer: undefined }) === 'needsYou'
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

/** One seat's contribution, under either kind of row. Per session, cached. */
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
  /** Some seat anywhere in it (`rowSessions(row).length > 0`). */
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
 * nest children's aggregates (`rowSessions` = own sessions plus attached
 * children's aggregate sessions, `rows.ts:331-334`). No store, no row, no
 * relation: values in, a value out.
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
  'not planned': 'cancelled',
  canceled: 'cancelled',
  dupe: 'duplicate',
}

/** `issueAbandoned` (the canonical close reason; `views.ts` has the row's copy). */
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
}): Rollup {
  const { finished, own, agg, self, below } = input
  const fromChildren = below.members > 0
  return {
    phase: phaseOf(agg, finished),
    working: agg.working,
    asking: askingOf(agg, finished),
    progressDone: fromChildren ? below.done : self.done ? 1 : 0,
    progressTotal: fromChildren ? below.units : self.solo ? 1 : 0,
    workingSince: own.workingSince,
    loading: agg.pending > 0,
  }
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
  /** The nest children: present rows whose `nestParent` is `id` (maintained, not walked). */
  nested(id: string): Iterable<string>
  /**
   * The formal children: known issues whose declared `issue.parent` is `id`
   * (maintained from each node's own forward slot, not re-listed).
   */
  formalChildren(id: string): Iterable<string>
  /** Another issue's parts (its node). */
  rollupNode(id: string): RollupParts | undefined
  /** A session's cached seat verdict (`LOADING` while its row is cold). */
  seat(id: string): Loaded<SeatVerdict>
  /** A session's cached presence facts (Mb1's `retention`, hot or cold). */
  presence(id: string): { readonly issueId: string | null | undefined; readonly open: boolean } | null
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

/** The roll-up parts of one issue node. */
export interface RollupParts {
  /** The own row's decision facts (re-run only when the own row changes). */
  readonly ownFacts: OwnFacts
  /** The declared `issue.parent` forward key: where this node is filed for progress. */
  readonly formalParent: string | null
  readonly ownAttention: OwnAttention
  readonly aggregate: Aggregate
  readonly unitOwn: UnitOwn
  readonly unitsBelow: Units
  /** Some explicit session of its own is on the task (`openIssues`, `mission.ts:582-590`). */
  readonly openOwn: boolean
  /** A live spin-off descendant that started or is staffed (`liveSpinOffTip`), and cold ones pending. */
  readonly tip: { readonly found: boolean; readonly pending: number }
  /** The row's roll-up fields; undefined when the issue is unknown. */
  readonly rollup: Rollup | undefined
}

/** The parts a roll-up part reads from its own node (Mb1's visibility parts included). */
export interface RollupSelf extends RollupParts {
  readonly present: boolean
  readonly finished: boolean | undefined
  readonly rosterIds: readonly string[]
  readonly seatIds: readonly string[]
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
 * The row's own part: its seats (Mb1's roster: retained, not exited, no
 * shell, not archived) and its own pending decision (`rowPendingDecision`,
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

/**
 * The declared `issue.parent` forward key, from the node's own row (Mb1's
 * `standing`, the engine's `relationRef`): the progress filing's key. Not
 * `one()`: that also reads the parent's presence, so loading a parent would
 * re-run every cold child's filing (one presence probe each).
 */
export function formalParentPartOf(self: { readonly standing: { readonly formalParent: string | null } | undefined }): string | null {
  return self.standing?.formalParent ?? null
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
export function unitsBelowPartOf(input: RollupInputs, id: string, self: RollupSelf): Units {
  input.counted()
  const children: { own: UnitOwn; below: Units }[] = []
  for (const childId of input.formalChildren(id)) {
    const child = input.rollupNode(childId)
    if (child !== undefined) children.push({ own: child.unitOwn, below: child.unitsBelow })
  }
  return unitsOf({ children })
}

export function rollupPartOf(self: RollupSelf): Rollup | undefined {
  if (self.finished === undefined) return undefined
  return rollupOf({
    finished: self.finished,
    own: self.ownAttention,
    agg: self.aggregate,
    self: self.unitOwn,
    below: self.unitsBelow,
  })
}

/** For the fold verdict (R-GROUP 3's "nothing waiting"): the aggregate alone, not the progress. */
export function waitingPartOf(self: RollupSelf): boolean {
  return self.finished !== undefined && askingOf(self.aggregate, self.finished)
}
