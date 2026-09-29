/**
 * The worklist's visible collection and its order, over the pool's graph.
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
 * ONE RULE, TWO CALLERS (as `views.ts`). The part functions are pure over
 * their inputs. The live pool caches them in GROUPS on the one object per
 * issue (`IssueModel`, `models.ts`): one cached value per group, each group
 * a function below (`issueFactsOf`, `membersOf`, `presenceOf`, `nestingOf`)
 * or in `rollup.ts` (`attentionOf`, `progressOf`). The rebuild and the pool's
 * plain pass run the same group functions directly, memoized per id for one
 * pass (`directVisibility`).
 *
 * THE GROUPS OF ONE ISSUE. A group is cut where its readers are: a value that
 * a whole list reads (the rank) is its own group, and every other group is
 * read by its own row, its family or one ancestor chain. Groups never read
 * each other in a cycle: every cross-issue read goes one way (children up,
 * ancestors down, spin-offs across), and a group reading another issue reads
 * a group of that issue that does not read back.
 * - facts (`issueFactsOf`): the own row, hot OR cold (a cold row is read by
 *   id through the feed, `VisibleInputs.issueRow`), and the clock: the
 *   standing (structural exclusion, finished, the sessionless keep's inputs,
 *   the raw parent), the row view's own part and the settled placement. Under
 *   the declared cold rule no visible row is cold, so a cold read answers the
 *   hidden side without loading the row.
 * - rank: L1b `rankOf` over the own part (the order and the group lanes read
 *   every visible row's rank, so it is cached apart from the facts).
 * - members (`membersOf`): R2's seats (`issue.sessions`, the maintained
 *   sorted list) and R3's lane (the issueless sessions of `issue.worktree`),
 *   the retained seats at the clock (exited included: the own-row
 *   `activityAt`'s sessions), the roster (retained and not exited), and
 *   whether an own session is on the task.
 * - presence (`presenceOf`): the flat pass (`rows.ts:59-107`), the rescue
 *   read DOWN the children relation (`rows.ts:121-158`: a parent is kept by
 *   a child that is flat or kept), and `present` (flat, or rescued).
 * - nesting (`nestingOf`): the nest parent (the nearest present ancestor by
 *   the raw `parentId`, else the started-by owner, `rows.ts:254-359`),
 *   `placed` (under a placed nest parent, or top-level and not agent) and
 *   `visible` = present && placed.
 * `unread` (the decay branch of the flat pass) and the children list are
 * read only by the presence group, and only when it needs them, so they are
 * computed inside it and not cached apart.
 *
 * THE COLLECTION IS MAINTAINED, NOT RE-ENUMERATED. Every issue the worklist
 * holds (the lazy closure: visible, present and keeping rows, their
 * ancestors, and their formal subtrees; not every known issue) holds one
 * reaction on its `visible`, which adds or deletes its id in one observable
 * set. A row the worklist does not hold reads as hidden and keeping nothing,
 * which the closure guarantees by construction (the plain pass evaluates
 * every known issue, so anything present or keeping is in the closure).
 * Holds are taken and released per changed issue record (`ensure`); the only
 * whole-table walk is `enumerate.ts` `knownIssueIds`, at a `replace`.
 *
 * CROSS-ISSUE READS STAY TRACKED. A group that looks up another issue reads
 * the held map's slot for that id, so a hold taken later re-runs the reader:
 * a parent whose child was not held re-reads the child's `keeps` once it is,
 * and likewise up the nest chain.
 *
 * THE ORDER is a computed over the set: the visible ids sorted by each held
 * issue's cached `rank` (`compareRank`). It re-runs when membership changes or
 * a VISIBLE row's rank changes, reads no row, and is shallow-equal across runs
 * that leave the order unchanged, so the list redraws only when the order
 * moves.
 */

import {
  compareStructural,
  compareShallow,
  computed,
  makeObservable,
  type ObservableMap,
  type ObservableSet,
  observable,
  reaction,
} from 'mobx'
import type { RelationReader } from '../../../../shared/src/instrument/reads'
import { compareRank, type RowRank } from '../../../../shared/src/row-view'
import type { SliceIssue, SliceSession } from '../../../../shared/src/slice-types'
import { relationRef } from '../relations'
import {
  FINISHED_GRACE_MS,
  isClosedTopLevel,
  type OwnPart,
  ownPartOfRow,
  parseMs,
  rankOfPart,
} from '../views'
import { type Placement, placementOfPart } from './groups'
import {
  type Attention,
  attentionOf,
  formalParentPartOf,
  type Loaded,
  ownFactsPartOf,
  type Progress,
  type ProgressFacts,
  progressOf,
  type RollupInputs,
  type RollupParts,
  rollupPartOf,
  type SeatVerdict,
  seatVerdictOf,
  tipPartOf,
  waitingPartOf,
} from './rollup'

/** `SIDEBAR_FINISHED_UNREAD_WINDOW_MS` (`visibility.ts:22`). */
export const FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Everything the visibility parts read. Tracked in the live pool; plain in the rebuild. */
export interface VisibleInputs {
  readonly relations: RelationReader
  /** An issue's row, hot or cold (a cold one read by id through the feed); undefined when unknown. */
  issueRow(id: string): SliceIssue | undefined
  /** A session's row, hot or cold; undefined when unknown. */
  sessionRow(id: string): SliceSession | undefined
  /** Another issue the worklist holds; undefined when it holds none. */
  issue(id: string): IssueVisibility | undefined
  /** A session's parts (its object in the live pool). */
  session(id: string): SessionVisibility
  /**
   * The issue's read cursor (`readAt`): a non-empty string, null when the row
   * carries none, undefined when the issue is unknown. The live pool reads its
   * read-state lane, which a mark-read writes without touching the row's
   * slot, so a click re-validates only the clicked row; the rebuild reads the
   * row it holds.
   */
  issueRead(id: string): string | null | undefined
  /** `coarseNow > t`. */
  passed(t: number): boolean
  /** `coarseNow >= t`. */
  reached(t: number): boolean
  /** A RESIDENT issue row; `LOADING` when cold (the read queues its load): the roll-ups' read. */
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
   * The explicit seats (`issue.sessions`) as the relation yields them: every
   * id counts as a read, as `many()` yields do. No part reads it; the seat
   * list below is the read.
   */
  seats(id: string): Iterable<string>
  /** The maintained SORTED seat list itself, returned without iterating it. */
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
   * The declared `issue.parent` forward key: the relation engine's own
   * `relationRef` over this row (foreign key and `where`), so it costs this
   * row alone and never the parent's residency. The progress filing's key.
   */
  readonly formalParent: string | null
}

/** `isSystemOwnedIssueStage` (`model/src/entities/issue-vocabulary.ts:59`). */
function systemOwnedStage(stage: string): boolean {
  return stage === 'shipping'
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
  // `issueAwaitingMerge` reads branch and git state no slice row carries:
  // never true here.
  const sessionless = activeHuman
    ? 'keep'
    : !finished
      ? 'drop'
      : isClosedTopLevel(issue)
        ? 'fold'
        : !issue.parentId || issue.audience === 'agent'
          ? 'drop'
          : 'decay'
  const spinOff = issue.deps?.some((dep) => dep.type === 'discovered-from') === true
  // No `readAt`: the cursor lives in the read-state lane
  // (`VisibleInputs.issueRead`), so a mark-read never re-runs this.
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

/** The facts group: everything one read of the own row and the clock gives. */
export interface IssueFacts {
  readonly standing: Standing
  /** The row view's own fields (`views.ts` `OwnPart`). */
  readonly part: OwnPart
  /** Where the row goes with nothing waiting assumed (`groups.ts`). */
  readonly placement: Placement
}

/** The facts group of `issue` (the fold verdict and the band are computed once, here). */
export function issueFactsOf(
  issue: SliceIssue,
  input: Pick<VisibleInputs, 'passed' | 'reached'>,
): IssueFacts {
  const part = ownPartOfRow(issue, input)
  return {
    standing: standingOf(issue),
    part,
    placement: placementOfPart(part, issue.repoPath),
  }
}

/** The facts group of issue `id`, hot or cold; undefined when unknown. */
export function issueFactsPartOf(input: VisibleInputs, id: string): IssueFacts | undefined {
  const issue = input.issueRow(id)
  return issue === undefined ? undefined : issueFactsOf(issue, input)
}

/**
 * The unread rollup's cursor from the read-state lane: the epoch ms of the
 * row's `readAt`, or null when absent or unparseable, and whether the row
 * carries one at all (`''` normalizes to null: `Boolean('')` is false and
 * `Date.parse('')` is NaN, both ways).
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

// ------------------------------------------------------------ member sessions

/**
 * One session's part in its issue's visibility, without the clock and
 * without its issue (`sessionRetainsWorklistRow`, `visibility.ts:44-70`). An
 * idle session whose turn finished decays from its ISSUE's finish time when
 * that issue is finished, so `finish` names the case and the issue part
 * resolves it (`retains`).
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

/** A session's `lastActiveAt`, epoch ms: the unread rollup's and the row's activity stamp. */
export function activityMsOf(session: SliceSession | undefined): number | null {
  return parseMs(session?.lastActiveAt)
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
  /** The seat's roll-up verdict, from the RESIDENT row; `LOADING` while it is cold. */
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

/** A session's two links: `session.issue` and `session.worktree`. */
export interface SessionLinks {
  readonly issueLink: string | null
  readonly worktreeLink: string | null
}

export function sessionLinksOf(input: Pick<VisibleInputs, 'relations'>, id: string): SessionLinks {
  return {
    issueLink: input.relations.one('session', id, 'issue'),
    worktreeLink: input.relations.one('session', id, 'worktree'),
  }
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
    ...sessionLinksOf(input, id),
    verdict: verdictPartOf(input, id),
  }
}

/** The members group (see the header). */
export interface Members {
  /** R2: the explicit members (`issue.sessions`: headless out, twins collapsed), id order. */
  readonly seatIds: readonly string[]
  /** R3 alone: the lane's sessions with no `issueId`, id order. */
  readonly laneMemberIds: readonly string[]
  /** R2 then R3, id order, no duplicates. Unfiltered: each reader applies its seat rule. */
  readonly memberIds: readonly string[]
  /** The retained seats (`retainedSessions`), exited included: the own-row `activityAt`'s sessions. */
  readonly retainedSeatIds: readonly string[]
  /**
   * The row's seats (`mine`, `rows.ts:71-79`): members that are seats (no
   * shell, not archived), retained at the clock and not exited.
   */
  readonly rosterIds: readonly string[]
  /** ≥1 retained member session (`rows.ts:70-76`). */
  readonly retained: boolean
  /** A retained member still on the live roster: a draft vessel's test. */
  readonly liveRoster: boolean
  /** An explicit session of its own is on the task (`openIssues`, `mission.ts:582-590`). */
  readonly openOwn: boolean
}

/** One issue's parts (see the header), and its roll-up parts (`rollup.ts`). */
export interface IssueVisibility extends RollupParts, Members {
  readonly standing: Standing | undefined
  readonly childIds: readonly string[]
  /** `issue.spinOffs` (R4, the inverse edge), id order: the roll-ups' vacated and continuation tests. */
  readonly spinOffIds: readonly string[]
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
  /** R-GROUP 3's "nothing in the subtree waits": the aggregate under this row. */
  readonly waiting: boolean
}

/** The roll-up parts' inputs over the visibility inputs: held issues for rows, sessions for seats. */
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
    spinOffIds: (id) => input.issue(id)?.spinOffIds ?? [],
    counted: () => input.counted(),
  }
}

/**
 * R3 alone: the lane's issueless sessions (`indexSessionOwnership`,
 * `session-ownership.ts:152-165`), id order: the maintained issueless set,
 * never session rows filtered. The worktree comes through `issue.worktree`
 * (the relation's forward, keyed by `worktreePath` alone and union-aware),
 * so the union roots seat an unscanned checkout all the same.
 */
export function laneMemberIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  const worktree = input.relations.one('issue', id, 'worktree')
  if (worktree === null) return []
  return [...input.relations.subset('worktree', worktree, 'sessions', 'issueless')].sort()
}

/** R2 then R3, id order, no duplicates. */
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
 * member order.
 */
export function retainedSeatIdsPartOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  memberIds: readonly string[],
): readonly string[] {
  if (standing === undefined) return []
  let issue: SliceIssue | undefined
  const retained: string[] = []
  for (const sessionId of memberIds) {
    const retention = input.session(sessionId).retention
    if (retention === null || !retention.seat) continue
    if (retention.finish.kind === 'idleDone' && standing.finished) {
      issue ??= input.issueRow(id)
    }
    if (retains(retention, issue, standing, input)) retained.push(sessionId)
  }
  return retained
}

/** `openIssues.has(id)`: an explicit session with this `issueId` present on the task. */
export function openOwnPartOf(input: VisibleInputs, id: string, seatIds: readonly string[]): boolean {
  for (const sessionId of seatIds) {
    const retention = input.session(sessionId).retention
    if (retention !== null && retention.issueId === id && !retention.archived && !retention.exited) {
      return true
    }
  }
  return false
}

/** The retained seats not exited, in member order (`sessionVisibleInLiveRoster`). */
export function rosterIdsPartOf(
  input: VisibleInputs,
  retainedSeatIds: readonly string[],
): readonly string[] {
  const roster = retainedSeatIds.filter(
    (sessionId) => input.session(sessionId).retention?.exited !== true,
  )
  return roster.length === retainedSeatIds.length ? retainedSeatIds : roster
}

/** The members group of issue `id`, over its standing. */
export function membersOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
): Members {
  // A copy: the maintained list mutates in place, and a cached group must
  // hold a value (a membership change re-runs this through the list's reads).
  const seatIds = input.seatList(id).slice()
  const laneMemberIds = laneMemberIdsPartOf(input, id)
  const memberIds = memberIdsPartOf(seatIds, laneMemberIds)
  const retainedSeatIds = retainedSeatIdsPartOf(input, id, standing, memberIds)
  const rosterIds = rosterIdsPartOf(input, retainedSeatIds)
  return {
    seatIds,
    laneMemberIds,
    memberIds,
    retainedSeatIds,
    rosterIds,
    retained: standing !== undefined && !standing.excluded && retainedSeatIds.length > 0,
    liveRoster: rosterIds.length > 0,
    openOwn: openOwnPartOf(input, id, seatIds),
  }
}

/**
 * The replica's unread rollup (`issue-views.ts:391-410`): never read, updated
 * past the cursor, or an explicit non-shell seat (archived included) active
 * past it; a deleted issue reads as read.
 */
export function unreadPartOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  seatIds: readonly string[],
): boolean {
  if (standing === undefined || standing.deleted) return false
  const { readMs } = readCursorOf(input.issueRead(id))
  if (readMs === null) return true
  if (standing.updatedMs !== null && standing.updatedMs > readMs) return true
  for (const sessionId of seatIds) {
    const session = input.session(sessionId)
    if (session.retention === null || session.retention.shell) continue
    const at = session.activityMs
    if (at !== null && at > readMs) return true
  }
  return false
}

/** Some child is flat or kept, through non-excluded children (`rows.ts:130-146`). */
export function keptBelowPartOf(input: VisibleInputs, childIds: readonly string[]): boolean {
  for (const childId of childIds) {
    if (input.issue(childId)?.keeps === true) return true
  }
  return false
}

/** The presence group (see the header). */
export interface Presence {
  /** The flat pass (`rows.ts:59-107`): retained sessions, else the sessionless keep. */
  readonly flat: boolean
  /** What this issue gives its parent's rescue: not excluded, and flat or kept below. */
  readonly keeps: boolean
  /** Has a row before nesting: flat, or a rescued live human ancestor (`rows.ts:121-158`). */
  readonly present: boolean
}

/**
 * The presence group of issue `id`. The decay branch reads `unread` and the
 * rescue reads the children only when the answer needs them (a flat row
 * never reads its children), exactly as the legacy passes short-circuit.
 */
export function presenceOf(
  input: VisibleInputs,
  id: string,
  self: Pick<IssueVisibility, 'standing' | 'retained' | 'seatIds'>,
): Presence {
  const standing = self.standing
  if (standing === undefined || standing.excluded) {
    return { flat: false, keeps: false, present: false }
  }
  const flat = flatOf(input, id, standing, self)
  if (flat) return { flat, keeps: true, present: true }
  const keptBelow = keptBelowPartOf(input, childIdsPartOf(input, id))
  return { flat, keeps: keptBelow, present: standing.rescuable && keptBelow }
}

function flatOf(
  input: VisibleInputs,
  id: string,
  standing: Standing,
  self: Pick<IssueVisibility, 'retained' | 'seatIds'>,
): boolean {
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
      if (!hasRead || unreadPartOf(input, id, standing, self.seatIds)) {
        return !input.passed(standing.finishedMs + FINISHED_UNREAD_WINDOW_MS)
      }
      return !input.passed(Math.max(standing.finishedMs, readMs ?? 0) + FINISHED_GRACE_MS)
    }
  }
}

/**
 * The nearest present ancestor by the raw `parentId`, through any held issue
 * (`rows.ts:271-283`); else, for a parentless non-spin-off, the present
 * issue owning its `startedBySession` unless that one is a draft vessel
 * (`rows.ts:288-305`, `issueIdOwningSession`, `session-ownership.ts:371-410`).
 */
export function nestParentPartOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  present: boolean,
): string | null {
  if (standing === undefined || !present) return null
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

/** The nesting group (see the header). */
export interface Nesting {
  readonly nestParent: string | null
  /** Reaches the screen: under a placed nest parent, or top-level and not agent-audience. */
  readonly placed: boolean
  readonly visible: boolean
}

const UNPLACED: Nesting = { nestParent: null, placed: false, visible: false }

/** The nesting group of issue `id` (`rows.ts:343-357`). */
export function nestingOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  present: boolean,
): Nesting {
  if (!present) return UNPLACED
  const nestParent = nestParentPartOf(input, id, standing, present)
  const placed =
    nestParent !== null ? input.issue(nestParent)?.placed === true : standing?.agent === false
  return { nestParent, placed, visible: placed }
}

/** L1b `rankOf` over the own row: the fields it reads, band from the clock (spec R-ORDER). */
export function rankPartOf(input: VisibleInputs, id: string): RowRank | undefined {
  const issue = input.issueRow(id)
  return issue === undefined ? undefined : rankOfPart(id, ownPartOfRow(issue, input))
}

// ----------------------------------------------------------- direct (rebuild)

/**
 * The parts of `id` computed directly (the rebuild and the pool's plain
 * pass), each group memoized per id for ONE pass only (`memo`): a
 * from-scratch pass, like the legacy's own maps.
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
  const rollupInputs = rollupInputsOf(input)
  // Part by part, each memoized: a pass asks for a few parts of every known
  // issue (the plain pass: presence and the formal parent), never whole groups.
  const presence = () => once('presence', () => presenceOf(input, id, parts))
  const nesting = () =>
    once('nesting', () => nestingOf(input, id, parts.standing, parts.present))
  const attention = (): Attention => once('attention', () => attentionOf(rollupInputs, id, parts))
  const progress = (): Progress => once('progress', () => progressOf(rollupInputs, id, parts))
  const parts: IssueVisibility = {
    get standing() {
      return once('standing', () => {
        const issue = input.issueRow(id)
        return issue === undefined ? undefined : standingOf(issue)
      })
    },
    get seatIds() {
      return once('seatIds', () => input.seatList(id).slice())
    },
    get laneMemberIds() {
      return once('laneMemberIds', () => laneMemberIdsPartOf(input, id))
    },
    get memberIds() {
      return once('memberIds', () => memberIdsPartOf(parts.seatIds, parts.laneMemberIds))
    },
    get retainedSeatIds() {
      return once('retainedSeatIds', () =>
        retainedSeatIdsPartOf(input, id, parts.standing, parts.memberIds),
      )
    },
    get rosterIds() {
      return once('rosterIds', () => rosterIdsPartOf(input, parts.retainedSeatIds))
    },
    get retained() {
      const standing = parts.standing
      return standing !== undefined && !standing.excluded && parts.retainedSeatIds.length > 0
    },
    get liveRoster() {
      return parts.rosterIds.length > 0
    },
    get openOwn() {
      return once('openOwn', () => openOwnPartOf(input, id, parts.seatIds))
    },
    get childIds() {
      return once('childIds', () => childIdsPartOf(input, id))
    },
    get spinOffIds() {
      return once('spinOffIds', () => spinOffIdsPartOf(input, id))
    },
    get unread() {
      return once('unread', () => unreadPartOf(input, id, parts.standing, parts.seatIds))
    },
    get flat() {
      return presence().flat
    },
    get keptBelow() {
      return once('keptBelow', () => keptBelowPartOf(input, parts.childIds))
    },
    get keeps() {
      return presence().keeps
    },
    get present() {
      return presence().present
    },
    get nestParent() {
      return nesting().nestParent
    },
    get placed() {
      return nesting().placed
    },
    get visible() {
      return nesting().visible
    },
    get rank() {
      return once('rank', () => rankPartOf(input, id))
    },
    get finished() {
      return parts.standing?.finished
    },
    get waiting() {
      return waitingPartOf(parts)
    },
    get ownFacts() {
      return once('ownFacts', () => ownFactsPartOf(rollupInputs, id))
    },
    get formalParent() {
      return formalParentPartOf(parts)
    },
    get ownAttention() {
      return attention().ownAttention
    },
    get aggregate() {
      return attention().aggregate
    },
    get seatActivity() {
      return attention().seatActivity
    },
    get unitOwn() {
      return progress().unitOwn
    },
    get unitsBelow() {
      return progress().unitsBelow
    },
    get tip() {
      return once('tip', () => tipPartOf(rollupInputs, id))
    },
    get rollup() {
      return once('rollup', () => rollupPartOf(parts))
    },
  }
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

// ----------------------------------------------------------------- live holds

/** One issue the worklist holds: its parts, and where its row goes. */
export interface HeldIssue extends IssueVisibility {
  readonly id: string
  readonly placement: Placement | undefined
}

/** What the collection reads from the pool. */
export interface VisibleHost {
  readonly counters: VisibleCounters
  /** The one object of issue `id`, built on first request. */
  issue(id: string): HeldIssue
  /** The collection let go of `id`: the pool may forget its object. */
  released(id: string): void
  /**
   * File one row's layout placement: the visible id's current placement, or
   * undefined when it has none (invisible or unknown). Called from the row's
   * layout reaction and when it is released; the groups file it into their
   * maintained buckets.
   */
  filePlacement(id: string, placement: Placement | undefined): void
}

/** The collection's own counters (`MobxPool.stats.counters` carries them). */
export interface VisibleCounters {
  /** Issues taken into the worklist (the lazy closure, not one per known issue). */
  issueNodes: number
  /** Runs of the order computed. */
  orderSorts: number
  /** Ids sorted across those runs (the visible count per run). */
  orderElements: number
  /** Visible-set membership flips (an id added or deleted). */
  membershipFlips: number
  /** Ids (re)filed into the groups' lanes (`groups.ts`): one per placement change. */
  groupRuns: number
  /** Lane members around those filings (the lanes a filing re-sorts), not the visible count. */
  groupElements: number
}

/**
 * The visible collection: the issues the worklist holds, their four
 * maintenance reactions each, one observable set of visible ids, and the
 * order over it.
 */
export class VisibleCollection {
  /** The visible ids, maintained by the held issues' reactions. Unordered. */
  readonly ids: ObservableSet<string>
  /**
   * The held issues, OBSERVABLE: a group that looks up another issue (a
   * parent, a child, a starter's owner) tracks that id's slot, so an issue
   * held later (an evicted parent re-added) re-runs it.
   */
  private readonly held: ObservableMap<string, HeldIssue>
  /**
   * THE NEST CHILDREN, the inverse of each held issue's `nestParent`: parent
   * id to the present rows nested under it. Maintained by one reaction per
   * held issue, like `ids`, and keyed by id so it outlives a parent that is
   * released. The attention roll-up composes over it (`rollup.ts`).
   */
  private readonly nestedBy: ObservableMap<string, ObservableSet<string>>
  /**
   * THE FORMAL CHILDREN, filed the same way from each held issue's declared
   * `issue.parent` forward slot: the progress roll-up composes over it.
   */
  private readonly childrenBy: ObservableMap<string, ObservableSet<string>>
  /** Each held issue's reactions, by id (maintenance only, never read by a derivation). */
  private readonly stops = new Map<string, () => void>()
  /** The parent each id was last filed under, per index (maintenance only). */
  private readonly filedUnder = {
    nested: new Map<string, string>(),
    formal: new Map<string, string>(),
  }

  constructor(private readonly host: VisibleHost) {
    this.ids = observable.set<string>(undefined, { deep: false, name: 'pool.visible' })
    this.held = observable.map<string, HeldIssue>(undefined, {
      deep: false,
      name: 'pool.visible.held',
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
      | 'held'
      | 'nestedBy'
      | 'childrenBy'
      | 'stops'
      | 'filedUnder'
      | 'host'
      | 'file'
      | 'add'
      | 'drop'
    >(this, {
      ids: false,
      held: false,
      nestedBy: false,
      childrenBy: false,
      stops: false,
      filedUnder: false,
      host: false,
      order: computed({ equals: compareShallow }),
      issue: false,
      nested: false,
      formalChildren: false,
      file: false,
      // Maintenance called inside actions, never observed.
      add: false,
      drop: false,
      ensure: false,
      syncReplace: false,
      heldIds: false,
      has: false,
      size: false,
      clear: false,
    })
  }

  /**
   * The visible ids in L1b rank order: a view-time sort of the visible set
   * over each held issue's cached `rank`. Reads no row.
   */
  get order(): readonly string[] {
    const counters = this.host.counters
    counters.orderSorts += 1
    counters.orderElements += this.ids.size
    return sortByRank(this.ids, (id) => this.held.get(id)?.rank)
  }

  /** TRACKED: the held issue `id` (hot or cold), else undefined. */
  issue(id: string): HeldIssue | undefined {
    return this.held.get(id)
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

  /** Hold one issue and build its four reactions (call inside an action). */
  private add(id: string): void {
    const issue = this.host.issue(id)
    const counters = this.host.counters
    const stop = reaction(
      () => issue.visible,
      (visible) => {
        if (visible === this.ids.has(id)) return
        if (visible) this.ids.add(id)
        else this.ids.delete(id)
        counters.membershipFlips += 1
      },
      { fireImmediately: true, name: `pool.visible.${id}` },
    )
    const stopNest = reaction(
      () => issue.nestParent,
      (parent) => this.file('nested', id, parent),
      { fireImmediately: true, name: `pool.nested.${id}` },
    )
    const stopFormal = reaction(
      () => issue.formalParent,
      (parent) => this.file('formal', id, parent),
      { fireImmediately: true, name: `pool.children.${id}` },
    )
    // The layout filing. Visible rows file their placement; an invisible row
    // files nothing, so the groups hold exactly the visible set without ever
    // enumerating it. `placement` is structural, so a mark-read (read-state
    // lane only) never fires this.
    const stopLayout = reaction(
      () => (issue.visible ? issue.placement : undefined),
      (placement) => this.host.filePlacement(id, placement),
      { fireImmediately: true, name: `pool.layout.${id}`, equals: compareStructural },
    )
    this.held.set(id, issue)
    this.stops.set(id, () => {
      stop()
      stopNest()
      stopFormal()
      stopLayout()
    })
    counters.issueNodes += 1
  }

  /** Release one issue: its reactions and every filing (call inside an action). */
  private drop(id: string): void {
    const held = this.stops.get(id)
    if (held === undefined) return
    held()
    this.stops.delete(id)
    this.held.delete(id)
    this.file('nested', id, null)
    this.file('formal', id, null)
    this.host.filePlacement(id, undefined)
    if (this.ids.delete(id)) this.host.counters.membershipFlips += 1
    this.host.released(id)
  }

  /**
   * Bring the named issues' holds in line with whether each is known (call
   * inside the action that changed it): a newly known issue is held with its
   * reactions, a gone one is released and leaves the set. Held issues NOT
   * named are left alone: an update keeps what it has.
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
   * A `replace` re-seeds the holds to exactly `ids` (call inside the action):
   * the lazy closure the plain pass found, nothing else. Held issues outside
   * it are hidden by construction, so they leave the set (and their filings)
   * rather than sit unobserved.
   */
  syncReplace(ids: Iterable<string>, known: (id: string) => boolean): void {
    const want = new Set(ids)
    this.ensure(want, known)
    for (const id of [...this.stops.keys()]) {
      if (!want.has(id)) this.drop(id)
    }
  }

  /** The held issue ids (a `replace` re-syncs them with the known ids). */
  heldIds(): string[] {
    return [...this.stops.keys()]
  }

  /** Whether `id` is held (the pool skips held seeds). */
  has(id: string): boolean {
    return this.stops.has(id)
  }

  /** Issues held (tests: lifecycle). */
  size(): number {
    return this.stops.size
  }

  /** Stop every reaction and release every issue (the pool's dispose; call inside an action). */
  clear(): void {
    for (const stop of this.stops.values()) stop()
    this.stops.clear()
    this.held.clear()
    this.nestedBy.clear()
    this.childrenBy.clear()
    this.filedUnder.nested.clear()
    this.filedUnder.formal.clear()
    this.ids.clear()
  }
}
