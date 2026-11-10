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
 * same ordered pipe as one capture, so a replica can never observe the window's
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
 * removes them and carries whatever the window holds now; the boot reconciles
 * the window from the table. Before this, the window lived in memory, seeded
 * from the log, and never learned of retention: on 2026-11-09 the feed still
 * carried 73 events the table no longer had.
 */

import { type IssueEventWire, isFeedEventKind, issueEventRowId } from '@podium/model'
import type { EntityChangeSpec, LedgerWriter } from '@podium/sync'
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
  readonly ledger: Pick<LedgerWriter, 'capture' | 'reconcile'>
  /** The window's reads. */
  readonly events: Pick<EventsRepository, 'feedWindow' | 'feedWindowIds'>
  /** One transaction on the store the events table lives in. */
  readonly transact: <T>(fn: () => Promise<T>) => Promise<T>
  readonly windowSize?: number
}

export class IssueEventFeedPublisher {
  private readonly windowSize: number
  private resolving: Promise<void> | undefined

  constructor(private readonly deps: IssueEventFeedDeps) {
    this.windowSize = Math.max(deps.windowSize ?? FEED_WINDOW, 1)
  }

  /** Reconcile the window from the table once, after composition and before
   *  serving: what retention took while the server was down, and what a lost
   *  publish left behind, is corrected here. */
  async resolve(): Promise<void> {
    this.resolving ??= (async () => {
      const window = await issueEventWindow(this.deps.events, this.windowSize)
      await this.deps.ledger.reconcile(
        'issueEvent',
        window.map((value) => ({ id: value.id, value })),
      )
    })()
    await this.resolving
  }

  /**
   * Publish one appended event, if the feed carries its kind.
   *
   * NEVER THROWS INTO THE APPEND. The durable write has already happened by the
   * time this runs, and a publisher fault must not turn a recorded event into a
   * failed command — a feed row that never arrives is a stale pane, a rolled
   * back `issues.close` is a lie about the world.
   */
  async publish(eventId: number, record: Omit<PodiumEventRecord, 'id'>): Promise<void> {
    await this.resolve()
    if (!isFeedEventKind(record.kind)) return
    if (record.subject === '') return
    try {
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
        const specs: EntityChangeSpec[] = []
        if (place !== -1 && place < this.windowSize) {
          const value = issueEventRecordOf({ id: eventId, ...record })
          specs.push({ entity: 'issueEvent', id: value.id, op: 'upsert', value })
        }
        const evicted = below[this.windowSize]
        if (evicted !== undefined) {
          specs.push({
            entity: 'issueEvent',
            id: issueEventRowId(evicted.id, evicted.subject),
            op: 'remove',
          })
        }
        // ONE capture: the arrival and the eviction it caused are the same
        // observation, and a replica must never see the window grow past its
        // own bound because the two halves were separately ordered.
        if (specs.length > 0) await this.deps.ledger.capture(specs)
      })
    } catch {
      // Publishing is best-effort by design (see the doc comment above).
    }
  }

  /**
   * Retention deleted these events. Those the feed carried leave it, and the
   * window as the table now holds it is carried (an upsert the feed already
   * holds is dropped by the log), so the feed is the window again. Never
   * throws: the next boot reconciles the window.
   */
  async pruned(deleted: readonly { id: number; subject: string }[]): Promise<void> {
    await this.resolve()
    try {
      await this.deps.transact(async () => {
        const window = await issueEventWindow(this.deps.events, this.windowSize)
        const specs: EntityChangeSpec[] = [
          ...deleted.map(
            (row): EntityChangeSpec => ({
              entity: 'issueEvent',
              id: issueEventRowId(row.id, row.subject),
              op: 'remove',
            }),
          ),
          ...window.map(
            (value): EntityChangeSpec => ({
              entity: 'issueEvent',
              id: value.id,
              op: 'upsert',
              value,
            }),
          ),
        ]
        await this.deps.ledger.capture(specs)
      })
    } catch {
      // Best-effort, as publishing is.
    }
  }
}
