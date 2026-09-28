/**
 * POD-4569 (Mb1) — the worklist's visible collection and its order, over the
 * pool's graph.
 *
 * THE RULE IS NOT DEFINED HERE. Which issue earns a row is the slice spec's
 * R-VIS (`docs/plans/pod-4441-round-two-slice.md` §3, "R-VIS — visible
 * predicate"), whose executable definition is the legacy derivation the
 * parity oracle runs (`buildUnifiedRows` and `nestStartedByIssues`,
 * `client-core/src/viewmodels/slices/worklist/rows.ts`, with
 * `sessionRetainsWorklistRow` / `issueVisibleInSidebar` from `visibility.ts`).
 * The functions below are that rule re-expressed as parts over the graph,
 * each citing the legacy line it follows. The order is L1b's `rankOf` /
 * `compareRank` (`shared/src/row-view.ts`, spec R-ORDER), applied at view
 * time over the visible set (audit §7: Linear sorts a collection when a view
 * reads it).
 *
 * ONE RULE, TWO CALLERS (as `views.ts`). The live pool runs each part in its
 * own computed on a node (`IssueNode`, `SessionNode`); the rebuild runs the
 * same functions directly over plain maps (`directVisibility`, `rebuild.ts`).
 *
 * THE PARTS OF ONE ISSUE, each reading only its own inputs:
 * - `standing`: the own row's facts (structural exclusion, finished, the
 *   sessionless keep's inputs, the raw parent, the rank). Hot OR cold: a cold
 *   row is read by id through the feed (`VisibleInputs.issueRow`). Under the
 *   declared cold rule (`unlessShown`, POD-4665: a closed issue is cold only
 *   when nothing can still show it) no visible row is cold, so this read
 *   answers the HIDDEN side: a cold row's visibility is decided (it stays
 *   hidden) without loading it. Under the earlier rule 376 of 732 visible
 *   rows at 1x were cold (POD-4569 NOTES).
 * - `seatIds` (R2, `issue.sessions`, POD-4678: the maintained `seats`
 *   mirror, one element per bucket move) and `memberIds` (R2 then R3: the
 *   sessions of `issue.worktree` with no `issueId`, `session-ownership.ts`
 *   `indexSessionOwnership`): maintained reads, cached, so a member's change
 *   never re-reads its family.
 * - `retainedSeatIds`: the retained seats (`rows.ts:71-76`,
 *   `retainedSessions`: seat members retained at the clock, exited ones
 *   included), whose stamps the own-row `activityAt` takes (`rows.ts:98-116`,
 *   POD-4679); `retained` is "any" and `rosterIds` the ones not exited.
 * - `retained` / `liveRoster` / `unread`: re-composed from each member's
 *   cached part (`SessionNode.retention`, `.activityMs`) and the clock as
 *   deadlines (`passed(t)`): a tick wakes only the rows whose deadline it
 *   crosses.
 * - `flat`: the flat pass (`rows.ts:59-107`).
 * - `keeps` / `keptBelow`: the rescue (`rows.ts:121-158`) read DOWN the
 *   children relation: a parent is kept by a child that is flat or kept, and
 *   the walk passes through any non-excluded child. Composed from each child's
 *   cached `keeps`, never a subtree walk.
 * - `present`: has a row before nesting (flat, or rescued).
 * - `nestParent` / `placed`: nesting (`nestStartedByIssues`, `rows.ts:254-359`)
 *   decides whether a present row reaches the screen: a nested row shows
 *   under its nest parent, a top-level one unless it is agent-audience
 *   (`rows.ts:354`). The nest parent is the nearest PRESENT ancestor by the
 *   raw `parentId` (`rows.ts:271-283`), else, for a parentless non-spin-off,
 *   the present issue owning its `startedBySession` (`rows.ts:288-305`).
 * - `visible` = `present && placed`.
 * - `rank`: L1b `rankOf` over the own row (read by the order only).
 *
 * THE COLLECTION IS MAINTAINED, NOT RE-ENUMERATED. Every issue with a node
 * (POD-4705: the lazy closure — visible, present and keeping rows, their
 * ancestors, and their formal subtrees — not every known issue) holds one
 * reaction on its `visible`, which adds or deletes its id in one observable
 * set. A row without a node reads as hidden and keeping nothing, which the
 * closure guarantees by construction (the plain pass evaluates every known
 * issue, so anything present or keeping is in the closure). Nodes are created
 * and disposed per changed issue record (`ensure`); the only whole-table walk
 * is `enumerate.ts` `knownIssueIds`, at a `replace`. So a membership change
 * costs its own node's parts, never the table (a computed re-enumerating the
 * table would count every id on every flip: POD-4621's `keys()` reads).
 *
 * CROSS-NODE READS STAY TRACKED. A part that looks up another issue's node
 * reads the nodes map's slot for that id, so creating the node later
 * re-runs the reader: a parent whose child had no node re-reads the child's
 * `keeps` once the child is ensured, and likewise up the nest chain.
 *
 * THE ORDER is a computed over the set: the visible ids sorted by each node's
 * cached `rank` (`compareRank`). It re-runs when membership changes or a
 * VISIBLE row's rank changes (it reads only visible nodes' ranks), reads no
 * row (ranks are cached), sorts exactly the visible ids, and is shallow-equal
 * across runs that leave the order unchanged, so the list redraws only when
 * the order moves, and then commits no row (keyed slots move).
 */

import {
  compareShallow,
  computed,
  computedStruct,
  makeObservable,
  type ObservableMap,
  type ObservableSet,
  observable,
  reaction,
} from 'mobx'
import type { RelationReader } from '../../../../shared/src/instrument/reads'
import { compareRank, type RowRank, type RowView, rankOf } from '../../../../shared/src/row-view'
import type { SliceIssue, SliceSession } from '../../../../shared/src/slice-types'
import { relationRef } from '../relations'
import { bandOf, parseMs } from '../views'
import { type Placement, placementPartOf, withWaiting } from './groups'
import {
  type Aggregate,
  aggregatePartOf,
  formalParentPartOf,
  type Loaded,
  type OwnAttention,
  type OwnFacts,
  openOwnPartOf,
  ownAttentionPartOf,
  ownFactsPartOf,
  type ProgressFacts,
  type Rollup,
  type RollupInputs,
  type RollupParts,
  rollupPartOf,
  type SeatVerdict,
  seatActivityPartOf,
  seatVerdictOf,
  tipPartOf,
  type UnitOwn,
  type Units,
  unitOwnPartOf,
  unitsBelowPartOf,
  waitingPartOf,
} from './rollup'

/** `SIDEBAR_FINISHED_GRACE_MS` (`visibility.ts:18`). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** `SIDEBAR_FINISHED_UNREAD_WINDOW_MS` (`visibility.ts:22`). */
export const FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Everything the visibility parts read. Tracked in the live pool; plain in the rebuild. */
export interface VisibleInputs {
  readonly relations: RelationReader
  /** An issue's row, hot or cold (a cold one read by id through the feed); undefined when unknown. */
  issueRow(id: string): SliceIssue | undefined
  /** A session's row, hot or cold; undefined when unknown. */
  sessionRow(id: string): SliceSession | undefined
  /** Another issue's parts (its node in the live pool); undefined when unknown. */
  issue(id: string): IssueVisibility | undefined
  /** A session's parts (its node in the live pool). */
  session(id: string): SessionVisibility
  /**
   * The issue's read cursor (`readAt`): a non-empty string, null when the row
   * carries none, undefined when the issue is unknown (POD-4686). The live
   * pool reads its read-state lane, which a mark-read writes without touching
   * the row's slot, so a click re-validates only the clicked row; the rebuild
   * reads the row it holds. The unread rollup derives the same `readMs` and
   * `hasRead` from it as `standingOf` used to.
   */
  issueRead(id: string): string | null | undefined
  /** `coarseNow > t`. */
  passed(t: number): boolean
  /** `coarseNow >= t`. */
  reached(t: number): boolean
  /** A RESIDENT issue row; `LOADING` when cold (the read queues its load): the roll-ups' read (Mb3). */
  loadedIssue(id: string): Loaded<SliceIssue>
  /** A RESIDENT session row; `LOADING` when cold (queued). */
  loadedSession(id: string): Loaded<SliceSession>
  /**
   * R-ROLL's progress facts of a known issue, hot or cold, never loading it
   * (the live pool: `issueRow`, whose cold read is counted, fenced and
   * tracked). Its own member so a plant can take away exactly its tracking.
   */
  progressFacts(id: string): ProgressFacts | undefined
  /** The present rows whose `nestParent` is `id` (the inverse, maintained; never a walk). */
  nested(id: string): Iterable<string>
  /** The known issues whose declared `issue.parent` is `id` (filed from each one's forward slot). */
  formalChildren(id: string): Iterable<string>
  /**
   * POD-4678 (item 1, plant/old) — the explicit seats (`issue.sessions`) as
   * the mirror IS the relation: every yielded id counts, exactly as `many()`
   * yields do. `[...seats].sort()` (landed code verbatim) re-reads the whole
   * family: over budget (true state). The plant uses it and must FAIL #10.
   */
  seats(id: string): Iterable<string>
  /**
   * POD-4678 (item 2, O(1) real) — the maintained SORTED seat list itself,
   * returned without iterating it. A membership change yields the new member
   * only. `seatIdsPartOf` reads it, never `seats()` nor `many()`.
   */
  seatList(id: string): readonly string[]
  /** One composition run, reported through the shared `ArmStats.rollupsDerived`. */
  counted(): void
}

// ------------------------------------------------------------ own-row facts

/** The own row's facts the visibility parts read (`rows.ts:62-107`). */
export interface Standing {
  /** Archived, deleted, `proposed` or a system-owned stage (`rows.ts:62-69`). */
  readonly excluded: boolean
  /** `stage === 'done' || closedReason != null` (`rows.ts:82`). */
  readonly finished: boolean
  readonly agent: boolean
  /** Human and planning / in_progress / review (`rows.ts:83-85`). */
  readonly activeHuman: boolean
  /**
   * The sessionless keep, before the clock (`rows.ts:86-96`): `keep`
   * (active human), `drop`, `fold` (a closed top-level issue: kept, no decay,
   * `visibility.ts:30`), or `decay` (a finished formal child: kept inside the
   * `issueVisibleInSidebar` window).
   */
  readonly sessionless: 'keep' | 'drop' | 'fold' | 'decay'
  /** Rescue-eligible: human and not finished (`rows.ts:147`). */
  readonly rescuable: boolean
  /** The raw `parentId` (the nesting walk follows it through ANY issue, `rows.ts:276-283`). */
  readonly parentId: string | null
  /** Parentless, not a spin-off, with a `startedBySession`: the started-by fallback applies (`rows.ts:288`). */
  readonly startedBy: string | null
  /** A draft with no worktree: a vessel when it has live sessions (`isDraftAgentVessel`). */
  readonly draftVessel: boolean
  /** `issueFinishedAt` (`issues.ts:310`): `closedAt ?? updatedAt`, epoch ms. */
  readonly finishedMs: number
  readonly updatedMs: number | null
  readonly deleted: boolean
  readonly pinned: boolean
  /**
   * The declared `issue.parent` forward key (Mb3): the relation engine's own
   * `relationRef` over this row (foreign key and `where`), so it costs this
   * row alone and never the parent's residency. The progress filing's key.
   */
  readonly formalParent: string | null
}

/** `isSystemOwnedIssueStage` (`model/src/entities/issue-vocabulary.ts:59`). */
function systemOwnedStage(stage: string): boolean {
  return stage === 'shipping'
}

/** `isClosedTopLevelIssue` (`slices/issues.ts:318-322`). */
function closedTopLevel(issue: SliceIssue): boolean {
  return issue.closedReason != null && !issue.parentId && issue.audience === 'human'
}

export function standingOf(issue: SliceIssue): Standing {
  const excluded =
    issue.archived === true ||
    issue.deletedAt != null ||
    issue.stage === 'proposed' ||
    systemOwnedStage(issue.stage)
  const finished = issue.stage === 'done' || issue.closedReason != null
  const human = issue.audience === 'human'
  const activeHuman =
    human &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  // `issueAwaitingMerge` reads branch and git state no slice row carries: never
  // true here (round two named it `issueAwaitingMerge`; deleted with that arm).
  const sessionless = activeHuman
    ? 'keep'
    : !finished
      ? 'drop'
      : closedTopLevel(issue)
        ? 'fold'
        : !issue.parentId || issue.audience === 'agent'
          ? 'drop'
          : 'decay'
  const spinOff = issue.deps?.some((dep) => dep.type === 'discovered-from') === true
  // No `readAt`: the cursor lives in the read-state lane (`VisibleInputs.issueRead`,
  // POD-4686), so a mark-read never re-runs this. `unreadPartOf` and the decay
  // branch of `flatPartOf` read the lane through `readCursorOf` below.
  return {
    excluded,
    finished,
    agent: issue.audience === 'agent',
    activeHuman,
    sessionless,
    rescuable: human && !finished,
    parentId: issue.parentId || null,
    startedBy:
      !issue.parentId && !spinOff && issue.startedBySession ? issue.startedBySession : null,
    draftVessel: issue.draft === true && !issue.worktreePath,
    finishedMs: parseMs(issue.closedAt ?? issue.updatedAt) ?? 0,
    updatedMs: parseMs(issue.updatedAt),
    deleted: issue.deletedAt != null,
    pinned: issue.pinned === true,
    formalParent: relationRef('issue', 'parent', issue),
  }
}

/**
 * The unread rollup's cursor from the read-state lane: the epoch ms of the
 * row's `readAt`, or null when absent or unparseable, and whether the row
 * carries one at all. Byte-identical to what `standingOf` derived from the
 * row before POD-4686 moved the cursor out of the slot (`''` normalizes to
 * null: `Boolean('')` is false and `Date.parse('')` is NaN, both ways).
 */
export function readCursorOf(raw: string | null | undefined): {
  readonly readMs: number | null
  readonly hasRead: boolean
} {
  if (raw == null) return { readMs: null, hasRead: false }
  const parsed = Date.parse(raw)
  return { readMs: Number.isFinite(parsed) ? parsed : null, hasRead: true }
}

/** The cursor as the lane stores it: a non-empty string, else null. */
export function readAtOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** L1b `rankOf` over the own row: the fields it reads, band from the clock (spec R-ORDER). */
export function rankPartOf(input: VisibleInputs, id: string): RowRank | undefined {
  const issue = input.issueRow(id)
  if (issue === undefined) return undefined
  const placement: Pick<RowView, 'id' | 'band' | 'sortKey' | 'createdAt' | 'seq'> = {
    id,
    band: bandOf(issue, input),
    sortKey: issue.sortKey ?? null,
    createdAt: issue.createdAt,
    seq: issue.seq,
  }
  return rankOf(placement as RowView)
}

// ------------------------------------------------------------ member sessions

/**
 * One session's part in its issue's visibility, without the clock and
 * without its issue (`sessionRetainsWorklistRow`, `visibility.ts:44-70`). An
 * idle session whose turn finished decays from its ISSUE's finish time when
 * that issue is finished, so `finish` names the case and the issue part
 * resolves it (`retainsAt`).
 */
export interface Retention {
  /** `issueId`, raw: `undefined` makes the session R3 (prefix-owned) material. */
  readonly issueId: string | null | undefined
  readonly archived: boolean
  /** Counts toward a row at all: not archived, not a shell (`isRowSeat`). */
  readonly seat: boolean
  readonly shell: boolean
  readonly exited: boolean
  /** `open`: never finished; `at`: finished at `ms`; `idleDone`: an idle finished turn. */
  readonly finish:
    | { readonly kind: 'open' }
    | { readonly kind: 'at'; readonly ms: number }
    | { readonly kind: 'idleDone'; readonly sinceRaw: string | null }
  readonly unread: boolean
  readonly readMs: number | null
}

/** `idleVerdictFinishedTurn` (`model/src/predicates/idle-verdict.ts:37-55`). */
function finishedTurn(kind: unknown): boolean {
  return kind === 'done' || kind === 'open_todos'
}

export function retentionOf(session: SliceSession | undefined): Retention | null {
  if (session === undefined) return null
  const state = session.agentState as
    | (SliceSession['agentState'] & { idle?: { kind?: unknown } })
    | undefined
  const phase = state?.phase
  const idleDone = phase === 'idle' && finishedTurn(state?.idle?.kind)
  const finishedRaw = session.stoppedAt ?? (phase === 'ended' ? state?.since : undefined)
  return {
    issueId: session.issueId,
    archived: session.archived === true,
    seat: session.archived !== true && session.agentKind !== 'shell',
    shell: session.agentKind === 'shell',
    exited: session.status === 'exited',
    finish: finishedRaw
      ? { kind: 'at', ms: Date.parse(finishedRaw) || 0 }
      : idleDone
        ? { kind: 'idleDone', sinceRaw: state?.since ?? null }
        : { kind: 'open' },
    unread: session.unread === true,
    readMs:
      typeof session.readAt === 'string' && session.readAt ? Date.parse(session.readAt) || 0 : null,
  }
}

/**
 * Whether a session with `retention` keeps its row at the clock, its issue's
 * `standing` resolving an idle finished turn (`visibility.ts:51-69`).
 */
export function retains(
  retention: Retention,
  issue: SliceIssue | undefined,
  standing: Standing | undefined,
  input: Pick<VisibleInputs, 'passed'>,
): boolean {
  let finishedMs: number
  if (retention.finish.kind === 'open') return true
  if (retention.finish.kind === 'at') finishedMs = retention.finish.ms
  else {
    if (standing?.finished !== true) return true
    const raw = issue?.closedAt ?? issue?.updatedAt ?? retention.finish.sinceRaw
    if (!raw) return true
    finishedMs = Date.parse(raw) || 0
  }
  if (retention.unread || retention.readMs === null) {
    return !input.passed(finishedMs + FINISHED_UNREAD_WINDOW_MS)
  }
  return !input.passed(Math.max(finishedMs, retention.readMs) + FINISHED_GRACE_MS)
}

/** A session's `lastActiveAt`, epoch ms (the unread rollup). */
export function activityMsOf(session: SliceSession | undefined): number | null {
  if (session?.lastActiveAt === undefined || session.lastActiveAt === '') return null
  const ms = Date.parse(session.lastActiveAt)
  return Number.isFinite(ms) ? ms : null
}

// ------------------------------------------------------------------ parts

/** One session's cached parts. */
export interface SessionVisibility {
  readonly retention: Retention | null
  readonly activityMs: number | null
  /** `session.issue` through the engine (members only: headless out, twins collapsed). */
  readonly issueLink: string | null
  /** `session.worktree` through the engine (the prefix relation). */
  readonly worktreeLink: string | null
  /** The seat's roll-up verdict (Mb3), from the RESIDENT row; `LOADING` while it is cold. */
  readonly verdict: Loaded<SeatVerdict>
}

/** A seat's verdict from the resident row (the roll-ups never read a cold session). */
export function verdictPartOf(
  input: Pick<VisibleInputs, 'loadedSession'>,
  id: string,
): Loaded<SeatVerdict> {
  const row = input.loadedSession(id)
  return row === undefined || typeof row === 'symbol' ? row : seatVerdictOf(row)
}

/** A session's parts computed directly (the rebuild). */
export function directSessionVisibility(
  input: Pick<VisibleInputs, 'relations' | 'sessionRow' | 'loadedSession'>,
  id: string,
): SessionVisibility {
  const row = input.sessionRow(id)
  return {
    retention: retentionOf(row),
    activityMs: activityMsOf(row),
    issueLink: input.relations.one('session', id, 'issue'),
    worktreeLink: input.relations.one('session', id, 'worktree'),
    verdict: verdictPartOf(input, id),
  }
}

/** One issue's parts (see the header), and its roll-up parts (Mb3, `rollup.ts`). */
export interface IssueVisibility extends RollupParts {
  readonly standing: Standing | undefined
  readonly seatIds: readonly string[]
  readonly memberIds: readonly string[]
  /** R3 alone: the lane's sessions with no `issueId`. */
  readonly laneMemberIds: readonly string[]
  readonly childIds: readonly string[]
  /** `issue.spinOffs` (R4, the inverse edge), id order: the roll-ups' vacated and continuation tests. */
  readonly spinOffIds: readonly string[]
  /**
   * The row's seats (`mine`, `rows.ts:71-79`): members that are seats (no
   * shell, not archived), retained at the clock and not exited. The draft
   * vessel's live-roster test is "any"; the roll-ups read each.
   */
  readonly rosterIds: readonly string[]
  /** The retained seats (`retainedSessions`), exited included: the own-row `activityAt`'s sessions. */
  readonly retainedSeatIds: readonly string[]
  readonly retained: boolean
  readonly liveRoster: boolean
  readonly unread: boolean
  readonly flat: boolean
  readonly keptBelow: boolean
  readonly keeps: boolean
  readonly present: boolean
  readonly nestParent: string | null
  readonly placed: boolean
  readonly visible: boolean
  readonly rank: RowRank | undefined
  /** `standing.finished`, or undefined for an unknown issue (the row picks its root verdict by it). */
  readonly finished: boolean | undefined
  /** R-GROUP 3's "nothing in the subtree waits" (Mb3): the aggregate under this row. */
  readonly waiting: boolean
}

/** The roll-up parts' inputs over the visibility inputs: nodes for rows, seats for sessions. */
export function rollupInputsOf(input: VisibleInputs): RollupInputs {
  return {
    loadedIssue: (id) => input.loadedIssue(id),
    progressFacts: (id) => input.progressFacts(id),
    spinOffCount: (id) => input.relations.size('issue', id, 'spinOffs'),
    nested: (id) => input.nested(id),
    formalChildren: (id) => input.formalChildren(id),
    rollupNode: (id) => input.issue(id),
    seat: (id) => input.session(id).verdict,
    seatActivity: (id) => input.session(id).activityMs,
    presence: (id) => {
      const retention = input.session(id).retention
      return retention === null
        ? null
        : { issueId: retention.issueId, open: !retention.archived && !retention.exited }
    },
    spinOffIds: (id) => input.issue(id)?.spinOffIds ?? [],
    counted: () => input.counted(),
  }
}

export function standingPartOf(input: VisibleInputs, id: string): Standing | undefined {
  const issue = input.issueRow(id)
  return issue === undefined ? undefined : standingOf(issue)
}

/** R2: the explicit members (`issue.sessions`: headless out, twins collapsed), id order. */
export function seatIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  // POD-4678 (item 2, O(1) real): the maintained SORTED list itself, returned
  // without iterating it — a membership change yields the new member only.
  // Never `seats()` (fenced, plant/old `[...seats].sort()` re-reads the whole
  // family and must FAIL #10) nor `many()`.
  return input.seatList(id)
}

/**
 * R3 alone: the lane's issueless sessions (`indexSessionOwnership`,
 * `session-ownership.ts:152-165`), id order. Its own part (POD-4571), so a
 * change to the EXPLICIT members never re-lists the lane's bucket (a burst
 * of new sessions on fifty issues read every lane's sessions through
 * `memberIds`, #10).
 *
 * POD-4671 ruling Sep27: read the maintained issueless set, never session
 * rows to filter — the same pattern as POD-4678's seat list. The worktree
 * comes through `issue.worktree` (the relation's forward, keyed by
 * `worktreePath` alone and union-aware), so a title-only write never re-runs
 * this: field-level dependency, not the whole issue row. The union roots
 * seat an unscanned checkout without a lane, so `issue.worktree` names the
 * issue's own path all the same. (Mailed to POD-4705; rebase onto its
 * landing before landing.)
 */
export function laneMemberIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  const worktree = input.relations.one('issue', id, 'worktree')
  if (worktree === null) return []
  return [...input.relations.issueless('worktree', worktree, 'sessions')].sort()
}

/**
 * R2 then R3: the explicit members, then the lane's (`laneMemberIds`), id
 * order, no duplicates. Unfiltered: each reader applies its seat rule.
 */
export function memberIdsPartOf(
  seatIds: readonly string[],
  laneMemberIds: readonly string[],
): readonly string[] {
  if (laneMemberIds.length === 0) return seatIds
  const members = new Set(seatIds)
  for (const sessionId of laneMemberIds) members.add(sessionId)
  return members.size === seatIds.length ? seatIds : [...members].sort()
}

export function childIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  return [...input.relations.many('issue', id, 'children')].sort()
}

export function spinOffIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  return [...input.relations.many('issue', id, 'spinOffs')].sort()
}

/**
 * The row's retained seats (`rows.ts:71-79`, `retainedSessions`): seat members
 * (no shell, not archived) retained at the clock, exited ones included, in
 * member order. The own-row `activityAt` reads their stamps (`rows.ts:98-116`,
 * POD-4679); `retained` is "any", `rosterIds` the ones not exited.
 */
export function retainedSeatIdsPartOf(
  input: VisibleInputs,
  id: string,
  self: IssueVisibility,
): readonly string[] {
  const standing = self.standing
  if (standing === undefined) return []
  let issue: SliceIssue | undefined
  const retained: string[] = []
  for (const sessionId of self.memberIds) {
    const retention = input.session(sessionId).retention
    if (retention === null || !retention.seat) continue
    if (retention.finish.kind === 'idleDone' && standing.finished) {
      issue ??= input.issueRow(id)
    }
    if (retains(retention, issue, standing, input)) retained.push(sessionId)
  }
  return retained
}

/** ≥1 retained member session (`rows.ts:70-76`). */
export function retainedPartOf(self: IssueVisibility): boolean {
  const standing = self.standing
  if (standing === undefined || standing.excluded) return false
  return self.retainedSeatIds.length > 0
}

/**
 * The row's seats (`rows.ts:71-79`: retained, then `sessionVisibleInLiveRoster`):
 * the retained seats not exited, in id order.
 */
export function rosterIdsPartOf(input: VisibleInputs, self: IssueVisibility): readonly string[] {
  const retained = self.retainedSeatIds
  const roster = retained.filter((sessionId) => input.session(sessionId).retention?.exited !== true)
  return roster.length === retained.length ? retained : roster
}

/** A retained member still on the live roster (`sessionVisibleInLiveRoster`): a draft vessel's test. */
export function liveRosterPartOf(self: IssueVisibility): boolean {
  return self.rosterIds.length > 0
}

/**
 * The replica's unread rollup (`issue-views.ts:391-410`): never read, updated
 * past the cursor, or an explicit non-shell seat (archived included) active
 * past it; a deleted issue reads as read.
 */
export function unreadPartOf(input: VisibleInputs, id: string, self: IssueVisibility): boolean {
  const standing = self.standing
  if (standing === undefined || standing.deleted) return false
  const { readMs } = readCursorOf(input.issueRead(id))
  if (readMs === null) return true
  if (standing.updatedMs !== null && standing.updatedMs > readMs) return true
  for (const sessionId of self.seatIds) {
    const session = input.session(sessionId)
    if (session.retention === null || session.retention.shell) continue
    const at = session.activityMs
    if (at !== null && at > readMs) return true
  }
  return false
}

/** The flat pass (`rows.ts:59-107`): retained sessions, else the sessionless keep. */
export function flatPartOf(input: VisibleInputs, id: string, self: IssueVisibility): boolean {
  const standing = self.standing
  if (standing === undefined || standing.excluded) return false
  if (self.retained) return true
  switch (standing.sessionless) {
    case 'keep':
    case 'fold':
      return true
    case 'drop':
      return false
    case 'decay': {
      // `issueVisibleInSidebar` (`visibility.ts:25-41`) for a finished child.
      const { readMs, hasRead } = readCursorOf(input.issueRead(id))
      if (self.unread || !hasRead) {
        return !input.passed(standing.finishedMs + FINISHED_UNREAD_WINDOW_MS)
      }
      return !input.passed(Math.max(standing.finishedMs, readMs ?? 0) + FINISHED_GRACE_MS)
    }
  }
}

/** Some child is flat or kept, through non-excluded children (`rows.ts:130-146`). */
export function keptBelowPartOf(input: VisibleInputs, self: IssueVisibility): boolean {
  for (const childId of self.childIds) {
    if (input.issue(childId)?.keeps === true) return true
  }
  return false
}

/** What this issue gives its parent's rescue: not excluded, and flat or kept below. */
export function keepsPartOf(self: IssueVisibility): boolean {
  const standing = self.standing
  if (standing === undefined || standing.excluded) return false
  return self.flat || self.keptBelow
}

/** Has a row before nesting: flat, or a rescued live human ancestor (`rows.ts:121-158`). */
export function presentPartOf(self: IssueVisibility): boolean {
  if (self.flat) return true
  const standing = self.standing
  if (standing === undefined || standing.excluded || !standing.rescuable) return false
  return self.keptBelow
}

/**
 * The nearest present ancestor by the raw `parentId`, through any known issue
 * (`rows.ts:271-283`); else, for a parentless non-spin-off, the present
 * issue owning its `startedBySession` unless that one is a draft vessel
 * (`rows.ts:288-305`, `issueIdOwningSession`, `session-ownership.ts:371-410`).
 */
export function nestParentPartOf(
  input: VisibleInputs,
  id: string,
  self: IssueVisibility,
): string | null {
  const standing = self.standing
  if (standing === undefined || !self.present) return null
  // Cycle-safe like the legacy walk (`seenParents`, `rows.ts:273-281`).
  const seen = new Set<string>([id])
  let parentId = standing.parentId
  while (parentId !== null) {
    if (seen.has(parentId)) return null
    seen.add(parentId)
    const parent = input.issue(parentId)
    if (parent === undefined) break
    if (parent.present) return parentId
    parentId = parent.standing?.parentId ?? null
  }
  if (standing.parentId !== null || standing.startedBy === null) return null
  const owner = ownerOf(input, standing.startedBy)
  if (owner === null || owner === id) return null
  const candidate = input.issue(owner)
  if (candidate?.standing?.draftVessel === true && candidate.liveRoster) return null
  return owner
}

/**
 * The present issue a session belongs to (`issueIdOwningSession` with the
 * ownership index): its explicit issue when that one is present, else, for a
 * session with no `issueId`, a present issue checked out at its worktree
 * (lowest id: legacy takes the first in its list order, which no pool has).
 */
function ownerOf(input: VisibleInputs, sessionId: string): string | null {
  // The session's CACHED parts, never its row: a heartbeat of a starter
  // session re-runs none of the issues it started.
  const session = input.session(sessionId)
  const retention = session.retention
  if (retention === null || retention.archived) return null
  if (retention.issueId !== undefined) {
    const issueId = session.issueLink
    return issueId !== null &&
      issueId === retention.issueId &&
      input.issue(issueId)?.present === true
      ? issueId
      : null
  }
  const worktree = session.worktreeLink
  if (worktree === null) return null
  let owner: string | null = null
  for (const issueId of input.relations.many('worktree', worktree, 'issues')) {
    if (owner !== null && issueId > owner) continue
    const issue = input.issue(issueId)
    if (issue?.standing?.excluded === false && issue.present) owner = issueId
  }
  return owner
}

/** Reaches the screen: under a placed nest parent, or top-level and not agent-audience (`rows.ts:343-357`). */
export function placedPartOf(input: VisibleInputs, self: IssueVisibility): boolean {
  if (!self.present) return false
  const parent = self.nestParent
  if (parent !== null) return input.issue(parent)?.placed === true
  return self.standing?.agent === false
}

// ----------------------------------------------------------- direct (rebuild)

/**
 * The parts of `id` computed directly (the rebuild), memoized per id for ONE
 * rebuild only (`memo`): a from-scratch pass, like the legacy's own maps.
 */
export function directVisibility(
  input: VisibleInputs,
  id: string,
  memo: Map<string, IssueVisibility>,
): IssueVisibility {
  const cached = memo.get(id)
  if (cached !== undefined) return cached
  const values = new Map<string, unknown>()
  const once = <T>(key: string, compute: () => T): T => {
    if (!values.has(key)) values.set(key, compute())
    return values.get(key) as T
  }
  const parts: IssueVisibility = {
    get standing() {
      return once('standing', () => standingPartOf(input, id))
    },
    get seatIds() {
      return once('seatIds', () => seatIdsPartOf(input, id))
    },
    get memberIds() {
      return once('memberIds', () => memberIdsPartOf(parts.seatIds, parts.laneMemberIds))
    },
    get laneMemberIds() {
      return once('laneMemberIds', () => laneMemberIdsPartOf(input, id))
    },
    get childIds() {
      return once('childIds', () => childIdsPartOf(input, id))
    },
    get spinOffIds() {
      return once('spinOffIds', () => spinOffIdsPartOf(input, id))
    },
    get rosterIds() {
      return once('rosterIds', () => rosterIdsPartOf(input, parts))
    },
    get retained() {
      return once('retained', () => retainedPartOf(parts))
    },
    get retainedSeatIds() {
      return once('retainedSeatIds', () => retainedSeatIdsPartOf(input, id, parts))
    },
    get liveRoster() {
      return once('liveRoster', () => liveRosterPartOf(parts))
    },
    get unread() {
      return once('unread', () => unreadPartOf(input, id, parts))
    },
    get flat() {
      return once('flat', () => flatPartOf(input, id, parts))
    },
    get keptBelow() {
      return once('keptBelow', () => keptBelowPartOf(input, parts))
    },
    get keeps() {
      return once('keeps', () => keepsPartOf(parts))
    },
    get present() {
      return once('present', () => presentPartOf(parts))
    },
    get nestParent() {
      return once('nestParent', () => nestParentPartOf(input, id, parts))
    },
    get placed() {
      return once('placed', () => placedPartOf(input, parts))
    },
    get visible() {
      return once('visible', () => parts.present && parts.placed)
    },
    get rank() {
      return once('rank', () => rankPartOf(input, id))
    },
    get finished() {
      return parts.standing?.finished
    },
    get waiting() {
      return once('waiting', () => waitingPartOf(parts))
    },
    get ownFacts() {
      return once('ownFacts', () => ownFactsPartOf(rollupInputs, id))
    },
    get formalParent() {
      return once('formalParent', () => formalParentPartOf(parts))
    },
    get ownAttention() {
      return once('ownAttention', () => ownAttentionPartOf(rollupInputs, parts))
    },
    get aggregate() {
      return once('aggregate', () => aggregatePartOf(rollupInputs, id, parts))
    },
    get unitOwn() {
      return once('unitOwn', () => unitOwnPartOf(rollupInputs, id, parts))
    },
    get unitsBelow() {
      return once('unitsBelow', () => unitsBelowPartOf(rollupInputs, id))
    },
    get seatActivity() {
      return once('seatActivity', () => seatActivityPartOf(rollupInputs, id, parts))
    },
    get openOwn() {
      return once('openOwn', () => openOwnPartOf(rollupInputs, id, parts))
    },
    get tip() {
      return once('tip', () => tipPartOf(rollupInputs, id))
    },
    get rollup() {
      return once('rollup', () => rollupPartOf(parts))
    },
  }
  const rollupInputs = rollupInputsOf(input)
  memo.set(id, parts)
  return parts
}

/**
 * The nest children of every present issue, from scratch (the rebuild's
 * `VisibleInputs.nested`): each known issue's `nestParent`, inverted.
 */
export function directNested(
  ids: Iterable<string>,
  partsOf: (id: string) => IssueVisibility,
): ReadonlyMap<string, readonly string[]> {
  const nested = new Map<string, string[]>()
  for (const id of ids) {
    const parent = partsOf(id).nestParent
    if (parent === null) continue
    const children = nested.get(parent)
    if (children === undefined) nested.set(parent, [id])
    else children.push(id)
  }
  return nested
}

/** Visible ids in L1b rank order (the rebuild's order; the live `order` sorts the same way). */
export function sortByRank(
  ids: Iterable<string>,
  rankOfId: (id: string) => RowRank | undefined,
): string[] {
  const ranks = new Map<string, RowRank>()
  for (const id of ids) {
    const rank = rankOfId(id)
    if (rank !== undefined) ranks.set(id, rank)
  }
  return [...ranks.keys()].sort((a, b) =>
    compareRank(ranks.get(a) as RowRank, ranks.get(b) as RowRank),
  )
}

// ----------------------------------------------------------------- live nodes

/** What the nodes read from the pool. */
export interface VisibleHost {
  readonly visibleInputs: VisibleInputs
  readonly counters: VisibleCounters
  /**
   * File one node's layout placement (POD-4686): the visible id's current
   * placement, or undefined when it has none (invisible or unknown). Called
   * from the node's layout reaction and when its node is forgotten; the
   * groups file it into their maintained buckets.
   */
  filePlacement(id: string, placement: Placement | undefined): void
}

/** The collection's own counters (`MobxPool.stats.counters` carries them). */
export interface VisibleCounters {
  /** Issue nodes built (POD-4705: the lazy closure, not one per known issue). */
  issueNodes: number
  /** Session nodes built (first access). */
  sessionNodes: number
  /** Runs of the order computed. */
  orderSorts: number
  /** Ids sorted across those runs (the visible count per run). */
  orderElements: number
  /** Visible-set membership flips (an id added or deleted). */
  membershipFlips: number
  /** Ids (re)filed into the groups' lanes (POD-4686, `groups.ts`): one per placement change. */
  groupRuns: number
  /** Lane members around those filings (the lanes a filing re-sorts), not the visible count. */
  groupElements: number
}

export class SessionNode implements SessionVisibility {
  private readonly input: VisibleInputs

  constructor(
    readonly id: string,
    host: VisibleHost,
  ) {
    this.input = host.visibleInputs
    makeObservable<SessionNode, 'input'>(this, {
      id: false,
      input: false,
      retention: computedStruct,
      activityMs: computed,
      issueLink: computed,
      worktreeLink: computed,
      verdict: computedStruct,
    })
  }

  get verdict(): Loaded<SeatVerdict> {
    return verdictPartOf(this.input, this.id)
  }

  get retention(): Retention | null {
    return retentionOf(this.input.sessionRow(this.id))
  }

  get activityMs(): number | null {
    return activityMsOf(this.input.sessionRow(this.id))
  }

  get issueLink(): string | null {
    return this.input.relations.one('session', this.id, 'issue')
  }

  get worktreeLink(): string | null {
    return this.input.relations.one('session', this.id, 'worktree')
  }
}

export class IssueNode implements IssueVisibility {
  private readonly input: VisibleInputs
  private readonly rollupInput: RollupInputs

  constructor(
    readonly id: string,
    host: VisibleHost,
  ) {
    this.input = host.visibleInputs
    this.rollupInput = rollupInputsOf(host.visibleInputs)
    makeObservable<IssueNode, 'input' | 'rollupInput'>(this, {
      id: false,
      input: false,
      rollupInput: false,
      standing: computedStruct,
      seatIds: computedStruct,
      memberIds: computedStruct,
      laneMemberIds: computedStruct,
      childIds: computedStruct,
      spinOffIds: computedStruct,
      rosterIds: computedStruct,
      retainedSeatIds: computedStruct,
      retained: computed,
      liveRoster: computed,
      unread: computed,
      flat: computed,
      keptBelow: computed,
      keeps: computed,
      present: computed,
      nestParent: computed,
      placed: computed,
      visible: computed,
      rank: computedStruct,
      settledPlacement: computedStruct,
      placement: computedStruct,
      finished: false,
      waiting: computed,
      ownFacts: computedStruct,
      formalParent: computed,
      ownAttention: computedStruct,
      aggregate: computedStruct,
      unitOwn: computedStruct,
      unitsBelow: computedStruct,
      seatActivity: computed,
      openOwn: computed,
      tip: computedStruct,
      rollup: computedStruct,
    })
  }

  get standing(): Standing | undefined {
    return standingPartOf(this.input, this.id)
  }

  get seatIds(): readonly string[] {
    return seatIdsPartOf(this.input, this.id)
  }

  get memberIds(): readonly string[] {
    return memberIdsPartOf(this.seatIds, this.laneMemberIds)
  }

  get laneMemberIds(): readonly string[] {
    return laneMemberIdsPartOf(this.input, this.id)
  }

  get childIds(): readonly string[] {
    return childIdsPartOf(this.input, this.id)
  }

  get spinOffIds(): readonly string[] {
    return spinOffIdsPartOf(this.input, this.id)
  }

  get rosterIds(): readonly string[] {
    return rosterIdsPartOf(this.input, this)
  }

  get retainedSeatIds(): readonly string[] {
    return retainedSeatIdsPartOf(this.input, this.id, this)
  }

  get retained(): boolean {
    return retainedPartOf(this)
  }

  get liveRoster(): boolean {
    return liveRosterPartOf(this)
  }

  get unread(): boolean {
    return unreadPartOf(this.input, this.id, this)
  }

  get flat(): boolean {
    return flatPartOf(this.input, this.id, this)
  }

  get keptBelow(): boolean {
    return keptBelowPartOf(this.input, this)
  }

  get keeps(): boolean {
    return keepsPartOf(this)
  }

  get present(): boolean {
    return presentPartOf(this)
  }

  get nestParent(): string | null {
    return nestParentPartOf(this.input, this.id, this)
  }

  get placed(): boolean {
    return placedPartOf(this.input, this)
  }

  get visible(): boolean {
    return this.present && this.placed
  }

  get rank(): RowRank | undefined {
    return rankPartOf(this.input, this.id)
  }

  /** Where the row goes from its own row alone, "nothing waiting" assumed (`groups.ts`). */
  get settledPlacement(): Placement | undefined {
    return placementPartOf(this.input, this.id)
  }

  /**
   * Where the row goes (R-GROUP, `groups.ts`): read by the groups' layout for
   * visible rows only. The waiting roll-up is read only for a row the fold
   * would take, so a row that could never fold never reads its aggregate.
   */
  get placement(): Placement | undefined {
    const settled = this.settledPlacement
    return settled === undefined || !settled.closed || !this.waiting
      ? settled
      : withWaiting(settled)
  }

  get finished(): boolean | undefined {
    return this.standing?.finished
  }

  get waiting(): boolean {
    return waitingPartOf(this)
  }

  get ownFacts(): OwnFacts {
    return ownFactsPartOf(this.rollupInput, this.id)
  }

  get formalParent(): string | null {
    return formalParentPartOf(this)
  }

  get ownAttention(): OwnAttention {
    return ownAttentionPartOf(this.rollupInput, this)
  }

  get aggregate(): Aggregate {
    return aggregatePartOf(this.rollupInput, this.id, this)
  }

  get unitOwn(): UnitOwn {
    return unitOwnPartOf(this.rollupInput, this.id, this)
  }

  get unitsBelow(): Units {
    return unitsBelowPartOf(this.rollupInput, this.id)
  }

  get seatActivity(): number | null {
    return seatActivityPartOf(this.rollupInput, this.id, this)
  }

  get openOwn(): boolean {
    return openOwnPartOf(this.rollupInput, this.id, this)
  }

  get tip(): { readonly found: boolean; readonly pending: number } {
    return tipPartOf(this.rollupInput, this.id)
  }

  get rollup(): Rollup | undefined {
    return rollupPartOf(this)
  }
}

/**
 * The visible collection: one node per known issue, one reaction per node on
 * its `visible`, one observable set of visible ids, and the order over it.
 */
export class VisibleCollection {
  /** The visible ids, maintained by the nodes' reactions. Unordered. */
  readonly ids: ObservableSet<string>
  /**
   * The issue nodes, OBSERVABLE: a part that looks up another issue's node
   * (a parent, a child, a starter's owner) tracks that id's slot, so a node
   * that appears later (an evicted parent re-added) re-runs it. A plain map
   * here was untracked state read inside a derivation (POD-4569 gate, seed 1
   * step 112: evict then re-add a parent left its descendants unplaced).
   */
  private readonly nodes: ObservableMap<string, IssueNode>
  /**
   * THE NEST CHILDREN (Mb3), the inverse of each node's `nestParent`: parent
   * id to the present rows nested under it. Maintained by one reaction per
   * node, like `ids`, and keyed by id so it outlives a parent node that is
   * replaced. The attention roll-up composes over it (`rollup.ts`).
   */
  private readonly nestedBy: ObservableMap<string, ObservableSet<string>>
  /**
   * THE FORMAL CHILDREN (Mb3), filed the same way from each node's declared
   * `issue.parent` forward slot: the progress roll-up composes over it. The
   * relation engine's `children` bucket holds the same ids, but re-listing it
   * reads every sibling (the fence counts each id a `many` yields), so a
   * re-parent would re-read both families; filing reads the moved row's slot.
   */
  private readonly childrenBy: ObservableMap<string, ObservableSet<string>>
  /** Each node's reactions, by id (maintenance only, never read by a derivation). */
  private readonly stops = new Map<string, () => void>()
  /** The parent each id was last filed under, per index (maintenance only). */
  private readonly filedUnder = {
    nested: new Map<string, string>(),
    formal: new Map<string, string>(),
  }
  private readonly sessions = new Map<string, SessionNode>()

  constructor(private readonly host: VisibleHost) {
    this.ids = observable.set<string>(undefined, { deep: false, name: 'pool.visible' })
    this.nodes = observable.map<string, IssueNode>(undefined, {
      deep: false,
      name: 'pool.visible.nodes',
    })
    this.nestedBy = observable.map<string, ObservableSet<string>>(undefined, {
      deep: false,
      name: 'pool.visible.nested',
    })
    this.childrenBy = observable.map<string, ObservableSet<string>>(undefined, {
      deep: false,
      name: 'pool.visible.children',
    })
    makeObservable<
      VisibleCollection,
      | 'nodes'
      | 'nestedBy'
      | 'childrenBy'
      | 'stops'
      | 'filedUnder'
      | 'sessions'
      | 'host'
      | 'file'
      | 'add'
      | 'drop'
      | 'ensure'
      | 'syncReplace'
      | 'has'
    >(this, {
      ids: false,
      nodes: false,
      nestedBy: false,
      childrenBy: false,
      stops: false,
      filedUnder: false,
      sessions: false,
      host: false,
      order: computed({ equals: compareShallow }),
      issue: false,
      nested: false,
      formalChildren: false,
      file: false,
      session: false,
      // POD-4705: node maintenance called inside actions, never observed.
      add: false,
      drop: false,
      ensure: false,
      syncReplace: false,
      forgetSession: false,
      forgetSessions: false,
      heldIds: false,
      has: false,
      size: false,
      clear: false,
    })
  }

  /**
   * The visible ids in L1b rank order: a view-time sort of the visible set
   * over each node's cached `rank`. Reads no row.
   */
  get order(): readonly string[] {
    const counters = this.host.counters
    counters.orderSorts += 1
    counters.orderElements += this.ids.size
    return sortByRank(this.ids, (id) => this.nodes.get(id)?.rank)
  }

  /** The node of a known issue (hot or cold), else undefined. */
  issue(id: string): IssueNode | undefined {
    return this.nodes.get(id)
  }

  /** TRACKED: the present rows nested under `id` (unordered). */
  nested(id: string): Iterable<string> {
    return this.nestedBy.get(id) ?? []
  }

  /** TRACKED: the known issues whose declared parent is `id` (unordered). */
  formalChildren(id: string): Iterable<string> {
    return this.childrenBy.get(id) ?? []
  }

  /** Move `id` in one index to `parent` (null: out). Inside an action. */
  private file(index: 'nested' | 'formal', id: string, parent: string | null): void {
    const by = index === 'nested' ? this.nestedBy : this.childrenBy
    const filed = this.filedUnder[index]
    const before = filed.get(id)
    if (before === parent) return
    if (before !== undefined) {
      const siblings = by.get(before)
      siblings?.delete(id)
      if (siblings?.size === 0) by.delete(before)
      filed.delete(id)
    }
    if (parent === null) return
    let siblings = by.get(parent)
    if (siblings === undefined) {
      siblings = observable.set<string>(undefined, { deep: false })
      by.set(parent, siblings)
    }
    siblings.add(id)
    filed.set(id, parent)
  }

  /** The node of a session, built on first access. */
  session(id: string): SessionNode {
    let node = this.sessions.get(id)
    if (node === undefined) {
      node = new SessionNode(id, this.host)
      this.sessions.set(id, node)
      this.host.counters.sessionNodes += 1
    }
    return node
  }

  /** Build one issue's node and its four reactions (call inside an action). */
  private add(id: string): void {
    const node = new IssueNode(id, this.host)
    const counters = this.host.counters
    const stop = reaction(
      () => node.visible,
      (visible) => {
        if (visible === this.ids.has(id)) return
        if (visible) this.ids.add(id)
        else this.ids.delete(id)
        counters.membershipFlips += 1
      },
      { fireImmediately: true, name: `pool.visible.${id}` },
    )
    const stopNest = reaction(
      () => node.nestParent,
      (parent) => this.file('nested', id, parent),
      { fireImmediately: true, name: `pool.nested.${id}` },
    )
    const stopFormal = reaction(
      () => node.formalParent,
      (parent) => this.file('formal', id, parent),
      { fireImmediately: true, name: `pool.children.${id}` },
    )
    // POD-4686: the layout filing. Visible rows file their placement; an
    // invisible row files nothing, so the groups hold exactly the visible
    // set without ever enumerating it. `placement` is structural, so a
    // mark-read (read-state lane only) never fires this.
    const stopLayout = reaction(
      () => (node.visible ? node.placement : undefined),
      (placement) => this.host.filePlacement(id, placement),
      { fireImmediately: true, name: `pool.layout.${id}` },
    )
    this.nodes.set(id, node)
    this.stops.set(id, () => {
      stop()
      stopNest()
      stopFormal()
      stopLayout()
    })
    counters.issueNodes += 1
  }

  /** Drop one issue's node and reactions and leave every filing (call inside an action). */
  private drop(id: string): void {
    const held = this.stops.get(id)
    if (held === undefined) return
    held()
    this.stops.delete(id)
    this.nodes.delete(id)
    this.file('nested', id, null)
    this.file('formal', id, null)
    this.host.filePlacement(id, undefined)
    if (this.ids.delete(id)) this.host.counters.membershipFlips += 1
  }

  /**
   * Bring the named issues' nodes in line with whether each is known (call
   * inside the action that changed it): a newly known issue gets its node and
   * reactions, a gone one loses both and leaves the set. Held nodes NOT named
   * are left alone: an update keeps what it has.
   */
  ensure(ids: Iterable<string>, known: (id: string) => boolean): void {
    for (const id of ids) {
      if (known(id)) {
        if (this.stops.has(id)) continue
        this.add(id)
        continue
      }
      this.drop(id)
    }
  }

  /**
   * POD-4705 — a `replace` re-seeds the nodes to exactly `ids` (call inside
   * the action): the lazy closure the plain pass found, nothing else. Held
   * nodes outside it are hidden by construction, so they leave the set (and
   * their filings) rather than sit unobserved.
   */
  syncReplace(ids: Iterable<string>, known: (id: string) => boolean): void {
    const want = new Set(ids)
    this.ensure(want, known)
    for (const id of [...this.stops.keys()]) {
      if (!want.has(id)) this.drop(id)
    }
  }

  /** A session left: drop its node. */
  forgetSession(id: string): void {
    this.sessions.delete(id)
  }

  /** Drop the node of every session `known` no longer answers for (a `replace`). */
  forgetSessions(known: (id: string) => boolean): void {
    for (const id of [...this.sessions.keys()]) if (!known(id)) this.sessions.delete(id)
  }

  /** The issue ids holding a node (a `replace` re-syncs them with the known ids). */
  heldIds(): string[] {
    return [...this.stops.keys()]
  }

  /** Whether `id` holds a node (POD-4705: the pool skips held seeds). */
  has(id: string): boolean {
    return this.stops.has(id)
  }

  /** Nodes held, per kind (tests: lifecycle). */
  size(kind: 'issue' | 'session'): number {
    return kind === 'issue' ? this.stops.size : this.sessions.size
  }

  /** Stop every reaction and forget every node (the pool's dispose; call inside an action). */
  clear(): void {
    for (const stop of this.stops.values()) stop()
    this.stops.clear()
    this.nodes.clear()
    this.nestedBy.clear()
    this.childrenBy.clear()
    this.filedUnder.nested.clear()
    this.filedUnder.formal.clear()
    this.sessions.clear()
    this.ids.clear()
  }
}
