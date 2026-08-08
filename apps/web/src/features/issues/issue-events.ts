import type { IssueStage } from '@podium/model'
import { STAGE_LABELS } from './issue-card'

/**
 * One row from the server's issue event log — the shape returned by the
 * `issues.events` tRPC route (`SessionStore.listEventsSince`). `subject` is the
 * issue id the event belongs to; `payload` is the kind-specific detail bag.
 */
export interface IssueEvent {
  id: number
  ts: string
  kind: string
  subject: string
  repoPath: string | null
  payload: unknown
}

/** Stable glyph keys IssuePage maps to lucide icons — kept as data (not JSX) so
 *  the formatter stays pure and unit-testable. */
export type IssueEventIcon =
  | 'created'
  | 'moved'
  | 'closed'
  | 'started'
  | 'attached'
  | 'cleaned'
  | 'flagged'
  | 'cleared'
  | 'ready'
  | 'integration'
  | 'generic'

/** A rendered activity line for a state-transition event. */
export interface IssueEventLine {
  icon: IssueEventIcon
  text: string
  /**
   * True for a line that records no decision — an unrecognised kind rendered
   * through the generic de-prefixed fallback below. These arrive in floods (an
   * agent's `issue.read` ticks land dozens at a time), so the feed ROLLS RUNS OF
   * THEM into one expandable line rather than listing each. Known transitions
   * never carry the flag: every one of them is a thing a human decided or a
   * thing that changed the issue's state.
   */
  minor?: boolean
}

// Pure UI-sync bookkeeping events (agent panel/state publishes) fire on nearly
// every mutation — they are churn, not user-meaningful transitions, so the feed
// hides them rather than drowning real activity.
const HIDDEN_KINDS = new Set(['issue.state', 'issue.panel'])

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/** "issue.pinned" → "pinned"; "issue.snoozed_until" → "snoozed until". */
function humanizeKind(kind: string): string {
  return kind.replace(/^issue\./, '').replace(/_/g, ' ')
}

/**
 * Map a raw issue event to a concise human-readable activity line, or `null` to
 * hide it. Known transition kinds get a tailored line + glyph; unknown kinds
 * (e.g. the `issue.pinned` / `issue.snoozed` / `issue.archived` kinds slice S2
 * adds) fall through to a generic de-prefixed label, so the feed never blocks on
 * event types that don't exist yet.
 */
export function formatIssueEvent(event: IssueEvent): IssueEventLine | null {
  if (HIDDEN_KINDS.has(event.kind)) return null
  const p = asRecord(event.payload)
  switch (event.kind) {
    case 'issue.created':
      return { icon: 'created', text: 'created' }
    case 'issue.stage_changed': {
      const to = typeof p.to === 'string' ? p.to : undefined
      const label =
        to && to in STAGE_LABELS ? STAGE_LABELS[to as IssueStage] : (to ?? 'a new stage')
      return { icon: 'moved', text: `moved to ${label}` }
    }
    case 'issue.closed': {
      const reason = typeof p.reason === 'string' ? p.reason : 'done'
      return { icon: 'closed', text: `closed (${reason})` }
    }
    case 'issue.started':
      return { icon: 'started', text: 'agent started' }
    case 'issue.session_attached':
      return { icon: 'attached', text: 'agent attached' }
    case 'issue.cleaned':
      return { icon: 'cleaned', text: 'worktree cleaned' }
    case 'issue.needs_human':
      return { icon: 'flagged', text: 'flagged for a human' }
    case 'issue.needs_human_cleared':
      return { icon: 'cleared', text: 'human flag cleared' }
    case 'issue.ready':
      return { icon: 'ready', text: 'unblocked' }
    case 'issue.integration':
      return {
        icon: 'integration',
        text:
          typeof p.blockedAt === 'number'
            ? `integration blocked at #${p.blockedAt}`
            : 'integration ran',
      }
    default:
      // Forward-compat, but QUIET: an unrecognised kind still renders (a future
      // event type is never silently dropped) and is marked minor so a flood of
      // them collapses instead of burying the transitions above.
      return { icon: 'generic', text: humanizeKind(event.kind), minor: true }
  }
}

/** A comment as IssuePage renders it — fetched lazily via the issues.comments
 *  proc (#175); comment bodies no longer ride IssueWire. */
export interface ActivityComment {
  author: string
  body: string
  createdAt: string
}

/** A single row in the merged activity feed — a comment or a formatted event. */
export type ActivityItem =
  | { kind: 'comment'; id: string; ts: string; author: string; body: string }
  | { kind: 'event'; id: string; ts: string; line: IssueEventLine }

/**
 * Merge comments and events into one chronologically-ordered activity feed
 * (oldest first, matching the existing comment thread). Hidden events are
 * dropped. Both timestamps are ISO-8601 strings, so a lexicographic compare is
 * chronological; the sort is stable, so equal-timestamp ties keep insertion
 * order (comments before events).
 */
export function buildActivityFeed(
  comments: ActivityComment[],
  events: IssueEvent[],
): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const c of comments) {
    items.push({
      kind: 'comment',
      id: `c|${c.author}|${c.createdAt}|${c.body}`,
      ts: c.createdAt,
      author: c.author,
      body: c.body,
    })
  }
  for (const e of events) {
    const line = formatIssueEvent(e)
    if (!line) continue
    items.push({ kind: 'event', id: `e|${e.id}`, ts: e.ts, line })
  }
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return items
}

// ---------------------------------------------------------------------------
// Presentation grouping (POD-591)
//
// The flat chronological feed is the MODEL; it is not what a human should read.
// One task's log is mostly minor churn — POD-516 carried 28 consecutive
// `issue.read` ticks between two real transitions — so the feed renders as days
// of entries, with runs of minor events collapsed behind one line the operator
// can open. Pure and separate from `buildActivityFeed` so the merge order stays
// independently testable.
// ---------------------------------------------------------------------------

/** A collapsed run of consecutive minor events. `items` are the originals, in
 *  order, so expanding shows exactly what was hidden. */
export interface ActivityRollup {
  kind: 'rollup'
  id: string
  /** Newest ts in the run — what the collapsed line stamps. */
  ts: string
  /** Oldest ts in the run — the "between X and Y" span. */
  firstTs: string
  label: string
  count: number
  items: ActivityItem[]
}

export type ActivityEntry = ActivityItem | ActivityRollup

/** One day's worth of entries, oldest day first. */
export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD` — the React key. */
  key: string
  label: string
  entries: ActivityEntry[]
}

/** A run shorter than this reads fine inline; collapsing two lines into one
 *  "2 events" line hides as much as it saves. */
export const ROLLUP_MIN = 3

/** Local calendar day of an ISO timestamp. Local, not UTC: the operator groups
 *  by their own day, and a UTC key puts an evening event on tomorrow. */
function dayKeyOf(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

/** Clock time for a feed row (`21:58`). The day divider already carries the
 *  date, so the row spends no width restating it — and never an ISO string,
 *  which is what this surface shipped before POD-591. */
export function eventClock(ts: string): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return ts
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Full, unambiguous stamp for a row's `title` — the ISO precision is still
 *  reachable, it just stops being the visible text. */
export function eventStamp(ts: string): string {
  const at = new Date(ts)
  return Number.isNaN(at.getTime()) ? ts : at.toLocaleString()
}

function dayLabelOf(key: string, at: Date, now: number): string {
  const today = new Date(now)
  if (key === dayKeyOf(today)) return 'Today'
  if (key === dayKeyOf(new Date(now - 86_400_000))) return 'Yesterday'
  const sameYear = at.getFullYear() === today.getFullYear()
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

function rollupLabel(items: ActivityItem[]): string {
  const texts = new Set(
    items.map((item) => (item.kind === 'event' ? item.line.text : '')).filter(Boolean),
  )
  const only = texts.size === 1 ? [...texts][0] : undefined
  return only ? `${items.length} × ${only}` : `${items.length} background events`
}

function isMinor(item: ActivityItem): boolean {
  return item.kind === 'event' && item.line.minor === true
}

/** Collapse consecutive minor events inside one day's entries. */
function collapseMinor(items: ActivityItem[]): ActivityEntry[] {
  const out: ActivityEntry[] = []
  let run: ActivityItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length < ROLLUP_MIN) out.push(...run)
    else {
      const first = run[0]
      const last = run[run.length - 1]
      // Non-null: `run` is non-empty here, and both ends exist by construction.
      if (first && last) {
        out.push({
          kind: 'rollup',
          id: `r|${first.id}|${run.length}`,
          ts: last.ts,
          firstTs: first.ts,
          label: rollupLabel(run),
          count: run.length,
          items: run,
        })
      }
    }
    run = []
  }
  for (const item of items) {
    if (isMinor(item)) run.push(item)
    else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

/**
 * Group a chronological feed into days, collapsing runs of minor events. Days
 * come back oldest-first, matching the feed's own order — the composer sits at
 * the bottom, so the newest entry is the one nearest the place you type.
 */
export function groupActivityFeed(items: ActivityItem[], now: number): ActivityDay[] {
  const days: ActivityDay[] = []
  let current: { key: string; items: ActivityItem[] } | null = null
  for (const item of items) {
    const at = new Date(item.ts)
    const key = Number.isNaN(at.getTime()) ? item.ts.slice(0, 10) : dayKeyOf(at)
    if (!current || current.key !== key) {
      if (current) days.push(finishDay(current, now))
      current = { key, items: [] }
    }
    current.items.push(item)
  }
  if (current) days.push(finishDay(current, now))
  return days
}

function finishDay(day: { key: string; items: ActivityItem[] }, now: number): ActivityDay {
  const first = day.items[0]
  const at = first ? new Date(first.ts) : new Date(now)
  return {
    key: day.key,
    label: Number.isNaN(at.getTime()) ? day.key : dayLabelOf(day.key, at, now),
    entries: collapseMinor(day.items),
  }
}
