/**
 * One issue's `RowView` (L1b, `shared/src/row-view.ts`) as a pure function of
 * its inputs.
 *
 * ONE RULE, TWO CALLERS. The live pool caches these parts in groups on the
 * one object per issue (`models.ts`, `IssueModel`), over tracked inputs; the
 * harness-owned rebuild runs the same functions directly over plain maps
 * built from the feed's snapshot (`directParts`,
 * `harness/src/adapters/mobx-rebuild.ts`). Nothing here knows which: a
 * rule cannot drift between the incremental result and its own oracle.
 *
 * WHAT A VIEW DERIVES (inputs per L1b):
 * - own row: `title` (non-draft), `band`, `repoKey`, `pinned`, `sortKey`,
 *   `createdAt`, `seq`, `foldAt` (`ownPartOfRow`: the band and the fold
 *   verdict are computed once per row, and the rank and the group placement
 *   take them from here);
 * - one hop through a declared single-valued relation, resolved by the
 *   relation engine (`inputs.links.issue.repo`, `relations.ts`; the rebuild's
 *   from-scratch scan): `displayRef` (`issue.repo` prefix) and `originTick`
 *   (`issue.discoveredFrom`). No view resolves a relation itself;
 * - locals: `selected` (selection), and the clock through deadlines
 *   (`band`'s defer lapse, `closed`'s grace crossing);
 * - residency: `loading` while the origin or a member session is known but
 *   not in memory. The parts that read them skip a row that is not resident,
 *   so their value is provisional exactly while `loading` is set.
 *
 * THE ROLL-UPS (`worklist/rollup.ts`): `phase`, `progressDone`,
 * `progressTotal`, `working`, `asking` and `workingSince` come from the
 * issue's roll-up (`ViewInputs.rollup`), a composition over its own seats and
 * its children's cached results; `closed`'s "zero waiting" conjunct is the
 * roll-up's `asking`, applied here over the own part's settled verdict.
 * `activityAt` takes the stamps of the row's retained seats
 * (`ViewInputs.retainedSeats`: legacy `retainedSessions`, `rows.ts:98-116`),
 * not every explicit session. The draft title reads the seat list
 * (`sessionIds`, the maintained `issue.sessions` bucket, sorted by session
 * id: the order is the view's).
 *
 * Rules are re-expressed from the frozen slice spec
 * (`docs/plans/pod-4441-round-two-slice.md` §3, cited per rule) and passed
 * parity. No legacy view-model import.
 */

import { resolveDescriptors } from '@podium/harness/browser'
import { DEFER_NEXT_MESSAGE } from '@podium/model'
import type { RelationLinks } from './shared/links'
import {
  isDraftNameSession,
  type RowOriginTick,
  type RowRank,
  type RowView,
  rankOf,
} from './shared/row-view'
import { awaitingMergeOf, type EntityName } from './shared/schema'
import type { SliceIssue, SliceSession } from './shared/slice-types'
import type { Rollup } from './worklist/rollup'

/** The finished-row grace before the closed fold (spec §3 R-GROUP). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** The defer sentinel that never returns on its own (spec §3 R-ORDER). */
export { DEFER_NEXT_MESSAGE }
/** A draft's placeholder title (spec §3 R-SUM). */
export const DRAFT_TITLE = 'Draft'

/** A repo row as the feed spells it (a root lane, or the raw replicated row). */
export interface RepoRow {
  readonly prefix?: string | null
}

/**
 * One issue's derived parts, as the rebuild computes them (`directParts`).
 * The live issue computes the same parts with the same functions, cached in
 * its groups (`models.ts`), and answers the row's fields from them one by
 * one; a group whose value did not move stops the propagation there.
 *
 * Relations are split in two: the TARGET (`repoTarget`, `originRef`: the
 * engine's `one()`, which reads the relation's forward slot and the target's
 * presence, never the own row) and the target's FIELDS (`prefix`,
 * `originTick`). A rename of the row re-runs neither; an origin's rename
 * re-runs only its spin-offs' `originTick`, never their own rows. The
 * rebuild computes the same parts directly (`directParts`), over the
 * from-scratch scan's `one()`, so the gate holds the engine's forward slots
 * to a scan (M3 F2).
 */
export interface IssueParts {
  /** The row-only fields; undefined when the issue is not in the pool. */
  readonly own: OwnPart | undefined
  /** `issue.repo`, resolved by the engine: a present repo's id, or null. */
  readonly repoTarget: string | null
  readonly prefix: string | null
  readonly displayRef: string | undefined
  readonly displayTitle: string | undefined
  /** What a spin-off's origin tick copies (the ref, the title and the seq): a group apart from the own part. */
  readonly label: Label
  /**
   * `issue.discoveredFrom`, resolved by the engine: a KNOWN origin (in the
   * live pool it may be cold), or null. Its loading check reads this.
   */
  readonly originRef: string | null
  /** The origin when it is resident. */
  readonly originId: string | null
  readonly originTick: RowOriginTick | null
  /**
   * The own sessions (`issue.sessions`: explicit members, resume twins
   * collapsed, session-id order): the maintained list, so the parts below
   * walk it, never the relation, and touch no member row they do not need.
   */
  readonly sessionIds: readonly string[]
  readonly activityAt: number
  /** A lazy input (the origin, a member session) is known but not resident yet. */
  readonly loading: boolean
}

/** The fields a row view takes from its own row (and the clock). */
export interface OwnPart {
  readonly band: 0 | 1 | 2
  readonly repoKey: string
  /** The fold verdict with nothing waiting assumed; the view applies the roll-up's `asking`. */
  readonly closed: boolean
  readonly dismissed: boolean
  readonly pinned: boolean
  readonly sortKey: string | null
  readonly createdAt: string
  readonly seq: number
  readonly foldAt: string
}

/** Everything a row view reads. Tracked in the live pool; plain in the rebuild. */
export interface ViewInputs {
  /** Every relation, by typed name (POD-4758, `shared/src/links.ts`). */
  readonly links: RelationLinks
  issue(id: string): SliceIssue | undefined
  session(id: string): SliceSession | undefined
  /**
   * A member session's activity stamp (`activityMsOf`): cached on the
   * session's object in the live pool, so a row re-composing its activity
   * reads each unchanged member's cached value, not its row. Direct in the
   * rebuild.
   */
  sessionActivity(id: string): number | null
  repo(id: string): RepoRow | undefined
  /** Whether a row of `entity` is in the pool (tracks presence only). */
  present(entity: EntityName, id: string): boolean
  /**
   * Whether a row of `entity` is known but not resident: the live
   * pool queues its load. Always false where every row is held (the rebuild).
   */
  loading(entity: EntityName, id: string): boolean
  /** Another issue's label (the origin of a spin-off): its parts, or its object in the live pool. */
  parts(id: string): Pick<IssueParts, 'label'> | undefined
  /** The issue's roll-up fields (its held issue's `rollup`); undefined when the worklist holds none. */
  rollup(id: string): Rollup | undefined
  /**
   * The row's retained seats (the worklist's `retainedSeatIds`: seat members
   * retained at the clock, exited ones included), whose stamps the own-row
   * `activityAt` takes (`rows.ts:98-116`).
   */
  retainedSeats(id: string): readonly string[]
  /** The maintained SORTED seat list itself, returned without iterating it. */
  seatList(id: string): readonly string[]
  /** The selection local: `selectedIssueId === id`. */
  selected(id: string): boolean
  /** `coarseNow >= t`. */
  reached(t: number): boolean
  /** `coarseNow > t`. */
  passed(t: number): boolean
}

// ------------------------------------------------------------------ helpers

export function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// -------------------------------------------------------------- own-row rules

/** Order band: 0 pinned or returned from defer, 2 snoozed, 1 otherwise (spec §3 R-ORDER). */
export function bandOf(issue: SliceIssue, input: Pick<ViewInputs, 'reached'>): 0 | 1 | 2 {
  if (issue.pinned === true) return 0
  if (issue.deferUntil === DEFER_NEXT_MESSAGE) return 2
  const until = parseMs(issue.deferUntil)
  if (until === null) return 1
  return input.reached(until) ? 0 : 2
}

/** `prefix-seq`, else `#seq` (spec §3 R-SUM). */
export function displayRefOf(seq: number, prefix: string | null | undefined): string {
  return prefix ? `${prefix}-${seq}` : `#${seq}`
}

// The current row/local channels carry no served descriptors. Use the canonical
// bundled fallback, with the same labels as the frozen row-view specification.
const PANEL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    resolveDescriptors([]).map((descriptor) => [descriptor.kind, descriptor.shortLabel]),
  ),
)

/**
 * A draft wears its first member's label; everything else its own title (spec
 * §3 R-SUM). The member is asked for only for a draft, so a non-draft's title
 * never depends on its sessions.
 */
export function displayTitleOf(
  issue: SliceIssue,
  firstMemberOf: () => SliceSession | undefined,
): string {
  const title = issue.title.trim()
  if (issue.draft !== true || (title !== '' && title !== DRAFT_TITLE)) return issue.title
  const firstMember = firstMemberOf()
  if (firstMember === undefined) return 'New agent'
  const kind = firstMember.agentKind ?? 'undefined'
  const panelLabel = Object.hasOwn(PANEL_LABELS, kind) ? PANEL_LABELS[kind] : undefined
  const label = kind === 'shell' ? 'Shell' : (panelLabel ?? kind)
  return firstMember.name?.trim() || `New ${label} session`
}

const LEGACY_CLOSE_REASONS: Readonly<Record<string, string>> = {
  wontfix: 'cancelled',
  wont_fix: 'cancelled',
  "won't fix": 'cancelled',
  'not planned': 'cancelled',
  canceled: 'cancelled',
  dupe: 'duplicate',
}

function canonicalCloseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if (key === '') return null
  if (Object.hasOwn(LEGACY_CLOSE_REASONS, key)) return LEGACY_CLOSE_REASONS[key] as string
  return key === 'done' || key === 'cancelled' || key === 'duplicate' || key === 'superseded'
    ? key
    : null
}

/**
 * Abandoned: closed as cancelled, duplicate or superseded (spec §3 R-GROUP;
 * `issueAbandoned` over the canonical close reason). Also R-ROLL's progress
 * test, so it reads only the two fields a cold child's progress facts carry.
 */
export function issueAbandoned(issue: Pick<SliceIssue, 'closedReason' | 'stage'>): boolean {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

/**
 * Closed top-level human issue (`isClosedTopLevelIssue`,
 * `slices/issues.ts:318-322`): a fold candidate (spec §3 R-GROUP) and the
 * sessionless keep's `fold` (`rows.ts:96`).
 */
export function isClosedTopLevel(
  issue: Pick<SliceIssue, 'closedReason' | 'parentId' | 'audience'>,
): boolean {
  return issue.closedReason != null && !issue.parentId && issue.audience === 'human'
}

/**
 * In its group's closed fold, with no selection (spec §3 R-GROUP, L1b
 * `closed`): a settled closure (closed top-level, no `needsHuman`, not
 * awaiting merge — never true in the slice — and nothing waiting) folds at
 * once when abandoned or tucked, else once the clock passes the 24 h grace.
 */
export function closedOf(
  issue: SliceIssue,
  waiting: boolean,
  input: Pick<ViewInputs, 'passed'>,
): boolean {
  if (!isClosedTopLevel(issue) || issue.needsHuman === true || awaitingMergeOf(issue) || waiting) return false
  if (issueAbandoned(issue)) return true
  if (issue.tuckedAt != null) return true
  const finishedAt = parseMs(issue.closedAt ?? issue.updatedAt) ?? 0
  return input.passed(finishedAt + FINISHED_GRACE_MS)
}

/** Closed-fold sort stamp: `tuckedAt ?? closedAt ?? updatedAt` (spec §3 R-GROUP). */
export function foldAtOf(issue: SliceIssue): string {
  return issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt
}

// ------------------------------------------------------------------- parts

/**
 * The row-only fields of `issue` (spec §3 R-ORDER, R-GROUP): the one place
 * the band and the fold verdict are computed for a row (the rank and the
 * group placement take them from here).
 */
export function ownPartOfRow(issue: SliceIssue, input: Pick<ViewInputs, 'passed' | 'reached'>): OwnPart {
  const closed = closedOf(issue, false, input)
  return {
    band: bandOf(issue, input),
    repoKey: issue.repoId ?? issue.repoPath,
    closed,
    dismissed: closed && (issueAbandoned(issue) || issue.tuckedAt != null),
    pinned: issue.pinned === true,
    sortKey: issue.sortKey ?? null,
    createdAt: issue.createdAt,
    seq: issue.seq,
    foldAt: foldAtOf(issue),
  }
}

/** The row-only fields of issue `id`; undefined when it is not in memory. */
export function ownPartOf(input: ViewInputs, id: string): OwnPart | undefined {
  const issue = input.issue(id)
  return issue === undefined ? undefined : ownPartOfRow(issue, input)
}

/** L1b `rankOf` over an own part (spec R-ORDER): the band, manual key and creation. */
export function rankOfPart(id: string, part: OwnPart): RowRank {
  return rankOf({
    id,
    band: part.band,
    sortKey: part.sortKey,
    createdAt: part.createdAt,
    seq: part.seq,
  } as RowView)
}

/**
 * The member a draft is named after: the first session of the sorted member
 * list the shared rule admits (legacy `draftIssueLabel` over
 * `sessionsForIssueNav`, shared `isDraftNameSession`).
 */
function firstMemberOf(input: ViewInputs, sessionIds: readonly string[]): SliceSession | undefined {
  for (const sessionId of sessionIds) {
    const session = input.session(sessionId)
    if (!isDraftNameSession(session)) continue
    return session
  }
  return undefined
}

/** `issue.repo` through the engine (declared in the schema): the repo's id, or null. */
export function repoTargetPartOf(input: ViewInputs, id: string): string | null {
  return input.links.issue.repo(id)
}

/** The resolved repo's prefix (one hop), or null. */
export function prefixPartOf(input: ViewInputs, repoTarget: string | null): string | null {
  return repoTarget === null ? null : (input.repo(repoTarget)?.prefix ?? null)
}

/** `prefix-seq`, else `#seq`, from the parts (spec §3 R-SUM). */
export function displayRefPartOf(
  own: OwnPart | undefined,
  prefix: string | null,
): string | undefined {
  return own === undefined ? undefined : displayRefOf(own.seq, prefix)
}

export function displayTitlePartOf(
  input: ViewInputs,
  id: string,
  sessionIds: readonly string[],
): string | undefined {
  const issue = input.issue(id)
  return issue === undefined
    ? undefined
    : displayTitleOf(issue, () => firstMemberOf(input, sessionIds))
}

/**
 * `issue.discoveredFrom` through the engine (declared in the schema): the
 * origin's id when it is known, resident or cold (`one()` answers a known
 * cold target as present), or null.
 */
export function originRefPartOf(input: ViewInputs, id: string): string | null {
  return input.links.issue.discoveredFrom(id)
}

/** The origin, when it is resident (a cold one is `loading`, `loadingPartOf`). */
export function originIdPartOf(input: ViewInputs, originRef: string | null): string | null {
  return originRef !== null && input.present('issue', originRef) ? originRef : null
}

/**
 * The ⤷ tick: a flat copy of the origin's label (spec §3 R-ORIGIN). It reads
 * the label, never the own part, so an origin crossing a deadline (its band,
 * its fold) re-derives none of its spin-offs.
 */
export function originTickPartOf(input: ViewInputs, originId: string | null): RowOriginTick | null {
  return originId === null ? null : originTickOf(originId, input.parts(originId)?.label)
}

/** The ⤷ tick of a resident origin, from its label. */
export function originTickOf(originId: string, label: Label | undefined): RowOriginTick | null {
  if (label === undefined || label.seq === undefined) return null
  return {
    id: originId,
    seq: label.seq,
    title: label.displayTitle ?? '',
    ref: label.displayRef ?? '',
  }
}

/** The own sessions (`IssueParts.sessionIds`): the maintained list, already in session-id order. */
export function sessionIdsPartOf(input: ViewInputs, id: string): readonly string[] {
  return input.seatList(id)
}

/** A session's `lastActiveAt`, epoch ms, or null (absent, empty or unparseable). */
export function activityMsOf(session: SliceSession | undefined): number | null {
  return parseMs(session?.lastActiveAt)
}

/**
 * Max `lastActiveAt` of the row's retained seats, else own `updatedAt`, else
 * 0 (`rows.ts:108-116`: `lastSession || updatedAt || 0`, so a zero stamp
 * falls back too). Not every explicit session: archived, shell and decayed
 * ones retain nothing. Re-composed from each seat's cached
 * contribution (`ViewInputs.sessionActivity`): a seat's change re-reads that
 * seat only.
 */
export function activityAtPartOf(input: ViewInputs, id: string): number {
  return activityAtOf(input, input.retainedSeats(id), () => parseMs(input.issue(id)?.updatedAt))
}

/** `activityAt` from the retained seats' cached stamps, else the own `updatedAt` (asked only then). */
export function activityAtOf(
  input: Pick<ViewInputs, 'sessionActivity'>,
  retainedSeats: readonly string[],
  updatedMs: () => number | null,
): number {
  let latest = 0
  for (const sessionId of retainedSeats) {
    const at = input.sessionActivity(sessionId)
    if (at !== null && at > latest) latest = at
  }
  return latest || updatedMs() || 0
}

/**
 * Whether any lazy input this row's parts read is still loading: the origin
 * (`issue.discoveredFrom`) and every member session (`issue.sessions`). Asks
 * about EVERY member, so all of them are queued in one window, not one per
 * window. Reads residency and the bucket, never a row.
 */
export function loadingPartOf(
  input: ViewInputs,
  originRef: string | null,
  sessionIds: readonly string[],
): boolean {
  let loading = originRef !== null && input.loading('issue', originRef)
  for (const sessionId of sessionIds) {
    if (input.loading('session', sessionId)) loading = true
  }
  return loading
}

/** The row's label: its own ref and title, and what a spin-off's origin tick copies. */
export interface Label {
  readonly displayRef: string | undefined
  readonly displayTitle: string | undefined
  /** The row's `seq`; undefined when the issue is not in memory. */
  readonly seq: number | undefined
}

/** The label of issue `id` from its in-memory row (undefined: every field undefined). */
export function labelOfRow(input: ViewInputs, id: string, issue: SliceIssue | undefined): Label {
  if (issue === undefined) return { displayRef: undefined, displayTitle: undefined, seq: undefined }
  return {
    displayRef: displayRefOf(issue.seq, prefixPartOf(input, repoTargetPartOf(input, id))),
    displayTitle: displayTitleOf(issue, () => firstMemberOf(input, sessionIdsPartOf(input, id))),
    seq: issue.seq,
  }
}

/** The parts of `id` computed directly, no memo (the rebuild). */
export function directParts(input: ViewInputs, id: string): IssueParts {
  const parts: IssueParts = {
    get own() {
      return ownPartOf(input, id)
    },
    get repoTarget() {
      return repoTargetPartOf(input, id)
    },
    get prefix() {
      return prefixPartOf(input, parts.repoTarget)
    },
    get displayRef() {
      return displayRefPartOf(parts.own, parts.prefix)
    },
    get displayTitle() {
      return displayTitlePartOf(input, id, parts.sessionIds)
    },
    get label() {
      return { displayRef: parts.displayRef, displayTitle: parts.displayTitle, seq: parts.own?.seq }
    },
    get originRef() {
      return originRefPartOf(input, id)
    },
    get originId() {
      return originIdPartOf(input, parts.originRef)
    },
    get originTick() {
      return originTickPartOf(input, parts.originId)
    },
    get sessionIds() {
      return sessionIdsPartOf(input, id)
    },
    get activityAt() {
      return activityAtPartOf(input, id)
    },
    get loading() {
      return loadingPartOf(input, parts.originRef, parts.sessionIds)
    },
  }
  return parts
}

// ------------------------------------------------------------------ the view

/** The roll-up of an issue the worklist has no node for (never a visible row). */
export const NO_ROLLUP: Rollup = {
  phase: 'queued',
  progressDone: 0,
  progressTotal: 0,
  working: false,
  asking: false,
  workingSince: null,
  loading: false,
  seatActivity: null,
}

/**
 * The row fields that combine a part with the roll-up. The live issue answers
 * each field from these (`IssueModel`, one cached value per field); the
 * rebuild's plain view below calls the same ones.
 */

/** `closed` / `dismissed`: the own part's verdict, unless something in the subtree waits (R-GROUP 3). */
export function unlessWaiting(verdict: boolean, rollup: Rollup): boolean {
  return verdict && !rollup.asking
}

/** `activityAt`: the own-row stamp, raised by the latest seat below (`rows.ts:336-339`). */
export function rowActivityAtOf(ownActivityAt: number, rollup: Rollup): number {
  const seat = rollup.seatActivity
  return seat !== null && seat > ownActivityAt ? seat : ownActivityAt
}

/** `loading`: a lazy input of the row's own parts, or of its roll-up, is not resident yet. */
export function rowLoadingOf(partsLoading: boolean, rollup: Rollup): true | undefined {
  return partsLoading || rollup.loading ? true : undefined
}

/**
 * The row view of issue `id` from its parts, as one plain object, or
 * undefined when the issue is not in the pool: the REBUILD's (the gate's
 * oracle). The live pool builds no such object: a drawn row reads the issue
 * itself, field by field. Reads no row: only `self`'s parts, its roll-up and
 * the selection.
 */
export function buildRowView(input: ViewInputs, id: string, self: IssueParts): RowView | undefined {
  const own = self.own
  if (own === undefined) return undefined
  const rollup = input.rollup(id) ?? NO_ROLLUP
  const loading = rowLoadingOf(self.loading, rollup)
  return {
    id,
    displayRef: self.displayRef ?? '',
    title: self.displayTitle ?? '',
    phase: rollup.phase,
    progressDone: rollup.progressDone,
    progressTotal: rollup.progressTotal,
    working: rollup.working,
    asking: rollup.asking,
    workingSince: rollup.workingSince,
    ...own,
    closed: unlessWaiting(own.closed, rollup),
    dismissed: unlessWaiting(own.dismissed, rollup),
    selected: input.selected(id),
    originTick: self.originTick,
    activityAt: rowActivityAtOf(self.activityAt, rollup),
    ...(loading === true ? { loading } : {}),
  }
}
