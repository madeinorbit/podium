/**
 * THE ISSUE STATUS VOCABULARY — one flat list of the states an issue can be
 * IN, projected from the two fields that actually store it.
 *
 * WHY THIS FILE EXISTS (POD-1074). The tracker stores lifecycle state in two
 * places: `stage` (the board lane) and `closedReason` (why it stopped). That
 * split is right for the store — reopening has to clear one without inventing
 * a lane for every outcome — but it is WRONG for a picker. Every status control
 * in the product had to restate the join itself, and each one restated it
 * slightly differently: the desktop offered "Close: done" / "Close: wontfix",
 * the phone offered the same two words with different hints, the sidebar's
 * folded rows spelled a third vocabulary ("won't fix"), and `closedReason` was
 * a bare `z.string()` that nothing agreed on. `wontfix` was never a state a
 * human picked on purpose; it was the only word available.
 *
 * So: ONE vocabulary of ten statuses, ONE label table, ONE canonicalization of
 * the legacy spellings, and ONE function that turns a picked status back into
 * the mutation that applies it. Surfaces render the list; they do not each
 * re-derive what the list is.
 *
 * THE WIRE STAYS TOLERANT ON PURPOSE. `closedReason` remains `z.string()` in
 * `IssueLifecycle` rather than becoming this enum. Rows closed before the
 * vocabulary existed carry `wontfix` (and, in older fixtures, words like
 * `shipped`) and MUST still parse — tightening the schema would fail the whole
 * issue over a display detail. Canonicalization therefore happens on READ, via
 * {@link canonicalIssueCloseReason}, which returns `null` for a word it does
 * not know so the caller can still show the raw string rather than lose it.
 *
 * `cancelled` IS the old `wontfix` (POD-1074): same meaning — work deliberately
 * not done — under the word the rest of the industry uses. New closes write
 * `cancelled`; stored `wontfix` reads back as `cancelled` forever.
 */

import { z } from 'zod'
import type { HumanSettableIssueStage, IssueStage } from './issue-vocabulary'

// ---------------------------------------------------------------------------
// Close reasons
// ---------------------------------------------------------------------------

/** Every terminal outcome `closedReason` may hold. */
export const ALL_ISSUE_CLOSE_REASONS = ['done', 'cancelled', 'duplicate', 'superseded'] as const
export const IssueCloseReason = z.enum(ALL_ISSUE_CLOSE_REASONS)
export type IssueCloseReason = z.infer<typeof IssueCloseReason>

/**
 * The close reasons a bare status control offers.
 *
 * `superseded` is deliberately absent: it is a RELATION outcome, not a status
 * pick — `supersede <old> <new>` needs a target issue, so it is reached from
 * the relations menu and only ever ARRIVES here as a rendered state.
 * `duplicate` is pickable (Linear does the same) because closing something as
 * a duplicate is a judgement the operator makes before they have found, or
 * care to link, the canonical issue; the "Duplicate of…" relation stays the
 * separate, stronger statement.
 */
export const PICKABLE_ISSUE_CLOSE_REASONS = [
  'done',
  'cancelled',
  'duplicate',
] as const satisfies readonly IssueCloseReason[]

/**
 * Stored spellings that predate the vocabulary, mapped to what they meant.
 *
 * `wontfix` is the whole reason this table exists — see the file header. The
 * American spelling is here because it is the one Linear ships and operators
 * type it out of habit; it is not a second state.
 */
const LEGACY_CLOSE_REASONS: Readonly<Record<string, IssueCloseReason>> = {
  wontfix: 'cancelled',
  wont_fix: 'cancelled',
  "won't fix": 'cancelled',
  'not planned': 'cancelled',
  canceled: 'cancelled',
  dupe: 'duplicate',
}

/**
 * Read a stored `closedReason` as a vocabulary member, or `null` when it is a
 * word this vocabulary does not know. Null is a real answer: the row IS closed,
 * and the caller should keep showing the raw string rather than flatten an
 * unrecognized outcome into "Done".
 */
export function canonicalIssueCloseReason(value: unknown): IssueCloseReason | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  if (!key) return null
  const legacy = LEGACY_CLOSE_REASONS[key]
  if (legacy) return legacy
  const parsed = IssueCloseReason.safeParse(key)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Statuses — stages and close reasons in one list
// ---------------------------------------------------------------------------

/**
 * Every status an issue can READ as. The open half is exactly
 * `ALL_ISSUE_STAGES` minus `done`; the terminal half is exactly
 * `ALL_ISSUE_CLOSE_REASONS`. `done` is the one member of both, which is why the
 * join collapses to a single flat list rather than a pair.
 */
export const ALL_ISSUE_STATUSES = [
  'proposed',
  'backlog',
  'planning',
  'in_progress',
  'review',
  'shipping',
  'done',
  'cancelled',
  'duplicate',
  'superseded',
] as const
export const IssueStatus = z.enum(ALL_ISSUE_STATUSES)
export type IssueStatus = z.infer<typeof IssueStatus>

/** Narrow an untyped value to the status union. */
export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && (ALL_ISSUE_STATUSES as readonly string[]).includes(value)
}

/**
 * What a status MEANS for the work, in the three buckets every surface actually
 * branches on: still moving, finished, or abandoned. This is the axis that
 * decides a glyph's colour — a green check for completed, a muted mark for
 * everything cancelled — and it is why `duplicate` and `superseded` must not
 * wear the success tick they inherited when they were "just closed".
 */
export type IssueStatusOutcome = 'open' | 'completed' | 'cancelled'

const STATUS_OUTCOME: Readonly<Record<IssueStatus, IssueStatusOutcome>> = {
  proposed: 'open',
  backlog: 'open',
  planning: 'open',
  in_progress: 'open',
  review: 'open',
  shipping: 'open',
  done: 'completed',
  cancelled: 'cancelled',
  duplicate: 'cancelled',
  superseded: 'cancelled',
}

export function issueStatusOutcome(status: IssueStatus): IssueStatusOutcome {
  return STATUS_OUTCOME[status]
}

/** Terminal = the work stopped, whichever way it stopped. */
export function isTerminalIssueStatus(status: IssueStatus): boolean {
  return STATUS_OUTCOME[status] !== 'open'
}

/**
 * ONE label table for all ten, and the only one in the product. Before
 * POD-1074 there were three near-copies (`ISSUE_STAGE_LABELS` in client-core,
 * `STAGE_LABEL` on the phone, `STAGE_LABELS` on the web) that had already
 * drifted on the casing of "In Progress". They now all derive from here.
 */
export const ISSUE_STATUS_LABELS: Readonly<Record<IssueStatus, string>> = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  shipping: 'Shipping',
  done: 'Done',
  cancelled: 'Cancelled',
  duplicate: 'Duplicate',
  superseded: 'Superseded',
}

/**
 * One line of help per terminal status, for the surfaces that have room for it
 * (the phone's action sheet, the close dialog). The open stages need none —
 * their names are the explanation.
 */
export const ISSUE_CLOSE_REASON_HINTS: Readonly<Record<IssueCloseReason, string>> = {
  done: 'The work was completed.',
  cancelled: 'Deliberately not doing this.',
  duplicate: 'Already tracked by another issue.',
  superseded: 'Replaced by a later issue.',
}

// ---------------------------------------------------------------------------
// Projection: (stage, closedReason) → status
// ---------------------------------------------------------------------------

/** The minimal row shape the status projection reads. */
export interface IssueStatusFields {
  stage: IssueStage
  closedReason?: string | null
}

/**
 * THE status of a row. A recognized close reason wins over the stage, because
 * closing always parks the row on `done` and the reason is the part that says
 * which ending it was. An UNRECOGNIZED close reason still means closed, and
 * `done` is the honest stage-level answer — use {@link issueStatusLabel} where
 * the raw word should survive.
 */
export function issueStatusOf(row: IssueStatusFields): IssueStatus {
  const reason = canonicalIssueCloseReason(row.closedReason)
  if (reason) return reason
  if (row.closedReason) return 'done'
  return row.stage
}

/**
 * The status of a row as a word to show. Identical to
 * `ISSUE_STATUS_LABELS[issueStatusOf(row)]` except for the one case that table
 * cannot answer: a close reason from outside the vocabulary, which is shown as
 * itself rather than silently relabelled "Done".
 */
export function issueStatusLabel(row: IssueStatusFields): string {
  if (row.closedReason && !canonicalIssueCloseReason(row.closedReason)) {
    const raw = row.closedReason.trim()
    return raw.charAt(0).toUpperCase() + raw.slice(1)
  }
  return ISSUE_STATUS_LABELS[issueStatusOf(row)]
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/**
 * The status list a human-facing picker offers, in reading order: the open
 * lanes, then the terminal outcomes. This is `HUMAN_SETTABLE_ISSUE_STAGES` and
 * `PICKABLE_ISSUE_CLOSE_REASONS` fused — with `done` appearing ONCE, in the
 * terminal group where it belongs, because picking Done is a close (it records
 * a reason and runs the close guard) and not a lane move.
 *
 * `proposed` and `shipping` are absent for the same reasons they are absent
 * from `HUMAN_SETTABLE_ISSUE_STAGES`: promotion has its own flow, and Shipping
 * owns its own custody.
 */
export const PICKABLE_ISSUE_STATUSES = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'duplicate',
] as const satisfies readonly IssueStatus[]

/** The open half of {@link PICKABLE_ISSUE_STATUSES} — a plain lane move. */
export const PICKABLE_OPEN_ISSUE_STATUSES = [
  'backlog',
  'planning',
  'in_progress',
  'review',
] as const satisfies readonly HumanSettableIssueStage[]

/**
 * What applying a status actually DOES. The two arms are two different
 * mutations — `update({stage})` and `close(reason)` — and every surface that
 * offered a status menu used to hard-code the fork inline, which is how
 * "Close: wontfix" ended up spelled four ways.
 */
export type IssueStatusIntent =
  | { kind: 'stage'; stage: HumanSettableIssueStage }
  | { kind: 'close'; reason: IssueCloseReason }

export function issueStatusIntent(status: IssueStatus): IssueStatusIntent | null {
  switch (status) {
    case 'backlog':
    case 'planning':
    case 'in_progress':
    case 'review':
      return { kind: 'stage', stage: status }
    case 'done':
    case 'cancelled':
    case 'duplicate':
    case 'superseded':
      return { kind: 'close', reason: status }
    // Not applicable from a status control: promotion out of `proposed` is its
    // own flow, and `shipping` custody is entered and settled only by Shipping.
    case 'proposed':
    case 'shipping':
      return null
  }
}

/**
 * The string form a menu item carries (`stage:planning`, `close:cancelled`).
 * Menus round-trip through strings; this and {@link parseIssueStatusValue} are
 * the only two places that know the encoding.
 */
export function issueStatusValue(status: IssueStatus): string {
  const intent = issueStatusIntent(status)
  if (!intent) return `stage:${status}`
  return intent.kind === 'close' ? `close:${intent.reason}` : `stage:${intent.stage}`
}

/** Parse a menu value back into the mutation it stands for. */
export function parseIssueStatusValue(value: string): IssueStatusIntent | null {
  const [kind, rest] = value.split(':', 2)
  if (!rest) return null
  if (kind === 'close') {
    const reason = canonicalIssueCloseReason(rest)
    return reason ? { kind: 'close', reason } : null
  }
  if (kind !== 'stage') return null
  return isIssueStatus(rest) ? issueStatusIntent(rest) : null
}

/** The menu value that reads as SELECTED for a row — the inverse of the pair
 *  above, so a picker can mark its current entry without restating the join. */
export function issueStatusValueOf(row: IssueStatusFields): string {
  return issueStatusValue(issueStatusOf(row))
}

/**
 * THE status menu, as data.
 *
 * Every surface that lets someone change an issue's status renders this list:
 * the desktop's right-sidebar dock, the full issue page's Status property, the
 * board's context menu and command palette, the phone's action sheet. They
 * differ in what a ROW looks like — a `DropdownMenuItem`, a `PropertyOption`, an
 * `ActionSheet` action — so what is shared is the LIST, not a component, and it
 * lives here rather than in either app.
 *
 * The shape is Linear's: one flat list, open lanes first, a rule, then the
 * terminal outcomes named as states rather than as operations. What used to read
 *
 *     Backlog · Planning · In Progress · Review · Done
 *     Close: done
 *     Close: wontfix
 *
 * now reads
 *
 *     Backlog · Planning · In Progress · Review
 *     ─────────────────────────────────────────
 *     Done · Cancelled · Duplicate
 *
 * "Close: wontfix" was two problems in one label: it leaked the mutation into
 * the noun, and `wontfix` was a value nobody chose on purpose. Both go. `Done`
 * moves BELOW the rule because picking it IS a close — it records a reason and
 * passes the close guard — and grouping it with the lane moves was why the old
 * menu needed the "Close:" prefix to explain itself at all.
 */
export interface IssueStatusMenuEntry {
  status: IssueStatus
  /** Menu value; parse with {@link parseIssueStatusValue}. */
  value: string
  label: string
  /** One line of help, for the surfaces with room (phone sheet, palette). */
  hint?: string
  /** Terminal statuses route through a close, not a bare stage patch. */
  terminal: boolean
  /** Draw a separator ABOVE this entry — true for the first terminal status. */
  startsGroup: boolean
}

export function issueStatusMenuEntries(): IssueStatusMenuEntry[] {
  let seenTerminal = false
  return PICKABLE_ISSUE_STATUSES.map((status) => {
    const reason = canonicalIssueCloseReason(status)
    const terminal = isTerminalIssueStatus(status)
    const startsGroup = terminal && !seenTerminal
    if (terminal) seenTerminal = true
    return {
      status,
      value: issueStatusValue(status),
      label: ISSUE_STATUS_LABELS[status],
      ...(reason ? { hint: ISSUE_CLOSE_REASON_HINTS[reason] } : {}),
      terminal,
      startsGroup,
    }
  })
}
