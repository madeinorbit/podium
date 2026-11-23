/**
 * THE ISSUE-EVENT FEED (POD-1772) — `podium_events` onto the metadata
 * feed, as a BOUNDED WINDOW.
 *
 * ---------------------------------------------------------------------------
 * ONE HOOK, BECAUSE THERE IS ONE APPEND
 * ---------------------------------------------------------------------------
 * Thirty-odd call sites write orchestrator events, and every one of them goes
 * through `EventsRepository.appendEvent`. Publishing from there rather than from
 * the callers is what makes "every feed-kind event reaches the feed" a property
 * of the write path instead of a list somebody has to keep complete — the
 * failure mode being a new event kind that renders in the CLI's log and is
 * silently absent from the browser's.
 *
 * ---------------------------------------------------------------------------
 * WHY A WINDOW, AND WHY DELETES ARE PART OF PUBLISHING
 * ---------------------------------------------------------------------------
 * The event log is append-only and unbounded; a replica is a cache on a phone.
 * The Authority holds one value per (kind, id) and a bootstrap serves the whole
 * kind, so publishing every event with no counter-move would make every new
 * client download the entire history of the installation before it could paint a
 * pane that shows forty rows.
 *
 * So the publisher owns a WINDOW of the most recent {@link FEED_WINDOW} events:
 * entering it is an `upsert`, leaving it is a `remove`. Both ops travel on the
 * same ordered pipe as one commit, so a replica can never observe the window's
 * top without its bottom. The window is a fact about what the FEED carries, not
 * about what the log retains — `issues.events` still reads the full table, and
 * the log's own retention job is unaffected.
 *
 * THE WINDOW IS A QUERY ON THE EVENTS TABLE (POD-6766, design POD-6253 §1):
 * the newest {@link FEED_WINDOW} feed-kind events with a subject that EXIST
 * (`EventsRepository.feedWindow`), the same read the record builder streams.
 * Nothing keeps a copy of it. Every append and every retention batch is
 * captured by the database and drained into the log in its own transaction
 * (`EventsRepository.setLogCommit`), and the capture's mapping
 * (`sync/record-sources.ts`) names the events that entered or left the
 * window: an arrival and the one it pushed out, the deleted events that were
 * inside it and the older ones it now reaches (POD-6920). Before POD-6766 the
 * window lived in memory, seeded from the log, and never learned of
 * retention: on 2026-11-09 the feed still carried 73 events the table no
 * longer had.
 */

import { type IssueEventWire, issueEventRowId } from '@podium/model'
import type { EventsRepository, PodiumEventRecord } from '../../store/events'

/**
 * How many events the feed carries. The chat pane keeps a tail of 40 and the
 * per-issue activity view reads its own history over RPC, so this is sized for
 * "the feed still has something to show after a quiet client reconnects", not
 * for scrollback. Five times the rendered tail, and a bounded bootstrap.
 */
export const FEED_WINDOW = 200

/** The feed record of one stored event. */
export function issueEventRecordOf(event: PodiumEventRecord): IssueEventWire {
  const id = issueEventRowId(event.id, event.subject)
  return {
    id,
    eventId: event.id,
    ts: event.ts,
    kind: event.kind,
    subject: event.subject,
    repoPath: event.repoPath ?? null,
    payload: event.payload ?? {},
  } as IssueEventWire
}

/** The window the feed carries, read from the table, oldest first. */
export async function issueEventWindow(
  events: Pick<EventsRepository, 'feedWindow'>,
  windowSize = FEED_WINDOW,
): Promise<IssueEventWire[]> {
  return (await events.feedWindow({ limit: windowSize })).reverse().map(issueEventRecordOf)
}
