/**
 * POD-4565 (Ma1) — one issue's `RowView` (L1b, `shared/src/row-view.ts`) as a
 * pure function of its inputs.
 *
 * ONE RULE, TWO CALLERS. The live pool runs every part below in its own
 * computed on the issue model, over tracked inputs (`models.ts`, `pool.ts`);
 * the rebuild runs the same functions directly over plain maps built from the
 * feed's snapshot (`directParts`, `rebuild.ts`). Nothing here knows which: a
 * rule cannot drift between the incremental result and its own oracle.
 *
 * WHAT Ma1 DERIVES (inputs per L1b):
 * - own row: `title` (non-draft), `band`, `repoKey`, `pinned`, `sortKey`,
 *   `createdAt`, `seq`, `foldAt`;
 * - one hop through a declared single-valued relation, resolved by the
 *   relation engine (`inputs.relations.one`, `relations.ts`; the rebuild's
 *   from-scratch scan in the rebuild): `displayRef` (`issue.repo` prefix)
 *   and `originTick` (`issue.discoveredFrom`). No view resolves a relation
 *   itself (M3 F2);
 * - locals: `selected` (selection), and the clock through deadlines
 *   (`band`'s defer lapse, `closed`'s grace crossing);
 * - residency (POD-4567): `loading` while the origin or a member session is
 *   known but not in memory. The parts that read them skip a row that is not
 *   resident, so their value is provisional exactly while `loading` is set.
 *
 * THE ROLL-UPS (POD-4571, Mb3, `worklist/rollup.ts`): `phase`,
 * `progressDone`, `progressTotal`, `working`, `asking` and `workingSince`
 * come from the issue's worklist node (`ViewInputs.rollup`), a composition
 * over its own seats and its children's cached results; `closed`'s "zero
 * waiting" conjunct is the roll-up's `asking`, applied here over the own
 * part's settled verdict. Fields that read own
 * sessions (`activityAt`, the draft title) read `issue.sessions` once
 * (`sessionIds`) through the relation accessor, maintained by the pool from the schema
 * (`relations.ts`, POD-4566): explicit members, resume twins collapsed. The
 * bucket is unordered; `sessionIds` sorts it by session id (the order is the
 * view's, M3 F1).
 *
 * Rules are re-expressed from the frozen slice spec
 * (`docs/plans/pod-4441-round-two-slice.md` §3, cited per rule); round two's
 * `arms/mobx/rules.ts` transcribed the same sections and passed parity. No
 * legacy view-model import.
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import type { RowOriginTick, RowView } from '../../../shared/src/row-view'
import type { EntityName } from '../../../shared/src/schema'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'
import type { Rollup } from './worklist/rollup'

/** The finished-row grace before the closed fold (spec §3 R-GROUP). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** The defer sentinel that never returns on its own (spec §3 R-ORDER). */
export const DEFER_NEXT_MESSAGE = 'next-message'
/** A draft's placeholder title (spec §3 R-SUM). */
export const DRAFT_TITLE = 'Draft'

/** A repo row as the feed spells it (a root lane, or the raw replicated row). */
export interface RepoRow {
  readonly prefix?: string | null
}

/**
 * One issue's derived parts. Each is its own memo in the live pool (a
 * computed on the issue model), so a change re-runs only the parts that read
 * it, and a part whose value did not move stops the propagation there.
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
   * collapsed, session-id order). One bucket read, cached: a member's change
   * does not re-read the bucket, and the parts below walk this array, never
   * the relation, so they touch no member row they do not need.
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
  readonly relations: RelationReader
  issue(id: string): SliceIssue | undefined
  session(id: string): SliceSession | undefined
  /**
   * A member session's own-row part (`sessionActivityOf`): a computed on the
   * session model in the live pool, so a parent re-composing its roll-up
   * reads each unchanged member's cached value, not its row (POD-4568; the
   * harness's "re-compose from cached child results"). Direct in the rebuild.
   */
  sessionActivity(id: string): number | null
  repo(id: string): RepoRow | undefined
  /** Whether a row of `entity` is in the pool (tracks presence only). */
  present(entity: EntityName, id: string): boolean
  /**
   * Whether a row of `entity` is known but not resident (POD-4567): the live
   * pool queues its load. Always false where every row is held (the rebuild).
   */
  loading(entity: EntityName, id: string): boolean
  /** Another issue's parts (the origin of a spin-off). */
  parts(id: string): IssueParts | undefined
  /** The issue's roll-up fields (Mb3: its worklist node's `rollup`); undefined when unknown. */
  rollup(id: string): Rollup | undefined
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

// ------------------------------------------------------------------- parts

/** The row-only fields of issue `id` (spec §3 R-ORDER, R-GROUP). */
export function ownPartOf(input: ViewInputs, id: string): OwnPart | undefined {
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
}

function firstMemberOf(input: ViewInputs, sessionIds: readonly string[]): SliceSession | undefined {
  for (const sessionId of sessionIds) {
    const session = input.session(sessionId)
    if (session !== undefined) return session
  }
  return undefined
}

/** `issue.repo` through the engine (declared in the schema): the repo's id, or null. */
export function repoTargetPartOf(input: ViewInputs, id: string): string | null {
  return input.relations.one('issue', id, 'repo')
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
  return input.relations.one('issue', id, 'discoveredFrom')
}

/** The origin, when it is resident (a cold one is `loading`, `loadingPartOf`). */
export function originIdPartOf(input: ViewInputs, originRef: string | null): string | null {
  return originRef !== null && input.present('issue', originRef) ? originRef : null
}

/** The ⤷ tick: a flat copy of the origin's parts (spec §3 R-ORIGIN). */
export function originTickPartOf(input: ViewInputs, originId: string | null): RowOriginTick | null {
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
}

/**
 * The own sessions, one bucket read (`IssueParts.sessionIds`), in session-id
 * order: the bucket is unordered, and the draft title's "first member" needs
 * one.
 */
export function sessionIdsPartOf(input: ViewInputs, id: string): readonly string[] {
  return [...input.relations.many('issue', id, 'sessions')].sort()
}

/** A session's contribution to its issue's activity: its `lastActiveAt`, or null when absent. */
export function sessionActivityOf(session: SliceSession | undefined): number | null {
  return parseMs(session?.lastActiveAt)
}

/**
 * Max `lastActiveAt` of own sessions, else own `updatedAt`, else 0 (spec
 * R-BAND). Re-composed from each member's cached contribution
 * (`ViewInputs.sessionActivity`): a member's change re-reads that member only.
 */
export function activityAtPartOf(
  input: ViewInputs,
  id: string,
  sessionIds: readonly string[],
): number {
  let latest: number | null = null
  for (const sessionId of sessionIds) {
    const at = input.sessionActivity(sessionId)
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest ?? parseMs(input.issue(id)?.updatedAt) ?? 0
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
      return activityAtPartOf(input, id, parts.sessionIds)
    },
    get loading() {
      return loadingPartOf(input, parts.originRef, parts.sessionIds)
    },
  }
  return parts
}

// ------------------------------------------------------------------ the view

/** The roll-up of an issue the worklist has no node for (never a visible row). */
const NO_ROLLUP: Rollup = {
  phase: 'queued',
  progressDone: 0,
  progressTotal: 0,
  working: false,
  asking: false,
  workingSince: null,
  loading: false,
}

/**
 * The row view of issue `id` from its parts, or undefined when the issue is
 * not in the pool. Reads no row: only `self`'s parts, its roll-up and the
 * selection.
 */
export function buildRowView(input: ViewInputs, id: string, self: IssueParts): RowView | undefined {
  const own = self.own
  if (own === undefined) return undefined
  const { loading, ...rollup } = input.rollup(id) ?? NO_ROLLUP
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
    activityAt: self.activityAt,
    ...(self.loading || loading ? { loading: true as const } : {}),
  }
}
