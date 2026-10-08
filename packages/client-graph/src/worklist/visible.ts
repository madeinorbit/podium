import type { IssueSessionFactReader } from '../shared/issue-session-facts'
import { isFinished, isExcluded } from '../shared/predicates'
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
 * ONE RULE, TWO CALLERS (as `views.ts`). The part functions derive their
 * values from their inputs. The live pool caches them in GROUPS on the one object per
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
 * ancestors down, spin-offs across). Rescue within a raw parent cycle reads
 * only own-row/member facts, never another cycle member's presence.
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
 * - nest candidate (`nestCandidatePartOf`): the nearest present ancestor by
 *   the raw `parentId`, else the started-by owner, without reading nesting.
 * - nesting (`nestingOf`): the nest parent after rejecting the edge that
 *   closes a candidate cycle (`rows.ts:254-359`),
 *   `placed` (under a placed nest parent, or top-level and not agent) and
 *   `visible` = present && placed.
 * `unread` (the decay branch of the flat pass) and the children list are
 * read only by the presence group, and only when it needs them, so they are
 * computed inside it and not cached apart.
 *
 * NEST CHILDREN ARE DERIVED (`nestBelowPartOf`, `nestedPartOf`). A present
 * row's nest children are the present rows whose `nestParent` it is. They
 * are found down the raw parent edge (`issue.treeChildren`, through ANY
 * issue, as the nest walk goes up through any issue): a present child is
 * one, a hidden child passes on the present rows below it. The started-by
 * fallback adds the issues its own sessions started (`session.startedIssues`).
 * Each candidate is kept only when its own `nestParent` names this row, so
 * the one rule (`nestParentPartOf`) decides and the derivation only finds.
 * The formal children, which the progress roll-up composes over, are the
 * relation engine's own `issue.children` bucket.
 *
 * THE COLLECTION IS MAINTAINED, ONE ROW AT A TIME. Every eligible issue in memory
 * is a filing candidate (`VisibleCollection.track`, taken when its row enters
 * the table and released when it leaves) and, while a list is on screen
 * (POD-5423), holds ONE reaction on what it files: its placement and rank
 * while it is visible, nothing while it is not. The effect moves
 * that row alone in the visible order and in the groups' lanes
 * (`sorted-lanes.ts`, `groups.ts`). A row not in memory is hidden by the
 * cold rule, so it files nothing and holds no reaction; its object is still
 * built on first read when another issue's walk reaches it (a cold ancestor,
 * a cold child).
 *
 * CROSS-ISSUE READS STAY TRACKED. A group that looks up another issue asks
 * the pool for it (`VisibleInputs.issue`), which answers the issue's object
 * while the issue is known and undefined otherwise, both tracked: an issue
 * that becomes known later re-runs the reader.
 *
 * THE ORDER is maintained like the lanes: the visible ids in L1b rank order
 * (`compareRank`), a row moved alone when it enters, leaves or changes rank.
 * No reader of the product reads it (the list reads the groups); the
 * snapshot and the tests do.
 */

import { compareStructural, createAtom, makeObservable, reaction, runInAction } from 'mobx'
import { debugName } from '../debug-name'
import { type RelationLinks, refs } from '../shared/links'
import { compareRank, type RowRank } from '../shared/row-view'
import { awaitingMergeOf } from '../shared/schema'
import type { SliceIssue, SliceSession } from '../shared/slice-types'
import {
  FINISHED_GRACE_MS,
  isClosedTopLevel,
  type OwnPart,
  ownPartOfRow,
  parseMs,
  rankOfPart,
} from '../views'
import { type Filing, type Placement, placementOfPart } from './groups'
import {
  type Attention,
  attentionOf,
  formalParentPartOf,
  type Loaded,
  ownFactsPartOf,
  type Progress,
  progressOf,
  type RollupInputs,
  type RollupParts,
  rollupPartOf,
  type SeatVerdict,
  seatActivityPartOf,
  seatVerdictOf,
  tipPartOf,
  waitingPartOf,
} from './rollup'
import { NO_SEATS, type SeatSummary } from './seat-verdicts'
import { SortedLanes } from './sorted-lanes'

/** `SIDEBAR_FINISHED_UNREAD_WINDOW_MS` (`visibility.ts:22`). */
export const FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Everything the visibility parts read. Tracked in the live pool; plain in the rebuild. */
export interface VisibleInputs {
  readonly issueSessionFact?: IssueSessionFactReader
  /** Every relation, by typed name (POD-4758, `shared/src/links.ts`). */
  readonly links: RelationLinks
  /** An issue's row, hot or cold (a cold one read by id through the feed); undefined when unknown. */
  issueRow(id: string): SliceIssue | undefined
  /** A session's row, hot or cold; undefined when unknown. */
  sessionRow(id: string): SliceSession | undefined
  /** Another known issue's parts (its object in the live pool); undefined when unknown. */
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
  /** The present rows whose `nestParent` is `id` (the live pool's derived `nested` group). */
  nested(id: string): Iterable<string>
  /** The known issues whose declared `issue.parent` is `id` (the relation engine's `children` bucket). */
  formalChildren(id: string): Iterable<string>
  /** The maintained SORTED seat list itself, returned without iterating it. */
  seatList(id: string): readonly string[]
  /**
   * TRACKED, live pool only (POD-5423): the explicit seats' verdicts, judged
   * per seat change (`seat-verdicts.ts`). Absent in the plain rebuild, which
   * judges every seat directly.
   */
  seatSummary?(id: string): SeatSummary
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
   * A finished, non-abandoned issue whose private branch holds unlanded work
   * (`awaitingMergeOf`, `issuePendingDecision`'s `merge`): R-VIS keeps it
   * without limit (`rows.ts:95-104`, `visibility.ts:31-32`), whatever its
   * audience, parent or sessions. Read off the composed row (the wire carries
   * `branch`/`gitState`); never a new row read.
   */
  readonly awaitingMerge: boolean
  /**
   * The sessionless keep, before the clock (`rows.ts:86-96`): `keep`
   * (active human), `drop`, `fold` (a closed top-level issue: kept, no decay,
   * `visibility.ts:30`), or `decay` (a finished formal child: kept inside the
   * `issueVisibleInSidebar` window). An awaiting-merge row never reaches this:
   * `flatOf` keeps it before the switch.
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
  readonly replicaActivityMs?: number | null
  /** Headless own presence supplements R2 without joining its roster. */
  readonly headlessStaffed?: boolean
  readonly deleted: boolean
  readonly pinned: boolean
  /**
   * The declared `issue.parent` forward key: the relation engine's own
   * `refs.issue.parent` over this row (foreign key and `where`), so it costs this
   * row alone and never the parent's residency. The progress filing's key.
   */
  readonly formalParent: string | null
}

/**
 * POD-4753 — what visibility reads of a HIDDEN issue: one the complete cold
 * rule keeps out of memory. The raw parent and exclusion fields let nesting
 * pass through it and rescue compose below it. An unplaced agent ancestor
 * can still attract a live child before nesting; its compact `flatUntil`
 * keeper bound decides whether that child needs the ancestor loaded. Cold
 * leaves read none of their sessions. These fields and the derived deadline
 * are the declared summary, never the full row.
 */
export const HIDDEN_ISSUE_FIELDS = ['parentId', 'audience', 'archived', 'deletedAt', 'stage'] as const

/** A hidden issue's declared summary (`HIDDEN_ISSUE_FIELDS`). */
export type HiddenIssue = Partial<Pick<SliceIssue, (typeof HIDDEN_ISSUE_FIELDS)[number]>> & {
  /** Declared derived summary, from existing own/member/lane deadlines (`coldFlatUntil`). */
  readonly flatUntil?: number
}

/** The presence of a hidden issue, from its summary and the rows below it: never flat or present. */
export function hiddenPresenceOf(
  input: VisibleInputs,
  id: string,
  hidden: HiddenIssue,
  self: Pick<IssueVisibility, 'parentRef'>,
): Presence {
  rescueWalkOf(input)?.paths.delete(self)
  const keeps = !isExcluded(hidden) && keptBelowPartOf(input, id, childIdsPartOf(input, id), self, true)
  // An unplaced agent row may still have pre-nesting presence from a seat.
  // A live descendant needs that verdict: it might nest under this row and
  // disappear with it. Load through the normal window only when needed,
  // rather than observing all the historical row's member sessions.
  if (keeps && hidden.audience === 'agent' && hidden.flatUntil !== undefined && !input.passed(hidden.flatUntil)) {
    void input.loadedIssue(id)
  }
  return { flat: false, keeps, present: false }
}

export function standingOf(issue: SliceIssue, facts?: Pick<Standing,
  'excluded' | 'finished' | 'awaitingMerge' | 'parentId' | 'finishedMs' | 'updatedMs' | 'formalParent' |
  'replicaActivityMs' | 'headlessStaffed'>, sessionFact?: IssueSessionFactReader): Standing {
  const excluded = facts ? facts.excluded : isExcluded(issue)
  const finished = facts ? facts.finished : isFinished(issue)
  const human = issue.audience === 'human'
  const activeHuman =
    human &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  const awaitingMerge = facts ? facts.awaitingMerge : !excluded && awaitingMergeOf(issue)
  // `issueAwaitingMerge` reads branch and git state off the composed row: the
  // wire carries both, so the verdict is available here (it used to read as
  // never true because no slice field spelled it).
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
    awaitingMerge,
    sessionless,
    rescuable: human && !finished,
    parentId: facts ? facts.parentId : issue.parentId || null,
    startedBy:
      !issue.parentId && !spinOff && issue.startedBySession ? issue.startedBySession : null,
    draftVessel: issue.isDraftVessel === true && !issue.worktreePath,
    finishedMs: facts ? facts.finishedMs : parseMs(issue.closedAt ?? issue.updatedAt) ?? 0,
    updatedMs: facts ? facts.updatedMs : parseMs(issue.updatedAt),
    replicaActivityMs: facts ? facts.replicaActivityMs : parseMs(sessionFact?.(issue.id, 'replicaActivityAt')),
    headlessStaffed: facts ? facts.headlessStaffed : sessionFact?.(issue.id, 'headlessStaffed') === true,
    deleted: issue.deletedAt != null,
    pinned: issue.pinned === true,
    formalParent: facts ? facts.formalParent : refs.issue.parent(issue),
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
function issueFactsOf(
  issue: SliceIssue,
  input: Pick<VisibleInputs, 'passed' | 'reached' | 'issueSessionFact'>,
): IssueFacts {
  const part = ownPartOfRow(issue, input)
  return {
    standing: standingOf(issue, undefined, input.issueSessionFact),
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
function readCursorOf(raw: string | null | undefined): {
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
  issue: Partial<Pick<SliceIssue, 'closedAt' | 'updatedAt'>> | undefined,
  standing: Pick<Standing, 'finished'> | undefined,
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

export function sessionLinksOf(input: Pick<VisibleInputs, 'links'>, id: string): SessionLinks {
  return {
    issueLink: input.links.session.issue(id),
    worktreeLink: input.links.session.worktree(id),
  }
}

/** A session's parts computed directly (the rebuild). */
export function directSessionVisibility(
  input: Pick<VisibleInputs, 'links' | 'sessionRow' | 'loadedSession'>,
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
  /** A cold hidden issue's declared summary; absent in the plain rebuild. */
  readonly hidden?: HiddenIssue
  /** The raw `parentId` the nesting walk follows (`standing.parentId`; a hidden issue's from its summary). */
  readonly parentRef: string | null
  readonly childIds: readonly string[]
  /** `issue.spinOffs` (R4, the inverse edge), id order: the roll-ups' vacated and continuation tests. */
  readonly spinOffIds: readonly string[]
  readonly unread: boolean
  readonly flat: boolean
  readonly keptBelow: boolean
  readonly keeps: boolean
  readonly present: boolean
  /** The proposed parent before cycle rejection; reads no issue's nesting. */
  readonly nestCandidate: string | null
  readonly nestParent: string | null
  readonly placed: boolean
  readonly visible: boolean
  readonly rank: RowRank | undefined
  /** `standing.finished`, or undefined for an unknown issue (the row picks its root verdict by it). */
  readonly finished: boolean | undefined
  /** R-GROUP 3's "nothing in the subtree waits": the aggregate under this row. */
  readonly waiting: boolean
  /** The present rows found down the raw parent edge through hidden rows (`nestBelowPartOf`). */
  readonly nestBelow: readonly string[]
}

/** The roll-up parts' inputs over the visibility inputs: held issues for rows, sessions for seats. */
export function rollupInputsOf(input: VisibleInputs): RollupInputs {
  return {
    reached: input.reached,
    loadedIssue: (id) => input.loadedIssue(id),
    tipActivityAt: input.issueSessionFact ? (id) => input.issueSessionFact!(id, 'tipActivityAt') : undefined,
    spinOffCount: (id) => input.links.issue.spinOffs.size(id),
    nested: (id) => input.nested(id),
    formalChildren: (id) => input.formalChildren(id),
    rollupNode: (id) => input.issue(id),
    seat: (id) => input.session(id).verdict,
    seatActivity: (id) => input.session(id).activityMs,
    spinOffIds: (id) => input.issue(id)?.spinOffIds ?? [],
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
  const worktree = input.links.issue.worktree(id)
  if (worktree === null) return []
  return [...input.links.worktree.sessions.issueless(worktree)].sort()
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
  return [...input.links.issue.children.ids(id)].sort()
}

export function spinOffIdsPartOf(input: VisibleInputs, id: string): readonly string[] {
  return [...input.links.issue.spinOffs.ids(id)].sort()
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
export function openOwnPartOf(
  input: VisibleInputs,
  id: string,
  seatIds: readonly string[],
  standing: Standing | undefined,
): boolean {
  for (const sessionId of seatIds) {
    const retention = input.session(sessionId).retention
    if (retention !== null && retention.issueId === id && !retention.archived && !retention.exited) {
      return true
    }
  }
  // Headless seats are absent from R2 and never collapse with resume twins.
  // Reuse the own-row facts already read by members; no second read or load.
  return standing?.headlessStaffed === true
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

/** Who the members are: R2's seats and R3's lane, without judging any of them. */
export type MemberSeats = Pick<Members, 'seatIds' | 'laneMemberIds' | 'memberIds'>

/** What the members' verdicts give, at the clock. */
export type MemberVerdicts = Omit<Members, keyof MemberSeats>

/** The membership part of issue `id`: re-runs only when a seat or lane member joins or leaves. */
function memberSeatsOf(input: VisibleInputs, id: string): MemberSeats {
  // A copy: the maintained list mutates in place, and a cached group must
  // hold a value (a membership change re-runs this through the list's reads).
  const seatIds = input.seatList(id).slice()
  const laneMemberIds = laneMemberIdsPartOf(input, id)
  return { seatIds, laneMemberIds, memberIds: memberIdsPartOf(seatIds, laneMemberIds) }
}

/** Whether `id` is in the sorted `list` (binary search: reads log n elements). */
function sortedHas(list: readonly string[], id: string): boolean {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as string) < id) lo = mid + 1
    else hi = mid
  }
  return list[lo] === id
}

/** Two id-ordered lists as one, in id order. */
export function mergeIds(a: readonly string[], b: readonly string[]): readonly string[] {
  if (b.length === 0) return a
  if (a.length === 0) return b
  return [...a, ...b].sort()
}

/** Retained R3 members that are not explicit R2 seats. */
export function laneRetainedSeatIdsPartOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  laneMemberIds: readonly string[],
): readonly string[] {
  const seatList = input.seatList(id)
  const laneOnly = laneMemberIds.filter(sessionId => !sortedHas(seatList, sessionId))
  return retainedSeatIdsPartOf(input, id, standing, laneOnly)
}

/**
 * The verdicts part of issue `id` over its standing and members. With the
 * live pool's seat summary the explicit seats are already judged (one seat
 * per change), so a re-run costs the retained seats and the lane, never the
 * seat history; the plain rebuild judges every member here.
 */
export function memberVerdictsOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
  seats: MemberSeats,
): MemberVerdicts {
  // An issue with no explicit seat needs no summary: its (tracked) empty
  // list re-runs this when one joins, and only then is a summary made.
  const seatList = input.seatList(id)
  const summary =
    input.seatSummary === undefined
      ? undefined
      : seatList.length === 0
        ? NO_SEATS
        : input.seatSummary(id)
  let retainedSeatIds: readonly string[]
  let rosterIds: readonly string[]
  let openOwn: boolean
  if (summary === undefined) {
    retainedSeatIds = retainedSeatIdsPartOf(input, id, standing, seats.memberIds)
    rosterIds = rosterIdsPartOf(input, retainedSeatIds)
    openOwn = openOwnPartOf(input, id, seats.seatIds, standing)
  } else {
    // R3 members that are not R2 seats: judged here, as the rebuild does.
    const laneOnly = seats.laneMemberIds.filter((sessionId) => !sortedHas(seatList, sessionId))
    const laneRetained = retainedSeatIdsPartOf(input, id, standing, laneOnly)
    retainedSeatIds = standing === undefined ? [] : mergeIds(summary.retained, laneRetained)
    rosterIds =
      standing === undefined ? [] : mergeIds(summary.roster, rosterIdsPartOf(input, laneRetained))
    openOwn = summary.present > 0 || standing?.headlessStaffed === true
  }
  return {
    retainedSeatIds,
    rosterIds,
    retained: standing !== undefined && !standing.excluded && retainedSeatIds.length > 0,
    liveRoster: rosterIds.length > 0,
    openOwn,
  }
}

/** The members group of issue `id`, over its standing (both parts, one pass). */
export function membersOf(
  input: VisibleInputs,
  id: string,
  standing: Standing | undefined,
): Members {
  const seats = memberSeatsOf(input, id)
  return { ...seats, ...memberVerdictsOf(input, id, standing, seats) }
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
  if (standing.replicaActivityMs != null && standing.replicaActivityMs > readMs) return true
  // The live pool keeps the seats' latest activity in the issue's seat
  // summary (POD-5423): one number, never a walk of the seat history.
  if (input.seatSummary !== undefined) {
    const activity = seatIds.length === 0 ? null : input.seatSummary(id).activity
    return activity !== null && activity > readMs
  }
  for (const sessionId of seatIds) {
    const session = input.session(sessionId)
    if (session.retention === null || session.retention.shell) continue
    const at = session.activityMs
    if (at !== null && at > readMs) return true
  }
  return false
}

interface RescueCycle {
  /** Raw-parent order, recorded only after a rescue path repeats. */
  readonly ids: readonly string[]
}

interface RescueWalk {
  readonly active: Map<string, object>
  /** Cached presence reads; weak references do not retain removed models. */
  readonly paths: WeakMap<object, { id: string; children: WeakRef<object>[] }>
  readonly cycles: WeakMap<object, RescueCycle>
}

const RESCUE_WALK = Symbol('presence-rescue')

/** Native metadata belongs to the pool's inputs, never a module cache. */
function rescueWalkOf(input: VisibleInputs): RescueWalk | undefined {
  return (input as VisibleInputs & { [RESCUE_WALK]?: RescueWalk })[RESCUE_WALK]
}

/** A cached child's dependency check can reach a running presence before its body runs. */
function repeatsRescue(walk: RescueWalk, id: string, child: object): boolean {
  if (walk.active.has(id)) return true
  const pending = [child]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const part = pending.pop() as object
    if (seen.has(part)) continue
    seen.add(part)
    const path = walk.paths.get(part)
    if (path === undefined) continue
    if (walk.active.has(path.id)) return true
    for (const ref of path.children) {
      const below = ref.deref()
      if (below !== undefined) pending.push(below)
    }
  }
  return false
}

/** Parent facts are read only for a repeated path, never for ordinary ancestry. */
function rememberRescueCycle(input: VisibleInputs, walk: RescueWalk, id: string): void {
  const ids: string[] = []
  const seen = new Set<string>()
  let parentId: string | null = id
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId)
    ids.push(parentId)
    parentId = input.issue(parentId)?.parentRef ?? null
  }
  if (parentId !== id) return
  const cycle: RescueCycle = { ids }
  for (const memberId of ids) {
    const part = input.issue(memberId)
    if (part !== undefined) walk.cycles.set(part, cycle)
    const active = walk.active.get(memberId)
    if (active !== undefined) walk.cycles.set(active, cycle)
  }
}

/** A remembered cycle is valid only while every raw parent still closes it. */
function currentRescueCycle(input: VisibleInputs, walk: RescueWalk, self: object): boolean {
  const cycle = walk.cycles.get(self)
  if (cycle === undefined) return false
  const parts = cycle.ids.map(id => input.issue(id))
  if (parts.every((part, index) => part?.parentRef === cycle.ids[(index + 1) % cycle.ids.length])) {
    for (const part of parts) if (part !== undefined) walk.cycles.set(part, cycle)
    return true
  }
  for (const part of parts) {
    if (part !== undefined && walk.cycles.get(part) === cycle) walk.cycles.delete(part)
  }
  walk.cycles.delete(self)
  return false
}

/** Least rescue verdict: actual flat work below, with no presence dependency back into the walk. */
function flatKeptBelow(input: VisibleInputs, childIds: readonly string[]): boolean {
  const seen = new Set<string>()
  const pending = [...childIds]
  while (pending.length > 0) {
    const childId = pending.pop() as string
    if (seen.has(childId)) continue
    seen.add(childId)
    const child = input.issue(childId)
    if (child === undefined) continue
    const hidden = child.hidden
    if (hidden !== undefined) {
      if (isExcluded(hidden)) continue
    } else {
      const standing = child.standing
      if (standing === undefined || standing.excluded) continue
      if (flatOf(input, childId, standing, child)) return true
    }
    pending.push(...childIdsPartOf(input, childId))
  }
  return false
}

/** Some child is flat or kept, through non-excluded children (`rows.ts:130-146`). */
export function keptBelowPartOf(
  input: VisibleInputs,
  id: string,
  childIds: readonly string[],
  self: Pick<IssueVisibility, 'parentRef'>,
  fromPresence = false,
): boolean {
  if (childIds.length === 0) return false
  let walk = rescueWalkOf(input)
  if (walk === undefined) {
    walk = { active: new Map(), paths: new WeakMap(), cycles: new WeakMap() }
    // A plain rebuild copies the inputs but needs its own guard. Keep this
    // pool-owned metadata non-enumerable, outside the tracked input values.
    Object.defineProperty(input, RESCUE_WALK, { value: walk })
  }
  // Record only the presence group's reads. The standalone keptBelow
  // getter must not replace that cached group's dependency path.
  const path = { id, children: [] as WeakRef<object>[] }
  if (fromPresence) walk.paths.set(self, path)
  if (currentRescueCycle(input, walk, self)) return flatKeptBelow(input, childIds)
  if (walk.active.has(id)) {
    rememberRescueCycle(input, walk, id)
    return flatKeptBelow(input, childIds)
  }
  walk.active.set(id, self)
  try {
    for (const childId of childIds) {
      const child = input.issue(childId)
      if (child === undefined) continue
      if (repeatsRescue(walk, childId, child)) {
        rememberRescueCycle(input, walk, childId)
        return flatKeptBelow(input, childIds)
      }
      if (fromPresence) path.children.push(new WeakRef(child))
      const keeps = child.keeps
      // A child can discover this cycle while the cached read is running.
      if (walk.cycles.has(self)) return flatKeptBelow(input, childIds)
      if (keeps) return true
    }
    return false
  } finally {
    walk.active.delete(id)
  }
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
  self: Pick<IssueVisibility, 'standing' | 'retained' | 'seatIds' | 'parentRef'>,
): Presence {
  rescueWalkOf(input)?.paths.delete(self)
  const standing = self.standing
  if (standing === undefined || standing.excluded) {
    return { flat: false, keeps: false, present: false }
  }
  const flat = flatOf(input, id, standing, self)
  if (flat) return { flat, keeps: true, present: true }
  const keptBelow = keptBelowPartOf(input, id, childIdsPartOf(input, id), self, true)
  return { flat, keeps: keptBelow, present: standing.rescuable && keptBelow }
}

/** This row's flat verdict, without rescue or descendant reads. */
export function flatPartOf(
  input: VisibleInputs,
  id: string,
  self: Pick<IssueVisibility, 'standing' | 'retained' | 'seatIds'>,
): boolean {
  const standing = self.standing
  return standing !== undefined && !standing.excluded && flatOf(input, id, standing, self)
}

/** The rescue contribution, preserving the presence walk's cycle guard. */
export function keepsPartOf(
  input: VisibleInputs,
  id: string,
  self: Pick<IssueVisibility, 'standing' | 'flat' | 'parentRef'>,
): boolean {
  rescueWalkOf(input)?.paths.delete(self)
  const standing = self.standing
  if (standing === undefined || standing.excluded) return false
  return self.flat || keptBelowPartOf(input, id, childIdsPartOf(input, id), self, true)
}

function flatOf(
  input: VisibleInputs,
  id: string,
  standing: Standing,
  self: Pick<IssueVisibility, 'retained' | 'seatIds'>,
): boolean {
  if (self.retained) return true
  // A finished row awaiting merge is kept without limit (`rows.ts:95-104`,
  // `visibility.ts:31-32`): unlanded commits stay unlanded, so no window is
  // read. Before the sessionless switch, as the legacy gate is before its own.
  if (standing.awaitingMerge) return true
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
export function nestCandidatePartOf(
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
    parentId = parent.parentRef
  }
  if (standing.parentId !== null || standing.startedBy === null) return null
  const owner = ownerOf(input, standing.startedBy)
  if (owner === null || owner === id) return null
  const candidate = input.issue(owner)
  if (candidate?.standing?.draftVessel === true && candidate.liveRoster) return null
  return owner
}

/**
 * Legacy admits edges in the replica's id order and rejects the one that
 * closes a cycle (`rows.ts:310-321`): its greatest id stays top-level. Walk
 * only candidates, never another nesting computation, so placement and the
 * attention roll-up cannot recurse through the cycle. A greater id rules
 * this edge out as the break; a repeated id other than self is a downstream
 * cycle, so incoming branches keep their parent. No whole-collection scan.
 */
export function nestParentPartOf(
  input: VisibleInputs,
  id: string,
  candidate: string | null,
): string | null {
  if (candidate === null || candidate > id) return candidate
  const seen = new Set<string>()
  let walk: string | null = candidate
  while (walk !== null) {
    if (walk === id) return null
    if (walk > id || seen.has(walk)) break
    seen.add(walk)
    walk = input.issue(walk)?.nestCandidate ?? null
  }
  return candidate
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
  for (const issueId of input.links.worktree.issues.ids(worktree)) {
    if (owner !== null && issueId > owner) continue
    const issue = input.issue(issueId)
    // Presence first: a hidden issue answers it without its row.
    if (issue?.present === true && issue.standing?.excluded === false) owner = issueId
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
  candidate: string | null,
): Nesting {
  if (!present) return UNPLACED
  const nestParent = nestParentPartOf(input, id, candidate)
  const placed =
    nestParent !== null ? input.issue(nestParent)?.placed === true : standing?.agent === false
  return { nestParent, placed, visible: placed }
}

const NONE: readonly string[] = Object.freeze([]) as readonly string[]

/**
 * The present rows below `id` down the raw parent edge (`issue.treeChildren`,
 * archived and deleted issues included, as the nest walk goes up through any
 * issue): a present child is one, a hidden child passes on its own. Every
 * row the nest walk from a present descendant would stop at `id` is here
 * (and a few it would not: a parent cycle), so it is a candidate list that
 * `nestedPartOf` filters by each row's own `nestParent`. A walk down a
 * cycle ends at the first present row, and no present row is above a cycle
 * of hidden ones, so the recursion ends.
 */
export function nestBelowPartOf(input: VisibleInputs, id: string): readonly string[] {
  const below: string[] = []
  for (const childId of input.links.issue.treeChildren.ids(id)) {
    const child = input.issue(childId)
    if (child === undefined) continue
    if (child.present) below.push(childId)
    else below.push(...child.nestBelow)
  }
  return below.length === 0 ? NONE : below.sort()
}

/**
 * The present rows nested under `id` (the inverse of `nestParentPartOf`): the
 * candidates below it, and the issues its member sessions started (the
 * started-by fallback), each kept when its own `nestParent` is `id`.
 */
export function nestedPartOf(
  input: VisibleInputs,
  id: string,
  self: Pick<IssueVisibility, 'present' | 'memberIds' | 'nestBelow'>,
): readonly string[] {
  if (!self.present) return NONE
  const nested = new Set<string>()
  for (const childId of self.nestBelow) {
    if (input.issue(childId)?.nestParent === id) nested.add(childId)
  }
  for (const sessionId of self.memberIds) {
    for (const started of input.links.session.startedIssues.ids(sessionId)) {
      if (input.issue(started)?.nestParent === id) nested.add(started)
    }
  }
  return nested.size === 0 ? NONE : [...nested].sort()
}

/** L1b `rankOf` over the own row: the fields it reads, band from the clock (spec R-ORDER). */
function rankPartOf(input: VisibleInputs, id: string): RowRank | undefined {
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
    once('nesting', () => nestingOf(input, id, parts.standing, parts.present, parts.nestCandidate))
  const attention = (): Attention => once('attention', () => attentionOf(rollupInputs, id, parts))
  const progress = (): Progress => once('progress', () => progressOf(rollupInputs, id, parts))
  const parts: IssueVisibility = {
    get standing() {
      return once('standing', () => {
        const issue = input.issueRow(id)
        return issue === undefined ? undefined : standingOf(issue, undefined, input.issueSessionFact)
      })
    },
    get parentRef() {
      return parts.standing?.parentId ?? null
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
      return once('openOwn', () => openOwnPartOf(input, id, parts.seatIds, parts.standing))
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
      return once('keptBelow', () => keptBelowPartOf(input, id, parts.childIds, parts))
    },
    get keeps() {
      return presence().keeps
    },
    get present() {
      return presence().present
    },
    get nestCandidate() {
      return once('nestCandidate', () => nestCandidatePartOf(input, id, parts.present ? parts.standing : undefined, parts.present))
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
    get nestBelow() {
      return once('nestBelow', () => nestBelowPartOf(input, id))
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
      return once('seatActivity', () => seatActivityPartOf(rollupInputs, id, parts))
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

/** Visible ids in L1b rank order (the rebuild's order; the live `order` holds the same list, maintained). */
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

// ------------------------------------------------------------ the collection

/** One known issue as the worklist reads it: its parts, and where its row goes. */
export interface HeldIssue extends IssueVisibility {
  readonly id: string
  readonly placement: Placement | undefined
}

/** What the collection reads from the pool. */
export interface VisibleHost {
  /** The one object of issue `id`, built on first request. */
  issue(id: string): HeldIssue
  /** File one row into the groups' lanes (`WorklistGroups.file`). */
  fileGroups(id: string, filing: Filing | undefined): void
}

/** The order's one key. */
const VISIBLE = 'visible'

/** What a row files: its placement and rank while visible, else nothing. */
function filingOf(issue: HeldIssue): Filing | undefined {
  if (!issue.placed) return undefined
  const { placement, rank } = issue
  return placement === undefined || rank === undefined ? undefined : { placement, rank, root: issue.nestParent === null }
}

/**
 * The visible collection: one filing reaction per tracked issue WHILE THE
 * LIST IS ON SCREEN, the visible order it maintains, and (through the host)
 * the groups' lanes.
 *
 * POD-5423 (review finding 8): the work follows the screen, not memory. An
 * issue in memory is a CANDIDATE (`track`, plain bookkeeping); its filing
 * reaction exists only while the lanes are wanted: held by a screen that
 * draws them (`retain`, taken when the screen attaches, so its first paint
 * finds them filed), or observed by any reader of a lane (`need`, the
 * fallback: the reactions then start when that read's batch ends). With
 * neither, no candidate holds a reaction, so no visibility graph (facts,
 * members, presence, nesting, rank) is kept alive for a header-only,
 * settings-only or detached pool. When the last hold and the last reader go,
 * every reaction stops and every row leaves the lanes, which nobody reads.
 */
export class VisibleCollection {
  /** The visible ids in rank order, one row moved per filing. */
  private readonly visible = new SortedLanes<string, RowRank>(compareRank, 'pool.visible', () => this.need())
  /**
   * Every issue in memory that may file a row, with its filing reaction's
   * stop while the list is live, else null (maintenance only, never read by a
   * derivation).
   */
  private readonly stops = new Map<string, (() => void) | null>()
  /** Holds taken by screens that draw the list (`retain`). */
  private holds = 0
  /** Whether some derivation reads a lane (the demand atom is observed). */
  private observed = false
  /** Whether the candidates' reactions run. */
  private live = false
  /** Reported by every lane read: observed means a list is drawn. */
  private readonly demand = createAtom(
    'pool.worklist.demand',
    () => {
      this.observed = true
      this.activate()
    },
    () => {
      this.observed = false
      this.settleIdle()
    },
  )

  constructor(private readonly host: VisibleHost) {
    makeObservable<
      VisibleCollection,
      | 'visible'
      | 'stops'
      | 'holds'
      | 'observed'
      | 'live'
      | 'demand'
      | 'host'
      | 'file'
      | 'start'
      | 'activate'
      | 'settleIdle'
    >(this, {
      visible: false,
      stops: false,
      holds: false,
      observed: false,
      live: false,
      demand: false,
      host: false,
      file: false,
      start: false,
      activate: false,
      settleIdle: false,
      need: false,
      retain: false,
      track: false,
      untrack: false,
      tracks: false,
      clear: false,
    })
  }

  /** TRACKED: report a read of the filed lanes (every lane read calls this). */
  need(): void {
    this.demand.reportObserved()
  }

  /**
   * Hold the lanes filed until the returned release runs (a screen that
   * draws the list, from its attachment). Outside any derivation: the
   * reactions start and file every candidate before this returns.
   */
  retain(): () => void {
    this.holds += 1
    runInAction(() => this.activate())
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
      this.settleIdle()
    }
  }

  /**
   * Issue `id` may file a row (call inside an action; a candidate is left as
   * it is). While the list is live its reaction runs when the action ends
   * and files the row wherever it belongs; afterwards it re-files the row
   * when its filing changes, and only then.
   */
  track(id: string): void {
    if (this.stops.has(id)) return
    this.stops.set(id, this.live ? this.start(id) : null)
  }

  /** Issue `id` files nothing any more: release its reaction and take its row out of every list (inside an action). */
  untrack(id: string): void {
    const stop = this.stops.get(id)
    if (stop === undefined) return
    this.stops.delete(id)
    if (stop === null) return
    stop()
    this.file(id, undefined)
  }

  /** Whether issue `id` is a filing candidate (maintenance: plain). */
  tracks(id: string): boolean {
    return this.stops.has(id)
  }

  /** Stop every reaction and empty the order (the pool's dispose; call inside an action). */
  clear(): void {
    for (const stop of this.stops.values()) stop?.()
    this.stops.clear()
    this.live = false
    this.visible.clear()
  }

  /** Start every candidate's reaction (they first run when the current batch ends). */
  private activate(): void {
    if (this.live) return
    this.live = true
    for (const id of this.stops.keys()) this.stops.set(id, this.start(id))
  }

  /** With no hold and no reader left, stop every reaction and empty the lanes. */
  private settleIdle(): void {
    if (!this.live || this.holds > 0 || this.observed) return
    this.live = false
    runInAction(() => {
      for (const [id, stop] of this.stops) {
        if (stop === null) continue
        stop()
        this.stops.set(id, null)
        this.file(id, undefined)
      }
    })
  }

  /** Issue `id`'s filing reaction (a candidate, while the list is live); returns its stop. */
  private start(id: string): () => void {
    const issue = this.host.issue(id)
    return reaction(
      () => filingOf(issue),
      (filing) => this.file(id, filing),
      {
        fireImmediately: true,
        equals: compareStructural,
        name: debugName(() => `pool.file.${id}`),
      },
    )
  }

  /** Move row `id` to where `filing` puts it (inside an action). */
  private file(id: string, filing: Filing | undefined): void {
    this.visible.file(id, filing === undefined ? undefined : VISIBLE, filing?.rank)
    this.host.fileGroups(id, filing)
  }
}
