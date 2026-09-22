/**
 * POD-4565 (Ma1) — one issue's `RowView` (L1b, `shared/src/row-view.ts`) as a
 * pure function of its inputs.
 *
 * ONE RULE, TWO CALLERS. The live pool calls `buildRowView` from each issue
 * model's `view` computed with tracked inputs (`pool.ts`); the rebuild calls
 * it with plain maps built from the feed's snapshot (`rebuild.ts`). Nothing
 * here knows which: a rule cannot drift between the incremental result and
 * its own oracle.
 *
 * WHAT Ma1 DERIVES (inputs per L1b):
 * - own row: `title` (non-draft), `band`, `repoKey`, `pinned`, `sortKey`,
 *   `createdAt`, `seq`, `foldAt`;
 * - one hop through a declared single-valued relation (`relations.ts`):
 *   `displayRef` (`issue.repo` prefix) and `originTick`
 *   (`issue.discoveredFrom`);
 * - locals: `selected` (selection), and the clock through deadlines
 *   (`band`'s defer lapse, `closed`'s grace crossing).
 *
 * WHAT IS A STUB UNTIL THE WORKLIST PHASE, and why: the roll-ups over own
 * sessions and children — `phase`, `progressDone`, `progressTotal`,
 * `working`, `asking`, `workingSince` — are Mb3 (POD-4571), and `closed`'s
 * "zero waiting" conjunct reads them (`STUB_WAITING`). Fields that read own
 * sessions directly (`activityAt`, the draft title) read `issue.sessions`
 * through the relation accessor, which answers "none" until Ma2
 * (POD-4566), so they are the rule applied to an empty member set.
 *
 * Rules are re-expressed from the frozen slice spec
 * (`docs/plans/pod-4441-round-two-slice.md` §3, cited per rule); round two's
 * `arms/mobx/rules.ts` transcribed the same sections and passed parity. No
 * legacy view-model import.
 */

import type { RelationReader } from '../../../shared/src/instrument/reads'
import type { RowOriginTick, RowView } from '../../../shared/src/row-view'
import type { SliceIssue, SliceSession } from '../../../shared/src/slice-types'

/** The finished-row grace before the closed fold (spec §3 R-GROUP). */
export const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** The defer sentinel that never returns on its own (spec §3 R-ORDER). */
export const DEFER_NEXT_MESSAGE = 'next-message'
/** A draft's placeholder title (spec §3 R-SUM). */
export const DRAFT_TITLE = 'Draft'

/** Until Mb3: the roll-ups this phase does not derive. */
export const STUB_ROLLUPS = {
  phase: 'queued',
  progressDone: 0,
  progressTotal: 0,
  working: false,
  asking: false,
  workingSince: null,
} as const satisfies Pick<RowView, 'phase' | 'progressDone' | 'progressTotal' | 'working' | 'asking' | 'workingSince'>

/** Until Mb3: "nothing in the subtree waits on the human" (a roll-up). */
export const STUB_WAITING = false

/** A repo row as the feed spells it (a root lane, or the raw replicated row). */
export interface RepoRow {
  readonly prefix?: string | null
}

/** Everything a row view reads. Tracked in the live pool; plain in the rebuild. */
export interface ViewInputs {
  readonly relations: RelationReader
  issue(id: string): SliceIssue | undefined
  session(id: string): SliceSession | undefined
  repo(id: string): RepoRow | undefined
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

/** A draft wears its first member's label; everything else its own title (spec §3 R-SUM). */
export function displayTitleOf(issue: SliceIssue, firstMember: SliceSession | undefined): string {
  const title = issue.title.trim()
  if (issue.draft !== true || (title !== '' && title !== DRAFT_TITLE)) return issue.title
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
  return key === 'done' || key === 'cancelled' || key === 'duplicate' || key === 'superseded' ? key : null
}

/** Abandoned: closed as cancelled, duplicate or superseded (spec §3 R-GROUP). */
export function issueAbandoned(issue: SliceIssue): boolean {
  const reason = canonicalCloseReason(issue.closedReason)
  const status = reason ?? (issue.closedReason ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

/** Closed top-level human issue: a fold candidate (spec §3 R-GROUP). */
export function isClosedTopLevel(issue: SliceIssue): boolean {
  return issue.closedReason != null && (issue.parentId ?? null) === null && issue.audience === 'human'
}

/**
 * In its group's closed fold, with no selection (spec §3 R-GROUP, L1b
 * `closed`): a settled closure (closed top-level, no `needsHuman`, not
 * awaiting merge — never true in the slice — and nothing waiting) folds at
 * once when abandoned or tucked, else once the clock passes the 24 h grace.
 */
export function closedOf(issue: SliceIssue, waiting: boolean, input: Pick<ViewInputs, 'passed'>): boolean {
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

// ------------------------------------------------------------ one-hop rules

function firstMemberOf(input: ViewInputs, id: string): SliceSession | undefined {
  for (const sessionId of input.relations.many('issue', id, 'sessions')) {
    const session = input.session(sessionId)
    if (session !== undefined) return session
  }
  return undefined
}

function prefixOf(input: ViewInputs, id: string): string | null | undefined {
  const repoId = input.relations.one('issue', id, 'repo')
  return repoId === null ? null : input.repo(repoId)?.prefix
}

function originTickOf(input: ViewInputs, id: string): RowOriginTick | null {
  const originId = input.relations.one('issue', id, 'discoveredFrom')
  if (originId === null) return null
  const origin = input.issue(originId)
  if (origin === undefined) return null
  return {
    id: originId,
    seq: origin.seq,
    title: displayTitleOf(origin, firstMemberOf(input, originId)),
    ref: displayRefOf(origin.seq, prefixOf(input, originId)),
  }
}

/** Max `lastActiveAt` of own sessions, else own `updatedAt`, else 0 (spec R-BAND). */
function activityAtOf(input: ViewInputs, id: string, issue: SliceIssue): number {
  let latest: number | null = null
  for (const sessionId of input.relations.many('issue', id, 'sessions')) {
    const at = parseMs(input.session(sessionId)?.lastActiveAt)
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest ?? parseMs(issue.updatedAt) ?? 0
}

// ------------------------------------------------------------------ the view

/** The row view of issue `id`, or undefined when the issue is not in the pool. */
export function buildRowView(input: ViewInputs, id: string): RowView | undefined {
  const issue = input.issue(id)
  if (issue === undefined) return undefined
  const closed = closedOf(issue, STUB_WAITING, input)
  return {
    id,
    displayRef: displayRefOf(issue.seq, prefixOf(input, id)),
    title: displayTitleOf(issue, firstMemberOf(input, id)),
    ...STUB_ROLLUPS,
    band: bandOf(issue, input),
    repoKey: issue.repoId ?? issue.repoPath,
    closed,
    selected: input.selected(id),
    originTick: originTickOf(input, id),
    activityAt: activityAtOf(input, id, issue),
    pinned: issue.pinned === true,
    sortKey: issue.sortKey ?? null,
    createdAt: issue.createdAt,
    seq: issue.seq,
    foldAt: foldAtOf(issue),
    dismissed: closed && (issueAbandoned(issue) || issue.tuckedAt != null),
  }
}
