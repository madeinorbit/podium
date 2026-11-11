/**
 * THE ISSUE-EVENT FEED PUBLISHER (POD-1772) — `podium_events` onto the metadata
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
 * The publisher keeps no copy of it. An append upserts its event and removes
 * the one its arrival pushed out (the event ranked just past the window among
 * those at or below it, so publishes that overtake each other still each
 * remove their own); a retention batch that deleted events of the window
 * removes them and carries whatever the window holds now. Both append and
 * retention capture run inside their row transaction. Before this, the window lived in memory, seeded
 * from the log, and never learned of retention: on 2026-11-09 the feed still
 * carried 73 events the table no longer had.
 */

import { type IssueEventWire, isFeedEventKind, issueEventRowId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
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

export interface IssueEventFeedDeps {
  /** Write-seam ledger. Rows ride entity kind `issueEvent`. */
  readonly ledger: Pick<LedgerWriter, 'commit'>
  /** The window's reads. */
  readonly events: Pick<EventsRepository, 'feedWindow' | 'feedWindowIds'>
  /** One transaction on the store the events table lives in. */
  readonly transact: <T>(fn: () => Promise<T>) => Promise<T>
  readonly windowSize?: number
}

export class IssueEventFeedPublisher {
  private readonly windowSize: number

  constructor(private readonly deps: IssueEventFeedDeps) {
    this.windowSize = Math.max(deps.windowSize ?? FEED_WINDOW, 1)
  }

  /**
   * Publish one appended event, if the feed carries its kind.
   *
   * Runs inside the event insert's transaction. A log failure must reach that
   * transaction so the event cannot commit without its catch-up entry.
   */
  async publish(eventId: number, record: Omit<PodiumEventRecord, 'id'>): Promise<void> {
    if (!isFeedEventKind(record.kind)) return
    if (record.subject === '') return
    await this.deps.transact(async () => {
      const reach = this.windowSize + 1
      const newest = await this.deps.events.feedWindowIds({ limit: reach })
      const place = newest.findIndex((row) => row.id === eventId)
      // The one its arrival pushed out ranks just past the window among the
      // events at or below it. Usually this event is the newest, and the
      // read above already holds it.
      const below =
        place === 0
          ? newest
          : await this.deps.events.feedWindowIds({ through: eventId, limit: reach })
      // NAMED AFTER THE WRITE (POD-6770, `NAMED_AFTER_WRITE_KINDS`): the
      // event is already in the table. The arrival, when it is inside the
      // window, and the one it pushed out are named, and the Authority
      // builds both from the window's query: the arrival is there (an
      // upsert), the evicted one is not (a remove). An event is announced
      // once, so neither is named twice.
      const named: { entity: 'issueEvent'; id: string; removed?: boolean }[] = []
      if (place !== -1 && place < this.windowSize) {
        named.push({ entity: 'issueEvent', id: issueEventRowId(eventId, record.subject) })
      }
      const evicted = below[this.windowSize]
      if (evicted !== undefined) {
        named.push({
          entity: 'issueEvent',
          id: issueEventRowId(evicted.id, evicted.subject),
          removed: true,
        })
      }
      // ONE commit: the arrival and the eviction it caused are the same
      // observation, and a replica must never see the window grow past its
      // own bound because the two halves were separately ordered.
      if (named.length > 0) {
        await this.deps.ledger.commit({ write: async () => {}, wrote: () => named })
      }
    })
  }

  /**
   * Retention deleted these events in the transaction this capture joins.
   * Exactly the records that moved are named
   * (POD-6770): the deleted events that were inside the window leave it, and
   * the older events the window now reaches enter it. Which those are follows
   * from the ids alone: before the deletion the window was the newest
   * `windowSize` of what it holds now together with what was deleted. A failure
   * rolls the retention batch back with its log entries.
   */
  async pruned(deleted: readonly { id: number; subject: string }[]): Promise<void> {
    if (deleted.length === 0) return
    await this.deps.transact(async () => {
      const now = await this.deps.events.feedWindowIds({ limit: this.windowSize })
      const before = new Set(
        [...now, ...deleted]
          .sort((a, b) => b.id - a.id)
          .slice(0, this.windowSize)
          .map((row) => row.id),
      )
      const named = [
        ...deleted
          .filter((row) => before.has(row.id))
          .map((row) => ({
            entity: 'issueEvent' as const,
            id: issueEventRowId(row.id, row.subject),
            removed: true,
          })),
        ...now
          .filter((row) => !before.has(row.id))
          .map((row) => ({
            entity: 'issueEvent' as const,
            id: issueEventRowId(row.id, row.subject),
          })),
      ]
      if (named.length > 0) {
        await this.deps.ledger.commit({ write: async () => {}, wrote: () => named })
      }
    })
  }
}
