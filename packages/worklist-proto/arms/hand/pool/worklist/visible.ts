/**
 * POD-4582 (Hb1) — the worklist's visible collection and its order over the
 * hand pool's graph.
 *
 * THE RULE IS NOT DEFINED HERE. Which issue earns a row is the slice spec's
 * R-VIS (`docs/plans/pod-4441-round-two-slice.md` §3, "R-VIS — visible
 * predicate"), whose executable definition is the legacy derivation the
 * parity oracle runs (`buildUnifiedRows` and `nestStartedByIssues`,
 * `client-core/src/viewmodels/slices/worklist/rows.ts`, with
 * `sessionRetainsWorklistRow` / `issueVisibleInSidebar` from `visibility.ts`).
 * The rules below are that definition re-expressed as parts over the graph,
 * each citing the legacy line it follows; they are the parts the MobX arm
 * split it into (`arms/mobx/pool/worklist/visible.ts`, POD-4569), in this
 * arm's idiom (one rule table, a cell per part). The order is L1b's
 * `rankOf` / `compareRank` (`shared/src/row-view.ts`, spec R-ORDER), applied
 * at view time over the visible set (audit §7: Linear sorts a collection
 * when a view reads it).
 *
 * ONE RULE TABLE, TWO CALLERS (as `views.ts`). `VISIBLE_RULES` names every
 * part once. The live pool runs each part in its own cell (`VisibleCells`),
 * over tracked inputs; the rebuild runs the same functions directly over
 * plain maps (`directVisibleParts`, `rebuild.ts`).
 *
 * THE PARTS OF ONE ISSUE, each reading only its own inputs:
 * - `standing`: the own row's facts. `resident`: whether the row is in the
 *   pool's tables (presence only).
 * - `seatIds` (R2, `issue.sessions`), `memberIds` (R2 then R3: the sessions
 *   of `issue.worktree` with no `issueId`, `session-ownership.ts`
 *   `indexSessionOwnership`), `childIds` (`issue.children`): bucket reads,
 *   cached, so a member's change never re-reads its family.
 * - `retained` / `liveRoster` / `unread`: re-composed from each member's
 *   cached part (`SessionVisibleParts.retention`, the pool's per-session
 *   activity cell) and the clock as deadlines (`passed(t)`): a tick wakes
 *   only the rows whose deadline it crosses.
 * - `flat`: the flat pass (`rows.ts:59-107`).
 * - `keptBelow` / `keeps`: the rescue (`rows.ts:121-158`) read DOWN the
 *   children relation: a parent is kept by a child that is flat or kept, and
 *   the walk passes through any non-excluded child. Composed from each
 *   child's cached `keeps`, never a subtree walk. This is the "keeper" of a
 *   sessionless parent: its row flips when a child's `keeps` flips, and on
 *   nothing else of the child's.
 * - `present`: has a row before nesting (flat, or rescued).
 * - `parentLink` / `nestParent` / `placed`: nesting
 *   (`nestStartedByIssues`, `rows.ts:254-359`) decides whether a present row
 *   reaches the screen: a nested row shows under its nest parent, a
 *   top-level one unless it is agent-audience (`rows.ts:354`). The nest
 *   parent is the nearest PRESENT ancestor by the raw `parentId`
 *   (`rows.ts:271-283`), else, for a parentless non-spin-off, the present
 *   issue owning its `startedBySession` (`rows.ts:288-305`).
 * - `visible` = `present && placed`; `rank`: L1b `rankOf` over the row
 *   view's own part (`views.ts` `own`, already cached for the row).
 *
 * COLD ROWS (schema doc §5.1, POD-4665). The shared cold rule
 * (`SCHEMA.issue.cold`, `unlessShown`) is declared as an upper bound on the
 * flat pass: its deadlines are the latest instants a row's own standing or
 * any member session could keep it, so a cold issue is not flat, and its
 * sessions are cold with it. The parts use exactly that and nothing more: a
 * cold issue's `flat` is false without reading it. Its rescue and nesting
 * inputs come from the relations (`children`, `parent`), which the engine
 * maintains for cold rows too. Only when a cold row's own fields decide the
 * answer (a child keeps it, so `excluded` / `rescuable` matter; or its
 * `parent` edge is empty, which an archived row also shows) does a part read
 * it, by id through the feed WITHOUT loading it (`Residency.peek`: counted,
 * tracked, re-read on the row's next update). A first attempt loaded those
 * rows instead (first access): 26 of the 732 visible rows at 1x then
 * appeared one load window after first paint (POD-4582 NOTES). The bound's
 * two stated gaps (an issueless R3 session and a clock rewind) are not
 * covered: the rebuild decides `flat` from every row's data, so the L4b gate
 * fails if a cold row is ever shown.
 *
 * THE COLLECTION IS MAINTAINED, NOT RE-ENUMERATED. Every RESIDENT issue has
 * one `visible` cell (the pool creates it when the row enters the table,
 * `admit`); a cell whose value moves reports its id, and after the drain the
 * order handler (`settle`) moves exactly the reported ids. No part list is
 * written anywhere: each cell recorded what it read (`cells.ts`).
 *
 * THE ORDER is a sorted array of the visible ids, each placed by the rank it
 * had when placed. A row that enters is inserted by binary search, one that
 * leaves is removed, one whose rank moved is moved, each shifting only the
 * slots between its old and new index (`counters.orderShifted`). A commit
 * that reports more than {@link RESORT_FRACTION} of the visible count
 * re-sorts the visible ids from their cached ranks instead
 * (`counters.orderSorts`, `.orderSorted`): a view-time sort of at most the
 * visible count, reading no row (audit §7). The list redraws when the order
 * moves and commits no row for it: slots are keyed.
 */

import type { RelationReader } from '../../../../shared/src/instrument/reads'
import { compareRank, type RowRank, type RowView, rankOf } from '../../../../shared/src/row-view'
import type { SliceIssue, SliceSession } from '../../../../shared/src/slice-types'
import type { Cell, CellGraph } from '../cells'
import { sameData } from '../cells'
import { FINISHED_GRACE_MS, type OwnPart, parseMs } from '../views'

/** `SIDEBAR_FINISHED_UNREAD_WINDOW_MS` (`visibility.ts:22`). */
export const FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A commit that moves more than this share of the visible rows re-sorts them
 * all rather than placing each (the brief's "a batch with many rank changes
 * may re-sort"; one sort of n beats n placements that each shift up to n).
 */
export const RESORT_FRACTION = 1 / 8

/** Everything the visibility parts read. Tracked in the live pool; plain in the rebuild. */
export interface VisibleInputs {
  readonly relations: RelationReader
  /** Whether the row is in the pool's tables (its presence only). */
  resident(entity: 'issue' | 'session', id: string): boolean
  /**
   * An issue's row, resident or cold. A cold one is read by id without being
   * loaded (`Residency.peek`), so a part asks only when its fields decide.
   */
  issueRow(id: string): SliceIssue | undefined
  /** A session's row, the same way. */
  sessionRow(id: string): SliceSession | undefined
  /** Another issue's parts when it is KNOWN (resident or cold); undefined otherwise. */
  issue(id: string): VisibleParts | undefined
  /** A known session's parts; undefined otherwise. */
  session(id: string): SessionVisibleParts | undefined
  /** A session's `lastActiveAt` in ms (the pool's per-session activity cell). */
  sessionActivity(id: string): number | null
  /** The row view's own part of a resident issue (`views.ts` `own`). */
  own(id: string): OwnPart | undefined
  /** `coarseNow > t`. */
  passed(t: number): boolean
}

// ------------------------------------------------------------ own-row facts

/** The own row's facts the visibility parts read (`rows.ts:62-107`). */
export interface Standing {
  /** Archived, deleted, `proposed` or a system-owned stage (`rows.ts:62-69`). */
  readonly excluded: boolean
  /** `stage === 'done' || closedReason != null` (`rows.ts:82`). */
  readonly finished: boolean
  readonly agent: boolean
  /**
   * The sessionless keep, before the clock (`rows.ts:86-96`): `keep` (an
   * active human issue), `drop`, `fold` (a closed top-level issue: kept, no
   * decay, `visibility.ts:30`), or `decay` (a finished formal child: kept
   * inside the `issueVisibleInSidebar` window).
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
  /** The raw `readAt`, epoch ms, or null when absent or unparseable (the unread rollup). */
  readonly readMs: number | null
  readonly hasReadAt: boolean
  readonly updatedMs: number | null
  readonly deleted: boolean
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
    // `isSystemOwnedIssueStage` (`model/src/entities/issue-vocabulary.ts:59`).
    issue.stage === 'shipping'
  const finished = issue.stage === 'done' || issue.closedReason != null
  const human = issue.audience === 'human'
  const activeHuman =
    human &&
    (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
  // `issueAwaitingMerge` reads branch and git state no slice row carries:
  // never true here (as round two's `arms/hand/rules.ts`).
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
  const readMs = typeof issue.readAt === 'string' ? parseMs(issue.readAt) : null
  return {
    excluded,
    finished,
    agent: issue.audience === 'agent',
    sessionless,
    rescuable: human && !finished,
    parentId: issue.parentId || null,
    startedBy:
      !issue.parentId && !spinOff && issue.startedBySession ? issue.startedBySession : null,
    draftVessel: issue.draft === true && !issue.worktreePath,
    finishedMs: parseMs(issue.closedAt ?? issue.updatedAt) ?? 0,
    readMs,
    hasReadAt: Boolean(issue.readAt),
    updatedMs: parseMs(issue.updatedAt),
    deleted: issue.deletedAt != null,
  }
}

// ------------------------------------------------------------ member sessions

/**
 * One session's part in its issue's visibility, without the clock and
 * without its issue (`sessionRetainsWorklistRow`, `visibility.ts:44-70`). An
 * idle session whose turn finished decays from its ISSUE's finish time when
 * that issue is finished, so `finish` names the case and the issue's part
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
 * standing resolving an idle finished turn (`visibility.ts:51-69`).
 */
function retains(
  retention: Retention,
  issue: SliceIssue | undefined,
  standing: Standing,
  input: Pick<VisibleInputs, 'passed'>,
): boolean {
  let finishedMs: number
  if (retention.finish.kind === 'open') return true
  if (retention.finish.kind === 'at') finishedMs = retention.finish.ms
  else {
    if (!standing.finished) return true
    const raw = issue?.closedAt ?? issue?.updatedAt ?? retention.finish.sinceRaw
    if (!raw) return true
    finishedMs = Date.parse(raw) || 0
  }
  if (retention.unread || retention.readMs === null) {
    return !input.passed(finishedMs + FINISHED_UNREAD_WINDOW_MS)
  }
  return !input.passed(Math.max(finishedMs, retention.readMs) + FINISHED_GRACE_MS)
}

// ------------------------------------------------------------ session parts

/** One known session's parts; each is a cell in the live pool. */
export interface SessionVisibleParts {
  readonly resident: boolean
  /** From the row; a cold session's is read only on the started-by path. */
  readonly retention: Retention | null
  /** `session.issue` through the engine (members only: headless out, twins collapsed). */
  readonly issueLink: string | null
  /** `session.worktree` through the engine (the prefix relation). */
  readonly worktreeLink: string | null
}

export type SessionPartName = keyof SessionVisibleParts

type SessionRule<K extends SessionPartName> = (
  input: VisibleInputs,
  id: string,
) => SessionVisibleParts[K]

export const SESSION_RULES: { readonly [K in SessionPartName]: SessionRule<K> } = {
  resident(input, id) {
    return input.resident('session', id)
  },
  retention(input, id) {
    return retentionOf(input.sessionRow(id))
  },
  issueLink(input, id) {
    return input.relations.one('session', id, 'issue')
  },
  worktreeLink(input, id) {
    return input.relations.one('session', id, 'worktree')
  },
}

export const SESSION_PART_NAMES: readonly SessionPartName[] = Object.freeze(
  Object.keys(SESSION_RULES) as SessionPartName[],
)

// ------------------------------------------------------------ issue parts

/** One known issue's visibility parts (see the header); each is a cell in the live pool. */
export interface VisibleParts {
  readonly resident: boolean
  readonly standing: Standing | undefined
  readonly seatIds: readonly string[]
  readonly memberIds: readonly string[]
  readonly childIds: readonly string[]
  readonly retained: boolean
  readonly liveRoster: boolean
  readonly unread: boolean
  readonly flat: boolean
  readonly keptBelow: boolean
  readonly keeps: boolean
  readonly present: boolean
  readonly parentLink: string | null
  readonly nestParent: string | null
  readonly placed: boolean
  readonly visible: boolean
  readonly rank: RowRank | undefined
}

export type VisiblePartName = keyof VisibleParts

type VisibleRule<K extends VisiblePartName> = (
  input: VisibleInputs,
  id: string,
  self: VisibleParts,
) => VisibleParts[K]

/**
 * The retained members of `self` at the clock, stopping at the first
 * (`rows.ts:70-76`); `live` also drops exited ones (`sessionVisibleInLiveRoster`).
 * A COLD member keeps nothing and is not read: a session is cold only while
 * its issue is cold by the shared rule, which holds only once every member's
 * keep has passed (schema doc §5.1). Its issue may be resident all the same
 * (loaded on first access), so this is decided per member.
 */
function anyRetained(input: VisibleInputs, id: string, self: VisibleParts, live: boolean): boolean {
  const standing = self.standing
  if (standing === undefined) return false
  let issue: SliceIssue | undefined
  for (const sessionId of self.memberIds) {
    const session = input.session(sessionId)
    if (session === undefined || !session.resident) continue
    const retention = session.retention
    if (retention == null || !retention.seat || (live && retention.exited)) continue
    if (retention.finish.kind === 'idleDone' && standing.finished) issue ??= input.issueRow(id)
    if (retains(retention, issue, standing, input)) return true
  }
  return false
}

/**
 * The present issue a session belongs to (`issueIdOwningSession` with the
 * ownership index, `session-ownership.ts:371-410`): its explicit issue when
 * that one is present, else, for a session with no `issueId`, a present
 * issue checked out at its worktree (lowest id: legacy takes the first in its
 * list order, which no pool has). A COLD session is cold through its issue
 * (`via`), so it names one and only the explicit branch applies; its row is
 * read only when that issue is present.
 */
function ownerOf(input: VisibleInputs, sessionId: string): string | null {
  const session = input.session(sessionId)
  if (session === undefined) return null
  if (!session.resident) {
    const link = session.issueLink
    if (link === null || input.issue(link)?.present !== true) return null
    const retention = session.retention
    return retention !== null && !retention.archived && retention.issueId === link ? link : null
  }
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
    // `present` first: a cold issue answers it without its row.
    if (issue?.present === true && issue.standing?.excluded === false) owner = issueId
  }
  return owner
}

/**
 * Every visibility part of an issue, once. `self` is the same issue's parts
 * (a cell reading another part of its own issue reads that part's cell).
 */
export const VISIBLE_RULES: { readonly [K in VisiblePartName]: VisibleRule<K> } = {
  resident(input, id) {
    return input.resident('issue', id)
  },
  /** The own row's facts; a cold row's are read only when a part below needs them. */
  standing(input, id) {
    const issue = input.issueRow(id)
    return issue === undefined ? undefined : standingOf(issue)
  },
  /** R2: the explicit members (`issue.sessions`: headless out, twins collapsed), id order. */
  seatIds(input, id) {
    return [...input.relations.many('issue', id, 'sessions')].sort()
  },
  /**
   * R2 then R3: the explicit members, then the sessions of the issue's
   * worktree that carry no `issueId` (`indexSessionOwnership`,
   * `session-ownership.ts:152-165`). Unfiltered: each reader applies its seat
   * rule. A cold session in the worktree names an issue (it is cold through
   * it), so it is never R3 material and its row is not read.
   */
  memberIds(input, id, self) {
    const seatIds = self.seatIds
    const worktree = input.relations.one('issue', id, 'worktree')
    if (worktree === null) return seatIds
    const members = new Set(seatIds)
    for (const sessionId of input.relations.many('worktree', worktree, 'sessions')) {
      const session = input.session(sessionId)
      if (session === undefined || !session.resident) continue
      const retention = session.retention
      if (retention !== null && retention.issueId === undefined) members.add(sessionId)
    }
    return members.size === seatIds.length ? seatIds : [...members].sort()
  },
  childIds(input, id) {
    return [...input.relations.many('issue', id, 'children')].sort()
  },
  /** ≥1 retained member session (`rows.ts:70-76`). */
  retained(input, id, self) {
    const standing = self.standing
    if (standing === undefined || standing.excluded) return false
    return anyRetained(input, id, self, false)
  },
  /** A retained member still on the live roster (`sessionVisibleInLiveRoster`): a draft vessel's test. */
  liveRoster(input, id, self) {
    return anyRetained(input, id, self, true)
  },
  /**
   * The replica's unread rollup (`issue-views.ts:391-410`): never read,
   * updated past the cursor, or an explicit non-shell seat (archived
   * included) active past it; a deleted issue reads as read.
   */
  unread(input, _id, self) {
    const standing = self.standing
    if (standing === undefined || standing.deleted) return false
    if (standing.readMs === null) return true
    if (standing.updatedMs !== null && standing.updatedMs > standing.readMs) return true
    // Activity first: a cold seat reads as never active (its row is not
    // held), which moves nothing: its issue is then cold by the shared rule,
    // whose own deadline is the later of both decay windows, so `flat` does
    // not depend on this answer (schema doc §5.1).
    for (const sessionId of self.seatIds) {
      const at = input.sessionActivity(sessionId)
      if (at === null || at <= standing.readMs) continue
      const retention = input.session(sessionId)?.retention
      if (retention != null && !retention.shell) return true
    }
    return false
  },
  /**
   * The flat pass (`rows.ts:59-107`): retained sessions, else the sessionless
   * keep. A cold issue is not flat: the shared cold rule is declared as an
   * upper bound on exactly these inputs (schema doc §5.1).
   */
  flat(input, _id, self) {
    if (!self.resident) return false
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
        if (self.unread || !standing.hasReadAt) {
          return !input.passed(standing.finishedMs + FINISHED_UNREAD_WINDOW_MS)
        }
        return !input.passed(
          Math.max(standing.finishedMs, standing.readMs ?? 0) + FINISHED_GRACE_MS,
        )
      }
    }
  },
  /** Some child is flat or kept, through non-excluded children (`rows.ts:130-146`). */
  keptBelow(input, _id, self) {
    for (const childId of self.childIds) {
      if (input.issue(childId)?.keeps === true) return true
    }
    return false
  },
  /**
   * What this issue gives its parent's rescue: not excluded, and flat or kept
   * below. The standing is read last, so a cold issue nothing below keeps is
   * answered without its row.
   */
  keeps(_input, _id, self) {
    if (!self.flat && !self.keptBelow) return false
    const standing = self.standing
    return standing !== undefined && !standing.excluded
  },
  /** Has a row before nesting: flat, or a rescued live human ancestor (`rows.ts:121-158`). */
  present(_input, _id, self) {
    if (self.flat) return true
    if (!self.keptBelow) return false
    const standing = self.standing
    return standing !== undefined && !standing.excluded && standing.rescuable
  },
  /**
   * The raw `parentId`, the nesting walk's next step. A resident row's from
   * its standing; a cold row's from the `parent` edge, which the engine keeps
   * for cold rows too. An empty edge is also what an archived or deleted row
   * shows (the relation's `where`), and legacy walks through those by the raw
   * field, so only then is the cold row read.
   */
  parentLink(input, id, self) {
    if (!self.resident) {
      const edge = input.relations.one('issue', id, 'parent')
      if (edge !== null) return edge
    }
    return self.standing?.parentId ?? null
  },
  /**
   * The nearest present ancestor by the raw `parentId`, through any known
   * issue (`rows.ts:271-283`); else, for a parentless non-spin-off, the
   * present issue owning its `startedBySession` unless that one is a draft
   * vessel (`rows.ts:288-305`).
   */
  nestParent(input, id, self) {
    if (!self.present) return null
    const standing = self.standing
    if (standing === undefined) return null
    // Cycle-safe like the legacy walk (`seenParents`, `rows.ts:273-281`).
    const seen = new Set<string>([id])
    let parentId = standing.parentId
    while (parentId !== null) {
      if (seen.has(parentId)) return null
      seen.add(parentId)
      const parent = input.issue(parentId)
      if (parent === undefined) break
      if (parent.present) return parentId
      parentId = parent.parentLink
    }
    if (standing.parentId !== null || standing.startedBy === null) return null
    const owner = ownerOf(input, standing.startedBy)
    if (owner === null || owner === id) return null
    const candidate = input.issue(owner)
    if (candidate?.standing?.draftVessel === true && candidate.liveRoster) return null
    return owner
  },
  /** Reaches the screen: under a placed nest parent, or top-level and not agent-audience (`rows.ts:343-357`). */
  placed(input, _id, self) {
    if (!self.present) return false
    const parent = self.nestParent
    if (parent !== null) return input.issue(parent)?.placed === true
    return self.standing?.agent === false
  },
  visible(_input, _id, self) {
    return self.present && self.placed
  },
  /** L1b `rankOf` over the row view's own part (spec R-ORDER): read for visible rows only. */
  rank(input, id) {
    const own = input.own(id)
    if (own === undefined) return undefined
    const placement: Pick<RowView, 'id' | 'band' | 'sortKey' | 'createdAt' | 'seq'> = {
      id,
      band: own.band,
      sortKey: own.sortKey,
      createdAt: own.createdAt,
      seq: own.seq,
    }
    return rankOf(placement as RowView)
  },
}

export const VISIBLE_PART_NAMES: readonly VisiblePartName[] = Object.freeze(
  Object.keys(VISIBLE_RULES) as VisiblePartName[],
)

// ----------------------------------------------------------- direct (rebuild)

/**
 * The parts of `id` computed directly (the rebuild), memoized for ONE
 * rebuild only (`memo`): a from-scratch pass, like the legacy's own maps.
 */
export function directVisibleParts(
  input: VisibleInputs,
  id: string,
  memo: Map<string, VisibleParts>,
): VisibleParts {
  const held = memo.get(id)
  if (held !== undefined) return held
  const values = new Map<VisiblePartName, unknown>()
  const running = new Set<VisiblePartName>()
  const parts = {} as VisibleParts
  for (const name of VISIBLE_PART_NAMES) {
    Object.defineProperty(parts, name, {
      enumerable: true,
      get: () => {
        // A part that reads itself through a cycle in the data reads
        // undefined, as a live cell on its first run does (`cells.ts`).
        if (running.has(name)) return undefined
        if (!values.has(name)) {
          running.add(name)
          try {
            values.set(name, VISIBLE_RULES[name](input, id, parts))
          } finally {
            running.delete(name)
          }
        }
        return values.get(name)
      },
    })
  }
  memo.set(id, parts)
  return parts
}

/** A session's parts computed directly (the rebuild). */
export function directSessionParts(input: VisibleInputs, id: string): SessionVisibleParts {
  const parts = {} as SessionVisibleParts
  for (const name of SESSION_PART_NAMES) {
    Object.defineProperty(parts, name, {
      enumerable: true,
      get: () => SESSION_RULES[name](input, id),
    })
  }
  return parts
}

/** Visible ids in L1b rank order (the rebuild's order; the live order places by the same comparison). */
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

// ----------------------------------------------------------------- live cells

/** The collection's counters (the pool's `stats.counters` carries them). */
export interface VisibleCounters {
  /** Issue visibility cell sets built (one per issue a part or the collection read). */
  visibleIssues: number
  /** Session visibility cell sets built. */
  visibleSessions: number
  /** Visible-set membership flips (an id placed or removed). */
  membershipFlips: number
  /** Per-row placements: an insert, a removal or a move of one id. */
  orderMoves: number
  /** Slots whose occupant changed across those placements. */
  orderShifted: number
  /** Full re-sorts of the visible ids (a commit that moved many). */
  orderSorts: number
  /** Ids sorted across those re-sorts (the visible count per sort). */
  orderSorted: number
  /** Runs of the groups' layout (POD-4583, `worklist/groups.ts`). */
  groupRuns: number
  /** Ids placed across those runs (the visible count per run). */
  groupElements: number
}

/** What the collection needs from the pool. */
export interface VisibleHost {
  readonly graph: CellGraph
  readonly inputs: VisibleInputs
  readonly counters: VisibleCounters
}

/** Lazy cells over a rule table: a cell per part, created on first read. */
class PartCells<P extends object> {
  readonly cells = new Map<keyof P, Cell<unknown>>()

  constructor(
    readonly id: string,
    private readonly graph: CellGraph,
    private readonly rule: (name: keyof P, self: P) => unknown,
  ) {}

  read(name: keyof P, self: P): unknown {
    let cell = this.cells.get(name)
    if (cell === undefined) {
      const { graph, cells } = this
      const made: Cell<unknown> = graph.cell(
        `${String(name)}:${this.id}`,
        () => this.rule(name, self),
        sameData,
        undefined,
        // Unread parts are collected (`cells.ts`): a part nobody consults is not kept up.
        () => {
          graph.dispose(made)
          if (cells.get(name) === made) cells.delete(name)
        },
      )
      cell = made
      cells.set(name, cell)
    }
    return this.graph.read(cell)
  }

  dispose(): void {
    for (const cell of this.cells.values()) this.graph.dispose(cell)
    this.cells.clear()
  }
}

function partsOver<P extends object>(names: readonly (keyof P)[], cells: PartCells<P>): P {
  const parts = {} as P
  for (const name of names) {
    Object.defineProperty(parts, name, {
      enumerable: true,
      get: () => cells.read(name, parts),
    })
  }
  return parts
}

/**
 * The visible collection: visibility cells per known issue and session
 * (created on first read), one `visible` cell per resident issue, and the
 * rank-ordered array of the visible ids.
 */
export class VisibleCollection {
  private readonly issueCells = new Map<string, PartCells<VisibleParts>>()
  private readonly issueParts = new Map<string, VisibleParts>()
  private readonly sessionCells = new Map<string, PartCells<SessionVisibleParts>>()
  private readonly sessionParts = new Map<string, SessionVisibleParts>()
  /** Per resident issue: its `visible` cell, reporting a move to `reported`. */
  private readonly members = new Map<string, Cell<boolean>>()
  /** Per visible issue: its `rank` cell, reporting a move to `reported`. */
  private readonly ranks = new Map<string, Cell<RowRank | undefined>>()
  /** The visible ids in rank order (maintenance only; no cell reads it). */
  private readonly sorted: string[] = []
  /** The rank each sorted id was placed with. */
  private readonly placedRank = new Map<string, RowRank>()
  /** Ids whose `visible` or `rank` moved in the current commit. */
  private readonly reported = new Set<string>()
  /** The order as last published: a new array only when it moved. */
  private published: readonly string[] = Object.freeze([])
  private moved = false

  constructor(private readonly host: VisibleHost) {}

  /** A known issue's parts (the pool's input door checks it is known). */
  issue(id: string): VisibleParts {
    let parts = this.issueParts.get(id)
    if (parts === undefined) {
      const { inputs } = this.host
      const cells = new PartCells<VisibleParts>(id, this.host.graph, (name, self) =>
        VISIBLE_RULES[name](inputs, id, self as never),
      )
      parts = partsOver(VISIBLE_PART_NAMES, cells)
      this.issueCells.set(id, cells)
      this.issueParts.set(id, parts)
      this.host.counters.visibleIssues += 1
    }
    return parts
  }

  /** A known session's parts. */
  session(id: string): SessionVisibleParts {
    let parts = this.sessionParts.get(id)
    if (parts === undefined) {
      const { inputs } = this.host
      const cells = new PartCells<SessionVisibleParts>(id, this.host.graph, (name) =>
        SESSION_RULES[name](inputs, id),
      )
      parts = partsOver(SESSION_PART_NAMES, cells)
      this.sessionCells.set(id, cells)
      this.sessionParts.set(id, parts)
      this.host.counters.visibleSessions += 1
    }
    return parts
  }

  /**
   * Bring the `visible` cells in line with residency for the issues a commit
   * moved into or out of the tables (call after the drain): a resident one
   * gets its cell, read once, and a gone one loses it. Only the named ids.
   */
  admit(ids: Iterable<string>, resident: (id: string) => boolean): void {
    const { graph } = this.host
    for (const id of ids) {
      const held = this.members.get(id)
      if (resident(id)) {
        if (held !== undefined) continue
        const parts = this.issue(id)
        const cell = graph.cell(
          `member:${id}`,
          () => parts.visible,
          Object.is,
          () => this.reported.add(id),
        )
        this.members.set(id, cell)
        if (graph.read(cell)) this.reported.add(id)
        continue
      }
      if (held === undefined) continue
      graph.dispose(held)
      this.members.delete(id)
      this.reported.add(id)
    }
  }

  /**
   * The order handler (after the drain): place, remove or move exactly the
   * reported ids; a commit that reported many re-sorts the visible ids from
   * their cached ranks. Reads no row.
   */
  settle(): void {
    if (this.reported.size === 0) return
    const { graph, counters } = this.host
    const reported = [...this.reported]
    this.reported.clear()
    const resort = reported.length > Math.max(8, this.sorted.length * RESORT_FRACTION)
    for (const id of reported) {
      const member = this.members.get(id)
      const visible = member !== undefined && graph.read(member)
      const placed = this.placedRank.get(id)
      if (!visible) {
        if (placed === undefined) continue
        if (!resort) this.remove(id, placed)
        this.placedRank.delete(id)
        this.dropRank(id)
        counters.membershipFlips += 1
        this.moved = true
        continue
      }
      const rank = this.rankCell(id)
      if (rank === undefined) continue
      if (placed === undefined) {
        if (!resort) this.insert(id, rank)
        counters.membershipFlips += 1
      } else if (!sameData(placed, rank)) {
        if (!resort) this.move(id, placed, rank)
      } else continue
      this.placedRank.set(id, rank)
      this.moved = true
    }
    if (resort) {
      const ids = [...this.placedRank.keys()].sort((a, b) =>
        compareRank(this.placedRank.get(a) as RowRank, this.placedRank.get(b) as RowRank),
      )
      this.sorted.length = 0
      this.sorted.push(...ids)
      counters.orderSorts += 1
      counters.orderSorted += ids.length
    }
  }

  /** Whether the order moved since the last call (the pool's publish step asks once per commit). */
  takeMoved(): boolean {
    const moved = this.moved
    this.moved = false
    if (moved) this.published = Object.freeze([...this.sorted])
    return moved
  }

  /** The visible ids in rank order; a new array only when the order moved. */
  order(): readonly string[] {
    return this.published
  }

  /** Whether `id` is in the visible set (untracked: handlers and tests). */
  has(id: string): boolean {
    return this.placedRank.has(id)
  }

  /** Visible rows. */
  get size(): number {
    return this.placedRank.size
  }

  /** Visibility cell sets held, per kind, and `visible` cells (tests: lifecycle). */
  held(kind: 'issue' | 'session' | 'member'): number {
    if (kind === 'issue') return this.issueCells.size
    if (kind === 'session') return this.sessionCells.size
    return this.members.size
  }

  /** Cells held: every part cell, `visible` cell and rank cell (tests: lifecycle, counts). */
  cellCount(): number {
    let cells = this.members.size + this.ranks.size
    for (const held of this.issueCells.values()) cells += held.cells.size
    for (const held of this.sessionCells.values()) cells += held.cells.size
    return cells
  }

  /** {@link cellCount} by kind: part cells per part name, and the `member` and `rank` cells (tests: counts). */
  cellsByPart(): {
    issue: Record<string, number>
    session: Record<string, number>
    member: number
    rank: number
  } {
    const tally = (sets: Iterable<PartCells<object>>): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const held of sets) {
        for (const name of held.cells.keys()) out[String(name)] = (out[String(name)] ?? 0) + 1
      }
      return out
    }
    return {
      issue: tally(this.issueCells.values() as Iterable<PartCells<object>>),
      session: tally(this.sessionCells.values() as Iterable<PartCells<object>>),
      member: this.members.size,
      rank: this.ranks.size,
    }
  }

  /** An issue left the pool entirely: its cells go (their readers re-run and find it gone). */
  forgetIssue(id: string): void {
    // The member and rank cells hold this issue's parts: they go first, or
    // disposing a part would re-run them and build cells for a gone issue.
    const member = this.members.get(id)
    if (member !== undefined) {
      this.host.graph.dispose(member)
      this.members.delete(id)
      this.reported.add(id)
    }
    this.dropRank(id)
    const cells = this.issueCells.get(id)
    if (cells === undefined) return
    cells.dispose()
    this.issueCells.delete(id)
    this.issueParts.delete(id)
  }

  /** A session left the pool entirely: its cells go. */
  forgetSession(id: string): void {
    const cells = this.sessionCells.get(id)
    if (cells === undefined) return
    cells.dispose()
    this.sessionCells.delete(id)
    this.sessionParts.delete(id)
  }

  /** Dispose every cell and forget the order (the pool's dispose). */
  clear(): void {
    const { graph } = this.host
    for (const cells of this.issueCells.values()) cells.dispose()
    for (const cells of this.sessionCells.values()) cells.dispose()
    for (const cell of this.members.values()) graph.dispose(cell)
    for (const cell of this.ranks.values()) graph.dispose(cell)
    this.issueCells.clear()
    this.issueParts.clear()
    this.sessionCells.clear()
    this.sessionParts.clear()
    this.members.clear()
    this.ranks.clear()
    this.sorted.length = 0
    this.placedRank.clear()
    this.reported.clear()
    this.published = Object.freeze([])
    this.moved = false
  }

  /** The rank of a visible id, from its cell (created on first placement). */
  private rankCell(id: string): RowRank | undefined {
    let cell = this.ranks.get(id)
    if (cell === undefined) {
      const parts = this.issue(id)
      cell = this.host.graph.cell(
        `rankOf:${id}`,
        () => parts.rank,
        sameData,
        () => this.reported.add(id),
      )
      this.ranks.set(id, cell)
    }
    return this.host.graph.read(cell)
  }

  private dropRank(id: string): void {
    const cell = this.ranks.get(id)
    if (cell === undefined) return
    this.host.graph.dispose(cell)
    this.ranks.delete(id)
  }

  /** The first index whose rank sorts at or after `rank`. */
  private lowerBound(rank: RowRank): number {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const at = this.placedRank.get(this.sorted[mid] as string) as RowRank
      if (compareRank(at, rank) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private insert(id: string, rank: RowRank): void {
    const at = this.lowerBound(rank)
    this.sorted.splice(at, 0, id)
    this.host.counters.orderMoves += 1
    this.host.counters.orderShifted += this.sorted.length - at
  }

  private remove(id: string, rank: RowRank): void {
    const at = this.lowerBound(rank)
    if (this.sorted[at] !== id) throw new Error(`[pool] order lost ${id}`)
    this.sorted.splice(at, 1)
    this.host.counters.orderMoves += 1
    this.host.counters.orderShifted += this.sorted.length - at
  }

  /** Move `id` from its old rank's slot to its new one, shifting only the slots between. */
  private move(id: string, from: RowRank, to: RowRank): void {
    const sorted = this.sorted
    const i = this.lowerBound(from)
    if (sorted[i] !== id) throw new Error(`[pool] order lost ${id}`)
    // `id` still sits at `i` with its old rank, so a later slot's bound counts it.
    const bound = this.lowerBound(to)
    const j = bound > i ? bound - 1 : bound
    if (j < i) for (let k = i; k > j; k -= 1) sorted[k] = sorted[k - 1] as string
    else for (let k = i; k < j; k += 1) sorted[k] = sorted[k + 1] as string
    sorted[j] = id
    this.host.counters.orderMoves += 1
    this.host.counters.orderShifted += Math.abs(i - j) + 1
  }
}
