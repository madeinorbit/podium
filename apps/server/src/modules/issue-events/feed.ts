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
 * The window is rebuilt from the Authority at construction rather than from the
 * events table: the Authority is what the feed actually holds, and seeding from
 * the table would re-publish rows a restart had not lost (and, worse, would
 * disagree with the snapshot a connected replica already has).
 */

import {
  type IssueEventWire,
  isFeedEventKind,
  issueEventRowId,
  parseIssueEventRowId,
  type IssueId,
} from '@podium/model'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import type { PodiumEventRecord } from '../../store/events'

/**
 * How many events the feed carries. The chat pane keeps a tail of 40 and the
 * per-issue activity view reads its own history over RPC, so this is sized for
 * "the feed still has something to show after a quiet client reconnects", not
 * for scrollback. Five times the rendered tail, and a bounded bootstrap.
 */
export const FEED_WINDOW = 200

export interface IssueEventFeedDeps {
  /** Write-seam ledger. Rows ride entity kind `issueEvent`. */
  readonly ledger: Pick<Ledger, 'capture'>
  /** What the Authority already holds for this kind, at construction. */
  readonly seed: () => readonly IssueEventWire[]
  readonly windowSize?: number
}

export class IssueEventFeedPublisher {
  /** Row ids currently in the window, oldest first (by durable event id). */
  private window: string[]
  private readonly windowSize: number

  constructor(private readonly deps: IssueEventFeedDeps) {
    this.windowSize = deps.windowSize ?? FEED_WINDOW
    this.window = [...deps.seed()]
      .sort((a, b) => a.eventId - b.eventId)
      .map((row) => row.id)
      // A seed longer than the window (the size was lowered across a restart)
      // is trimmed on the first publish, not here: a constructor that captured
      // deletes would publish before the composition root had finished wiring.
      .slice(-Math.max(this.windowSize, 1) * 2)
  }

  /**
   * Publish one appended event, if the feed carries its kind.
   *
   * NEVER THROWS INTO THE APPEND. The durable write has already happened by the
   * time this runs, and a publisher fault must not turn a recorded event into a
   * failed command — a feed row that never arrives is a stale pane, a rolled
   * back `issues.close` is a lie about the world.
   */
  publish(eventId: number, record: Omit<PodiumEventRecord, 'id'>): void {
    if (!isFeedEventKind(record.kind)) return
    if (record.subject === '') return
    try {
      const id = issueEventRowId(eventId, record.subject)
      const value: IssueEventWire = {
        id,
        eventId,
        ts: record.ts,
        kind: record.kind,
        subject: record.subject,
        repoPath: record.repoPath ?? null,
        payload: record.payload ?? {},
      }
      const specs: EntityChangeSpec[] = [{ entity: 'issueEvent', id, op: 'upsert', value }]
      this.window.push(id)
      while (this.window.length > this.windowSize) {
        const evicted = this.window.shift()
        if (evicted !== undefined) {
          specs.push({ entity: 'issueEvent', id: evicted, op: 'remove' })
        }
      }
      // ONE capture: the arrival and the eviction it caused are the same
      // observation, and a replica must never see the window grow past its own
      // bound because the two halves were separately ordered.
      this.deps.ledger.capture(specs)
    } catch {
      // Publishing is best-effort by design (see the doc comment above).
    }
  }

  /** The feed rows currently carried for one issue — the subject list an
   *  authorization change has to re-scope alongside the issue itself. Answered
   *  from the window, so a grant costs no table read. */
  subjectsFor(issueId: IssueId): { entity: 'issueEvent'; entityId: string }[] {
    const subjects: { entity: 'issueEvent'; entityId: string }[] = []
    for (const id of this.window) {
      try {
        if (parseIssueEventRowId(id).subject === issueId) {
          subjects.push({ entity: 'issueEvent', entityId: id })
        }
      } catch {
        // A row id the current build cannot parse is not this issue's.
      }
    }
    return subjects
  }
}
