import type { IssueStage } from '@podium/protocol'
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
      const label = to && to in STAGE_LABELS ? STAGE_LABELS[to as IssueStage] : (to ?? 'a new stage')
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
      return { icon: 'generic', text: humanizeKind(event.kind) }
  }
}

/** A comment as IssuePage already renders it (see `issueDetailFields`). */
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
