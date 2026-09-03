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
 * IT NEVER THROWS INTO A MUTATION
 * ---------------------------------------------------------------------------
 * By the time `publish` runs the durable write has happened. A publisher fault
 * must not turn a recorded ask into a failed state-change, or a recorded answer
 * into an error the operator sees after the digits already landed.
 */

import { createLogger } from '@podium/logger'
import { interactionRowId } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import type { InteractionRow } from '../../store/interactions'

const log = createLogger('server:interactions:feed')

export interface InteractionFeedDeps {
  /** Write-seam ledger. Rows ride entity kind `pendingInteraction`. */
  readonly ledger: Pick<Ledger, 'capture'>
  /** What the Authority already holds for this kind, at construction — the same
   *  seeding argument `IssueEventFeedPublisher` makes: seeding from the TABLE
   *  would re-publish rows a restart had not lost, and disagree with the
   *  snapshot a connected replica already has. */
  readonly seed: () => readonly { readonly id: string }[]
  /** The wire projection of a durable row (the service's, injected so the
   *  publisher does not own a second copy of it). */
  readonly toWire: (row: InteractionRow) => PendingInteractionWire
}

export class InteractionFeedPublisher {
  /** Change-log ids currently carried. */
  private readonly carried: Set<string>

  constructor(private readonly deps: InteractionFeedDeps) {
    this.carried = new Set(deps.seed().map((row) => row.id))
  }

  /**
   * Publish one row's current state — an `upsert` while it is open, a `remove`
   * once it resolves.
   *
   * A resolved row that was never carried publishes nothing: an ask the policy
   * table auto-answered in the same tick it was minted never blocked anyone, and
   * a `remove` for a row no replica ever held is a change with no meaning.
   */
  publish(row: InteractionRow): void {
    try {
      const id = interactionRowId(row.sessionId, row.id)
      if (row.status === 'asked') {
        this.carried.add(id)
        this.capture([
          { entity: 'pendingInteraction', id, op: 'upsert', value: this.deps.toWire(row) },
        ])
        return
      }
      if (this.carried.delete(id)) {
        this.capture([{ entity: 'pendingInteraction', id, op: 'remove' }])
      }
    } catch (err) {
      log.warn('interaction feed publish failed', { err, id: row.id })
    }
  }

  private capture(changes: EntityChangeSpec[]): void {
    this.deps.ledger.capture(changes)
  }
}
