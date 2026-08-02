/**
 * THE OBSERVATION LEASE BOOK (POD-1396, from POD-1385's god-object audit).
 *
 * One owner for the durable observer leases that three modules previously
 * shared as a raw `Map` passed by reference: `SessionLifecycle` constructed it,
 * `SessionRepository` cleared and rehydrated it at boot, and
 * `SessionDaemonLifecycle` wrote rebinds and accepted leases into it. All three
 * could `get`, `set`, `delete` or `clear` anything.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT A LINE-COUNT SPLIT. The audit's own
 * "what it cannot see" section names this shape: three files each individually
 * defensible, with one shared mutable map between them. A split that moved the
 * lease-reading METHODS out while leaving the map shared would have made the
 * audit greener and the design worse, so the map gets an owner first and the
 * reasoning moves afterwards.
 *
 * What changes for callers is only that they can no longer reach operations
 * nobody intended: there is no `delete`, and no way to clear the book except
 * {@link hydrate}, which is the boot path that legitimately replaces it
 * wholesale. Every remaining call is one of the four things the tree actually
 * did with this map.
 */

import type { SessionId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import type { ObservationLeaseRecord } from '../../store/types'

export class SessionObservationLeases {
  private readonly leases = new Map<SessionId, ObservationLeaseRecord>()

  /**
   * Replace the whole book from durable storage. Boot only: this is the one
   * operation that may drop leases, and it drops them because the rows it is
   * about to install are the authority.
   */
  hydrate(rows: Iterable<ObservationLeaseRecord>): void {
    this.leases.clear()
    for (const lease of rows) this.leases.set(lease.sessionId, lease)
  }

  /**
   * Record a newly fenced, rebound or accepted lease under `sessionId`.
   *
   * THE KEY IS PASSED EXPLICITLY AND NOT DERIVED FROM `lease.sessionId`, on
   * purpose. One call site (the `agentObservation` arm of the daemon lifecycle)
   * keys by `observation.podiumSessionId`, and the lines immediately after it
   * exist precisely to handle `observation.podiumSessionId !== session.sessionId`
   * as a legacy unfenced observation. Deriving the key here would have been a
   * silent behaviour change at exactly the site that already knows those two
   * ids can disagree, so each caller keeps passing the key it passed before.
   */
  record(sessionId: SessionId, lease: ObservationLeaseRecord): void {
    this.leases.set(sessionId, lease)
  }

  get(sessionId: SessionId): ObservationLeaseRecord | undefined {
    return this.leases.get(sessionId)
  }

  /**
   * The checkpoint carried by this session's lease, if it has one.
   *
   * Returns `null | undefined` rather than just `undefined` because the record's
   * own `checkpoint` field is nullable: a lease with no checkpoint yet is `null`,
   * and no lease at all is `undefined`. The callers truthy-test the result, so
   * collapsing the two here would read the same today and would be a silent
   * change the first time one of them needs to tell those cases apart.
   */
  checkpointOf(sessionId: SessionId): SessionObservationCheckpointV1 | null | undefined {
    return this.leases.get(sessionId)?.checkpoint
  }

  /** Whether a session has a lease carrying a checkpoint at all. */
  hasCheckpoint(sessionId: SessionId): boolean {
    return this.leases.get(sessionId)?.checkpoint != null
  }

  get size(): number {
    return this.leases.size
  }
}
