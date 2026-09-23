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
 *   `activityAt` (from each member's cached `sessionActivity`) and a draft's
 *   title;
 * - locals: `selected`, and the clock through deadlines (`band`'s defer
 *   lapse, `closed`'s grace crossing).
 * - residency (POD-4580, Ha3): `loading` while the origin or a member session
 *   is known but not resident (`ViewInputs.loading` queues it). `originTick`,
 *   `activityAt` and a draft's title read only resident rows, so they are
 *   provisional exactly while `loading` is set; the row renders that, never
 *   the half-built value as data. The rebuild holds every row: never loading.
 *
 * STUBS UNTIL THE WORKLIST PHASE. The roll-ups over own sessions and
 * children — `phase`, `progressDone`, `progressTotal`, `working`, `asking`,
 * `workingSince` — are Hb3 (POD-4584), and `closed`'s "zero waiting"
 * conjunct reads them (`STUB_WAITING`). Sessions owned by containment
 * (`issue.worktree` → `worktree.sessions`, slice §2 R3) join the own sessions
 * in the worklist phase; `activityAt` and a draft's title read the explicit
 * ones (`issue.sessions`, maintained since Ha2, POD-4579).
 *
 * Rules are re-expressed from the frozen slice spec
 * (`docs/plans/pod-4441-round-two-slice.md` §3, cited per rule). No legacy
 * view-model import, and nothing from round two's `arms/hand` (the lint's
 * import fence).
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import type { RowOriginTick, RowView } from '../../../shared/src/row-view'
import type { EntityName } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'

/** The finished-row grace before the closed fold (spec §3 R-GROUP). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** The defer sentinel that never returns on its own (spec §3 R-ORDER). */
export const DEFER_NEXT_MESSAGE = 'next-message'
/** A draft's placeholder title (spec §3 R-SUM). */
export const DRAFT_TITLE = 'Draft'

/** Until Hb3: the roll-ups this phase does not derive. */
export const STUB_ROLLUPS = {
  phase: 'queued',
  progressDone: 0,
  progressTotal: 0,
  working: false,
  asking: false,
  workingSince: null,
} as const satisfies Pick<
  RowView,
  'phase' | 'progressDone' | 'progressTotal' | 'working' | 'asking' | 'workingSince'
>

/** Until Hb3: "nothing in the subtree waits on the human" (a roll-up). */
export const STUB_WAITING = false

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

const PANEL_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'Pi',
  shell: 'Shell',
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
  if (issue.draft !== true || (title !== '' && title !== DRAFT_TITLE)) return issue.title
  const firstMember = firstMemberOf()
  if (firstMember === undefined) return 'New agent'
  const kind = firstMember.agentKind ?? 'undefined'
  return `New ${PANEL_LABELS[kind] ?? kind} session`
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
    const closed = closedOf(issue, STUB_WAITING, input)
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
   * A draft wears its first member's label: the lowest session id (`sessionIds`).
   * A bucket has no order (`relations.ts`), and the legacy runtime's is
   * replica order, which no pool has; the lowest id is the MobX pool's answer
   * too. Only a draft asks for the member.
   */
  displayTitle(input, id, self) {
    const issue = input.issue(id)
    if (issue === undefined) return undefined
    return displayTitleOf(issue, () => {
      const first = self.sessionIds[0]
      return first === undefined ? undefined : input.session(first)
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
    return [...input.relations.many('issue', id, 'sessions')].sort()
  },
  /**
   * Max `lastActiveAt` of own sessions, else own `updatedAt`, else 0 (spec
   * R-BAND). Re-composed from each member's cached contribution
   * (`sessionActivity`) over the cached member list: a member's change
   * re-reads that member only (POD-4581, the #2 fence).
   */
  activityAt(input, id, self) {
    let latest: number | null = null
    for (const sessionId of self.sessionIds) {
      const at = input.sessionActivity(sessionId)
      if (at !== null && (latest === null || at > latest)) latest = at
    }
    return latest ?? parseMs(input.issue(id)?.updatedAt) ?? 0
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
 * not in the pool. Reads no row: only `self`'s parts and the selection.
 */
export function buildRowView(input: ViewInputs, id: string, self: IssueParts): RowView | undefined {
  const own = self.own
  if (own === undefined) return undefined
  return {
    id,
    displayRef: self.displayRef ?? '',
    title: self.displayTitle ?? '',
    ...STUB_ROLLUPS,
    ...own,
    selected: input.selected(id),
    originTick: self.originTick,
    activityAt: self.activityAt,
    ...(self.loading ? { loading: true as const } : {}),
  }
}
