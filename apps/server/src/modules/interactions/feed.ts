/**
 * THE INTERACTION FEED PUBLISHER (POD-2020) — the aggregate onto the metadata
 * feed, so §4's "answering from any surface resolves it everywhere" is a
 * property of the data path.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO WINDOW HERE (unlike `issue-events/feed.ts`)
 * ---------------------------------------------------------------------------
 * The event log is unbounded and needed a bounded publish window. Open asks are
 * not: an installation has a handful at any moment, because an open ask means a
 * session is BLOCKED and a blocked session is a thing somebody is about to
 * resolve. What is unbounded is the RESOLVED history, and the answer to that is
 * the same one the durable table uses — a resolved row leaves the feed, and the
 * table keeps it for audit.
 *
 * SO THE FEED CARRIES THE OPEN SET, AND ONLY THAT. Entering it is an `upsert`;
 * resolving is a `remove`. A replica's `pendingInteraction` collection is
 * therefore exactly "the asks blocking a session right now", which is the one
 * question every surface asks of it — and a card disappearing is the correct
 * rendering of an ask that stopped needing an answer, whoever gave it.
 *
 * WHAT THE FEED DELIBERATELY DOES NOT CARRY is the resolved history: who
 * answered, with what, and how it was delivered. That is audit, it is unbounded,
 * and it is read over RPC (`interactions.forSession`) by the one surface that
 * wants it. Pushing it to every replica would trade the property above — a
 * collection that means "blocked right now" — for a log nobody subscribes to.
 * (An `upsert` carrying the answer followed by a `remove` would not buy it back:
 * the funnel coalesces per `(kind, id)`, so the replica would see the removal
 * and never the answer.)
 *
 * ---------------------------------------------------------------------------
 * THE OPEN SET IS A QUERY, NOT A MEMORY (POD-6766, design POD-6253 §1)
 * ---------------------------------------------------------------------------
 * What the feed carries is `status = 'asked'` in `pending_interactions`, the
 * same read the record builder streams. The publisher keeps no copy of it: a
 * row that changed is named, and the Authority builds an open ask as an
 * `upsert` and a closed ask as a `remove`. The repository captures every change
 * to the open set in the row's transaction. Before this, the publisher seeded an in-memory set
 * from the log with the record's own id where it later looked up the row id,
 * so no ask carried across a restart was ever removed: 25 closed asks were
 * still on clients on 2026-11-09.
 *
 * ---------------------------------------------------------------------------
 * THE ROW AND THE LOG COMMIT TOGETHER
 * ---------------------------------------------------------------------------
 * The capture is awaited before the source transaction commits. A log failure
 * rolls the mutation back, so there is no missing entry for a later boot to repair.
 */

import { interactionRowId } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import type { LedgerWriter } from '@podium/sync'
import type { InteractionFeedCapture, InteractionRow } from '../../store/interactions'

export interface InteractionFeedDeps {
  /** Write-seam ledger. Rows ride entity kind `pendingInteraction`. */
  readonly ledger: Pick<LedgerWriter, 'commit'>
}

/** The feed's records for these rows: the open ones, keyed by row id. */
export function openInteractionRecords(
  rows: readonly InteractionRow[],
  toWire: (row: InteractionRow) => PendingInteractionWire,
): { id: string; value: PendingInteractionWire }[] {
  return rows
    .filter((row) => row.status === 'asked')
    .map((row) => ({ id: interactionRowId(row.sessionId, row.id), value: toWire(row) }))
}

export class InteractionFeedPublisher {
  constructor(private readonly deps: InteractionFeedDeps) {}

  /**
   * Capture successful row writes. NAMED AFTER THE WRITE (POD-6770,
   * `NAMED_AFTER_WRITE_KINDS`): the row is already written, and the Authority
   * builds its record from the table in this publish's transaction: open is
   * an `upsert`, anything else a `remove`. The source transaction cannot be
   * overtaken between its row change and this append.
   */
  readonly capture: InteractionFeedCapture = async (rows) => {
    await this.deps.ledger.commit({
      write: async () => {},
      wrote: () =>
        rows.map((row) => ({
          entity: 'pendingInteraction' as const,
          id: interactionRowId(row.sessionId, row.id),
          removed: true,
        })),
    })
  }
}
