/**
 * POD-4578 (Ha1) — one issue's `RowView` (L1b, `shared/src/row-view.ts`) as
 * pure functions of declared inputs.
 *
 * ONE RULE TABLE, TWO CALLERS. `PART_RULES` names every part of a row view
 * once. The live pool runs each part in its own cell (`pool.ts`
 * `IssueCells`), over tracked inputs; the rebuild runs the same functions
 * directly over plain maps built from the feed's snapshot (`directParts`,
 * `rebuild.ts`). Nothing here knows which, so a rule cannot drift between the
 * incremental result and its own oracle, and no part list is written twice.
 *
 * WHY PARTS. A cell re-runs when something it read changed, so what a part
 * reads is what a change costs. Each single-valued relation is its own part
 * (`repoId`, `originId`), read through the relation accessor (`relations.one`:
 * the engine's forward slot plus the target's presence), never resolved from
 * the own row (M3 F2): a rename moves no relation slot, so it re-runs neither;
 * the target's fields are read by the next part (`prefix`, `originTick`). An
 * origin's rename re-runs only its spin-offs' `originTick`, which reads the
 * origin's parts, never its row. `view` assembles the parts and reads no row.
 *
 * WHAT a1 DERIVES (inputs per L1b):
 * - own row: `title` (non-draft), `band`, `repoKey`, `pinned`, `sortKey`,
 *   `createdAt`, `seq`, `foldAt`, `dismissed`;
 * - one hop through a declared relation (`relations.ts`): `displayRef`
 *   (`issue.repo`'s prefix), `originTick` (`issue.discoveredFrom`), and the
 *   own explicit sessions (`issue.sessions`, read once into `sessionIds`) for
 *   a draft's title; `activityAt` takes the stamps of the row's retained
 *   seats (Hb3: `retainedSeats`, the visibility's retained list, exited ones
 *   included), raised by the latest seat below (the roll-up's `seatActivity`);
 * - locals: `selected`, and the clock through deadlines (`band`'s defer
 *   lapse, `closed`'s grace crossing).
 * - residency (POD-4580, Ha3): `loading` while the origin or a member session
 *   is known but not resident (`ViewInputs.loading` queues it). `originTick`,
 *   `activityAt` and a draft's title read only resident rows, so they are
 *   provisional exactly while `loading` is set; the row renders that, never
 *   the half-built value as data. The rebuild holds every row: never loading.
 *
 * THE ROLL-UPS (POD-4584, Hb3, `worklist/rollup.ts`): `phase`,
 * `progressDone`, `progressTotal`, `working`, `asking` and `workingSince`
 * come from the issue's roll-up parts, a composition over its own seats and
 * its children's cached results; `closed`'s "zero waiting" conjunct is the
 * roll-up's `asking`, applied here over the own part's settled verdict, and
 * `activityAt` is the own-row stamp raised by the roll-up's `seatActivity`.
 * A draft's title reads the explicit sessions (`issue.sessions`, maintained
 * since Ha2, POD-4579).
 *
 * Rules are re-expressed from the frozen slice spec
 * (`docs/plans/pod-4441-round-two-slice.md` §3, cited per rule). No legacy
 * view-model import, and nothing from round two's `arms/hand` (the lint's
 * import fence).
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import { isDraftNameSession, type RowOriginTick, type RowView } from '@podium/client-graph/shared/row-view'
import type { EntityName } from '@podium/client-graph/shared/schema'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { bundledDescriptorFor } from '@podium/harness/browser'
// Single-home (POD-5614): the defer sentinel lives in @podium/model.
import { DEFER_NEXT_MESSAGE } from '@podium/model'
import type { Rollup } from './worklist/rollup'

/** The finished-row grace before the closed fold (spec §3 R-GROUP). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** A draft's placeholder title (spec §3 R-SUM). */
export const DRAFT_TITLE = 'Draft'

/** The roll-up of an issue the worklist has no node for (never a visible row). */
const NO_ROLLUP: Rollup = {
  phase: 'queued',
  progressDone: 0,
  progressTotal: 0,
  working: false,
  asking: false,
  workingSince: null,
  loading: false,
  seatActivity: null,
}

/** A repo row as the feed spells it (a lane, or the raw replicated row). */
export interface RepoRow {
  readonly prefix?: string | null
}

/** The fields a row view takes from its own row (and the clock). */
export interface OwnPart {
  readonly band: 0 | 1 | 2
  readonly repoKey: string
  readonly closed: boolean
  readonly dismissed: boolean
  readonly pinned: boolean
  readonly sortKey: string | null
  readonly createdAt: string
  readonly seq: number
  readonly foldAt: string
}

/** One issue's derived parts; each is a cell in the live pool. */
export interface IssueParts {
  /** The row-only fields; undefined when the issue is not in the pool. */
  readonly own: OwnPart | undefined
  readonly repoId: string | null
  readonly prefix: string | null
  readonly displayRef: string | undefined
  readonly displayTitle: string | undefined
  /**
   * `issue.discoveredFrom` through the engine: a KNOWN origin (in the live
   * pool it may be cold), or null. The loading check reads this.
   */
  readonly originRef: string | null
  /** The origin when it is resident. */
  readonly originId: string | null
  readonly originTick: RowOriginTick | null
  /**
   * The own explicit sessions (`issue.sessions`), lowest id first: the one
   * reader of the bucket. Re-runs only when the bucket moves, so a member's
   * own change never re-walks its siblings (POD-4581).
   */
  readonly sessionIds: readonly string[]
  readonly activityAt: number
  /** A lazy input (the origin, a member session) is known but not resident yet. */
  readonly loading: boolean
}

export type PartName = keyof IssueParts

/** Everything a part reads. Tracked in the live pool; plain in the rebuild. */
export interface ViewInputs {
  readonly relations: RelationReader
  issue(id: string): SliceIssue | undefined
  session(id: string): SliceSession | undefined
  repo(id: string): RepoRow | undefined
  /**
   * One session's contribution to its issue's `activityAt`
   * ({@link sessionActivityOf} over its row). The live pool caches it per
   * session (a cell), so a roll-up re-composes from its members' cached
   * values and re-reads only the member that changed; the rebuild computes it
   * directly.
   */
  sessionActivity(id: string): number | null
  /** Whether a row of `entity` is in the pool (its slot only). */
  present(entity: EntityName, id: string): boolean
  /**
   * Whether a row of `entity` is known but not resident (POD-4580): the live
   * pool queues its load. Always false where every row is held (the rebuild).
   */
  loading(entity: EntityName, id: string): boolean
  /** Another issue's parts (the origin of a spin-off); undefined when absent. */
  parts(id: string): IssueParts | undefined
  /** The issue's roll-up fields (Hb3: its roll-up node's `rollup`); undefined when unknown. */
  rollup(id: string): Rollup | undefined
  /**
   * The row's retained seats (the visibility `retainedSeatIds`: seat members
   * retained at the clock, exited ones included), whose stamps the own-row
   * `activityAt` takes (`rows.ts:98-116`). Re-composed from each seat's
   * cached contribution, so a seat's change re-reads that seat only.
   */
  retainedSeats(id: string): readonly string[]
  /**
   * POD-4708 (plant/old) — the explicit seats as the mirror IS the relation:
   * every yielded id counts, exactly as `many()` yields do.
   * `[...seats].sort()` re-reads the whole family and must FAIL #10.
   * Optional (the lean arm builds these inputs without it).
   */
  seats?(id: string): Iterable<string>
  /**
   * POD-4708 (O(1) real) — the maintained SORTED seat list itself, returned
   * without iterating it. `sessionIds` reads it, never `seats()` nor `many()`.
   * Optional (the lean arm falls back to the re-list).
   */
  seatList?(id: string): readonly string[]
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

/** Draft-session label (POD-5614): the adapter descriptor's short label read
 * from the bundled descriptors — never a second displayName table (POD-4538).
 * `shell` is not a harness, so its product copy stays local. */
function panelLabelOf(kind: string): string {
  if (kind === 'shell') return 'Shell'
  return bundledDescriptorFor(kind)?.shortLabel ?? kind
}

/**
 * A draft wears its first member's label; everything else its own title (spec
 * §3 R-SUM). The member is asked for only on a draft, so a non-draft's title
 * reads no relation.
 */
export function displayTitleOf(
  issue: SliceIssue,
  firstMemberOf: () => SliceSession | undefined,
): string {
  const title = issue.title.trim()
  if (issue.isDraftVessel !== true || (title !== '' && title !== DRAFT_TITLE)) return issue.title
  const firstMember = firstMemberOf()
  if (firstMember === undefined) return 'New agent'
  const kind = firstMember.agentKind ?? 'undefined'
  return `New ${panelLabelOf(kind)} session`
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

/** Abandoned: closed as cancelled, duplicate or superseded (spec §3 R-GROUP). */
export function issueAbandoned(issue: SliceIssue): boolean {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

/** Closed top-level human issue: a fold candidate (spec §3 R-GROUP). */
export function isClosedTopLevel(issue: SliceIssue): boolean {
  return (
    issue.closedReason != null && (issue.parentId ?? null) === null && issue.audience === 'human'
  )
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
  if (!isClosedTopLevel(issue) || issue.needsHuman === true || waiting) return false
  if (issueAbandoned(issue)) return true
  if (issue.tuckedAt != null) return true
  const finishedAt = parseMs(issue.closedAt ?? issue.updatedAt) ?? 0
  return input.passed(finishedAt + FINISHED_GRACE_MS)
}

/** Closed-fold sort stamp: `tuckedAt ?? closedAt ?? updatedAt` (spec §3 R-GROUP). */
export function foldAtOf(issue: SliceIssue): string {
  return issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt
}

/** A session's `lastActiveAt` in ms; null when it is absent (or cold) or never active. */
export function sessionActivityOf(session: SliceSession | undefined): number | null {
  return parseMs(session?.lastActiveAt)
}

// ------------------------------------------------------------------- parts

type PartRule<K extends PartName> = (
  input: ViewInputs,
  id: string,
  self: IssueParts,
) => IssueParts[K]

/**
 * Every part of a row view, once. `self` is the same issue's parts (a cell
 * reading another part of its own row reads that part's cell).
 */
export const PART_RULES: { readonly [K in PartName]: PartRule<K> } = {
  /** The row-only fields of issue `id` (spec §3 R-ORDER, R-GROUP). */
  own(input, id) {
    const issue = input.issue(id)
    if (issue === undefined) return undefined
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
  },
  /** The issue's repo (`issue.repo`), when it is in the pool. */
  repoId(input, id) {
    return input.relations.one('issue', id, 'repo')
  },
  /** The resolved repo's prefix (one hop), or null. */
  prefix(input, _id, self) {
    const repoId = self.repoId
    return repoId === null ? null : (input.repo(repoId)?.prefix ?? null)
  },
  /** `prefix-seq`, else `#seq` (spec §3 R-SUM). */
  displayRef(_input, _id, self) {
    const own = self.own
    return own === undefined ? undefined : displayRefOf(own.seq, self.prefix)
  },
  /**
   * A draft wears its first member's label: the lowest session id the shared
   * draft-name rule admits (`isDraftNameSession`: legacy `draftIssueLabel`
   * over `sessionsForIssueNav`). A bucket has no order (`relations.ts`), and
   * the legacy runtime's is replica order, which no pool has; the lowest id
   * is the MobX pool's answer too. Only a draft asks for the member.
   */
  displayTitle(input, id, self) {
    const issue = input.issue(id)
    if (issue === undefined) return undefined
    return displayTitleOf(issue, () => {
      for (const sessionId of self.sessionIds) {
        const session = input.session(sessionId)
        if (!isDraftNameSession(session)) continue
        return session
      }
      return undefined
    })
  },
  /** The spin-off's origin (`issue.discoveredFrom`) when it is known, resident or cold. */
  originRef(input, id) {
    return input.relations.one('issue', id, 'discoveredFrom')
  },
  /** The origin when it is resident (a cold one is `loading`). */
  originId(input, _id, self) {
    const originRef = self.originRef
    return originRef !== null && input.present('issue', originRef) ? originRef : null
  },
  /** The ⤷ tick: a flat copy of the origin's parts (spec §3 R-ORIGIN). */
  originTick(input, _id, self) {
    const originId = self.originId
    if (originId === null) return null
    const origin = input.parts(originId)
    const own = origin?.own
    if (origin === undefined || own === undefined) return null
    return {
      id: originId,
      seq: own.seq,
      title: origin.displayTitle ?? '',
      ref: origin.displayRef ?? '',
    }
  },
  /** `issue.sessions`, sorted: the order a draft's title needs, applied at view time. */
  sessionIds(input, id) {
    // POD-4708 (O(1) real): the maintained SORTED list itself, returned
    // without iterating it. Never `seats()` (fenced, plant/old) nor `many()`.
    // The lean arm falls back to the re-list.
    return input.seatList?.(id) ?? [...input.relations.many('issue', id, 'sessions')].sort()
  },
  /**
   * Max `lastActiveAt` of the row's retained seats, else own `updatedAt`,
   * else 0 (`rows.ts:108-116`: `lastSession || updatedAt || 0`, so a zero
   * stamp falls back too). Not every explicit session: archived, shell and
   * decayed ones retain nothing. Re-composed from each seat's cached
   * contribution (`sessionActivity`) over the cached seat list: a member's
   * change re-reads that member only.
   */
  activityAt(input, id) {
    let latest = 0
    for (const sessionId of input.retainedSeats(id)) {
      const at = input.sessionActivity(sessionId)
      if (at !== null && at > latest) latest = at
    }
    return latest || parseMs(input.issue(id)?.updatedAt) || 0
  },
  /**
   * Whether a lazy input the parts read is still loading: the origin and
   * every member session. Asks about EVERY member, so all of them are queued
   * in one window, not one per window. Reads residency and `sessionIds`,
   * never a row.
   */
  loading(input, _id, self) {
    const originRef = self.originRef
    let loading = originRef !== null && input.loading('issue', originRef)
    for (const sessionId of self.sessionIds) {
      if (input.loading('session', sessionId)) loading = true
    }
    return loading
  },
}

export const PART_NAMES: readonly PartName[] = Object.freeze(Object.keys(PART_RULES) as PartName[])

/** The parts of `id` computed directly, no memo (the rebuild). */
export function directParts(input: ViewInputs, id: string): IssueParts {
  const parts = {} as IssueParts
  for (const name of PART_NAMES) {
    Object.defineProperty(parts, name, {
      enumerable: true,
      get: () => PART_RULES[name](input, id, parts),
    })
  }
  return parts
}

// ------------------------------------------------------------------ the view

/**
 * The row view of issue `id` from its parts, or undefined when the issue is
 * not in the pool. Reads no row: only `self`'s parts, its roll-up and the
 * selection.
 */
export function buildRowView(input: ViewInputs, id: string, self: IssueParts): RowView | undefined {
  const own = self.own
  if (own === undefined) return undefined
  const { loading, seatActivity, ...rollup } = input.rollup(id) ?? NO_ROLLUP
  const waiting = rollup.asking
  return {
    id,
    displayRef: self.displayRef ?? '',
    title: self.displayTitle ?? '',
    ...rollup,
    ...own,
    closed: own.closed && !waiting,
    dismissed: own.dismissed && !waiting,
    selected: input.selected(id),
    originTick: self.originTick,
    // The own-row stamp, raised by the latest seat below (`rows.ts:336-339`).
    activityAt:
      seatActivity !== null && seatActivity > self.activityAt ? seatActivity : self.activityAt,
    ...(self.loading || loading ? { loading: true as const } : {}),
  }
}
