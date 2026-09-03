import type { ShipAttempt, ShipOrderId } from '@podium/model'

/** One order's in-memory attempt lease. Immutable: a renewal REPLACES it. */
export interface Lease {
  readonly attemptId: ShipAttempt['id']
  readonly generation: number
  readonly expiresAt: number
}

/**
 * THE LEASE PROJECTION, BEHIND ITS OWN VERSION [POD-3259, spec §3.6 model (c)].
 *
 * `ShippingService.leases` is process-owned state that mirrors which attempt
 * currently owns each order. It is not a cache of a row the store can re-read
 * on demand — a claim's attempt id only exists once its write has returned — so
 * it is a projection with its own consistency, independent of the database
 * scheduler. That is what makes it model (c) rather than a mirror install.
 *
 * WHAT GOES WRONG WITHOUT A VERSION, once the claim's commit can await. A claim
 * reads no lease, commits, and installs one. Today the install is the statement
 * after the commit, so nothing can happen in between. When the commit awaits, a
 * cancellation, a hold, a settlement or a train abandon — every one of which
 * DELETES the lease — can land inside that gap, and the install then puts a
 * lease back for an attempt that has just been revoked. The order is then held
 * by a lease nothing durable backs, and the next pass hands the daemon a
 * generation the ledger has already finished.
 *
 * So a claim PINS the version of the ORDERS it is about to install, and
 * {@link installIfUnchanged} refuses when any of them moved underneath it.
 * Refusing is safe and self-healing rather than lossy: `runOrder` and
 * `runEffect` both reconstitute a missing lease from the durable attempt, so the
 * worst case is one pass that re-derives what it needs, while installing over a
 * revoke is unrecoverable without a restart.
 *
 * THE VERSION IS PER ORDER, and that is a correctness requirement rather than a
 * refinement. A single projection-wide counter is moved by every heartbeat of
 * every other order — renewals arrive continuously from the daemon — so a claim
 * of any duration would be refused by traffic that has nothing to do with it,
 * and a train claim installing several orders would refuse its own second
 * install because its first had moved the counter.
 *
 * The version is a counter and not a mutex: nothing here awaits, and a lock that
 * can only be taken and released inside one synchronous turn would prove
 * nothing. What the model needs is that a decision taken before a write can be
 * refused after it, and a pinned counter is exactly that.
 */
export class LeaseProjection {
  private readonly leases = new Map<string, Lease>()
  private readonly versions = new Map<string, number>()

  /** The version a caller pins for an order before a write it will install. */
  versionOf(orderId: string): number {
    return this.versions.get(orderId) ?? 0
  }

  get(orderId: string): Lease | undefined {
    return this.leases.get(orderId)
  }

  /** Unconditional install, for the paths that reconstitute a lease from a
   *  durable attempt already in hand — there is no gap to refuse across. */
  set(orderId: string, lease: Lease): void {
    this.leases.set(orderId, lease)
    this.bump(orderId)
  }

  delete(orderId: string): void {
    if (!this.leases.delete(orderId)) return
    this.bump(orderId)
  }

  /**
   * Install one or more leases decided at the pinned versions in `pins`.
   * Returns the order ids that were REFUSED because their lease moved while the
   * write was in flight — empty on the happy path, which is every claim today.
   *
   * All-or-nothing per order rather than per batch: a train's members are
   * revoked individually, so one member losing its lease is not a reason to
   * abandon the leases of the members that kept theirs.
   */
  installIfUnchanged(
    pins: ReadonlyMap<string, number>,
    entries: readonly { orderId: string; lease: Lease }[],
  ): string[] {
    const refused: string[] = []
    for (const { orderId, lease } of entries) {
      if (this.versionOf(orderId) !== (pins.get(orderId) ?? 0)) {
        refused.push(orderId)
        continue
      }
      this.set(orderId, lease)
    }
    return refused
  }

  /** Pin the current versions of the orders a write is about to claim. */
  pin(orderIds: readonly string[]): Map<string, number> {
    return new Map(orderIds.map((orderId) => [orderId, this.versionOf(orderId)] as const))
  }

  /** Renewal is a REPLACEMENT (POD-3259): mutating the stored lease in place
   *  would move a value every reader shares while a claim is deciding against
   *  it, and would not move the version such a claim pins. */
  renew(
    orderId: ShipOrderId | string,
    attemptId: ShipAttempt['id'],
    generation: number,
    until: number,
  ): boolean {
    const current = this.leases.get(orderId)
    if (!current || current.attemptId !== attemptId || current.generation !== generation) {
      return false
    }
    this.set(orderId, { attemptId, generation, expiresAt: until })
    return true
  }

  private bump(orderId: string): void {
    this.versions.set(orderId, this.versionOf(orderId) + 1)
  }
}
