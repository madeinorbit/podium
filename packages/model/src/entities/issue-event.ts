/**
 * THE CROSS-PROJECT ISSUE-EVENT ROW, AS A REPLICATED ENTITY (POD-1772).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BECAME AN ENTITY RATHER THAN STAYING AN RPC
 * ---------------------------------------------------------------------------
 * The chat feed used to read this log by re-querying `issues.events` on a 15 s
 * timer. A timer is not a bad implementation of the feed — it is a DIFFERENT
 * data path, and everything the replica gives a row it never gave these: an
 * offline reload showed nothing, the optimistic overlay could not touch them,
 * and the outbox had no relationship to them at all. They were the only content
 * in that column arriving by a route the rest of the app had already left.
 *
 * They are rows. `podium_events` is a durable, server-assigned, monotonically
 * numbered table; a chat feed over it is exactly the shape the metadata feed
 * carries for every other kind. So it carries these too.
 *
 * ---------------------------------------------------------------------------
 * THE VOCABULARY IS CLOSED, AND IT LIVES HERE
 * ---------------------------------------------------------------------------
 * `podium_events` is the orchestrator's whole event log — mail, locks, session
 * lifecycle, steward bookkeeping. Publishing all of it onto the feed would put a
 * breadcrumb firehose into every client's durable replica for the sake of one
 * pane. {@link FEED_EVENT_KINDS} is the curated set the human-facing feed shows
 * (spec §6.8), and it is the publisher's filter as well as the renderer's — one
 * list, so a kind cannot be rendered but unpublished, or published but unread.
 *
 * ---------------------------------------------------------------------------
 * THE ROW ID CARRIES THE SUBJECT, AND THAT IS A VISIBILITY DECISION
 * ---------------------------------------------------------------------------
 * An event is visible to whoever may read its subject ISSUE. The scoping
 * decision therefore needs the issue id for every row it evaluates, and it makes
 * that decision inside the publish path — before the row is anywhere a lookup
 * could read it back. {@link issueEventRowId} puts the subject IN the change id,
 * so `mayRead` answers from the id alone and a bootstrap can prefetch every
 * subject issue in one batched read rather than one `SELECT` per event.
 */

import { z } from 'zod'

/** The cross-project event vocabulary the chat feed shows — curated to state
 *  changes a human would skim; breadcrumb noise stays out (spec §6.8). */
export const FEED_EVENT_KINDS = [
  'issue.created',
  'issue.started',
  'issue.stage_changed',
  'issue.closed',
  'issue.reopened',
  'issue.needs_human',
  'issue.needs_human_cleared',
  'issue.session_attached',
] as const
export type FeedEventKind = (typeof FEED_EVENT_KINDS)[number]

const FEED_EVENT_KIND_SET: ReadonlySet<string> = new Set(FEED_EVENT_KINDS)

/** Is this event kind one the feed publishes AND renders? */
export function isFeedEventKind(kind: string): kind is FeedEventKind {
  return FEED_EVENT_KIND_SET.has(kind)
}

/**
 * One issue event on the metadata feed.
 *
 * `id` is the CHANGE id (see {@link issueEventRowId}), so the collection keys on
 * the same string the Authority logs — the rule every other replicated kind
 * follows. `eventId` is the durable log id, and is what orders the feed and what
 * the per-user read cursor (`userReadPosition`) names: a composite string sorts
 * lexicographically, which is not the order the log was written in.
 */
export const IssueEventWire = z.object({
  id: z.string().min(1),
  eventId: z.number().int().positive(),
  ts: z.string(),
  kind: z.string(),
  /** The issue this event is about. Every {@link FEED_EVENT_KINDS} member is an
   *  `issue.*` kind, so the subject is always an issue id — which is what makes
   *  the visibility rule "may this person read that issue?" total here. */
  subject: z.string(),
  repoPath: z.string().nullable(),
  payload: z.unknown(),
})
export type IssueEventWire = z.infer<typeof IssueEventWire>

// ---------------------------------------------------------------------------
// Feed row identity — `(eventId, subject)` as one change-log entityId
// ---------------------------------------------------------------------------

const EVENT_ROW_SEP = '\n'

/**
 * Change-log / feed id for one issue event. Escaped join, the same rule as
 * {@link readPositionRowId}: a subject containing the separator must not be able
 * to collide with another pair.
 */
export function issueEventRowId(eventId: number, subject: string): string {
  const esc = (p: string) =>
    p.replaceAll('\\', '\\\\').replaceAll(EVENT_ROW_SEP, `\\${EVENT_ROW_SEP}`)
  return `${eventId}${EVENT_ROW_SEP}${esc(subject)}`
}

/** Inverse of {@link issueEventRowId}. Throws on a malformed id. */
export function parseIssueEventRowId(id: string): { eventId: number; subject: string } {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (ch === '\\') {
      const next = i + 1 < id.length ? id[i + 1] : undefined
      if (next !== '\\' && next !== EVENT_ROW_SEP) {
        throw new Error(`malformed issue event row id: ${JSON.stringify(id)}`)
      }
      current += next
      i += 1
    } else if (ch === EVENT_ROW_SEP) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`malformed issue event row id: ${JSON.stringify(id)}`)
  }
  const eventId = Number(parts[0])
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`malformed issue event row id: ${JSON.stringify(id)}`)
  }
  return { eventId, subject: parts[1]! }
}
