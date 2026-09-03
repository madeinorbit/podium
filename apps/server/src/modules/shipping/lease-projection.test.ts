/**
 * THE SHIPPING LEASE PROJECTION'S MODEL [POD-3259, spec §3.6 model (c)].
 *
 * `ShippingService.leases` is the one registry in this audit with no row to
 * hang off: a claim's attempt id exists only once its write has returned, so
 * the projection cannot be re-read from the store while a claim is deciding.
 * That is why it takes model (c) — the projection behind its own version,
 * independent of the database scheduler — rather than a mirror install.
 *
 * These drive the projection over a persistence fake that PARKS, because the
 * defect only exists while a claim's write is in flight: today the install is
 * the statement after the commit and nothing can land between them.
 */

import { asShipAttemptId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { barrier, settle } from '../../store/executor/harness'
import { type Lease, LeaseProjection } from './lease-projection'

const lease = (attemptId: string, generation = 1, expiresAt = 1_000): Lease => ({
  attemptId: asShipAttemptId(attemptId),
  generation,
  expiresAt,
})

describe('lease projection: a claim whose write parks', () => {
  it('refuses the install when a revoke landed while the claim was committing', async () => {
    // THE SITE: `claimAttempt` / `claimDurableTrain`. A cancellation, a hold, a
    // settlement and a train abandon all DELETE the lease; any of them landing
    // in the gap leaves the order held by a lease nothing durable backs, and the
    // next pass hands the daemon a generation the ledger has already finished.
    const leases = new LeaseProjection()
    const parked = barrier()

    const pinned = leases.pin(['order-1'])
    const claim = (async () => {
      await parked.wait()
      return leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('attempt-1') }])
    })()

    await parked.reached()
    await settle()
    // The revoke lands inside the gap.
    leases.set('order-1', lease('attempt-0'))
    leases.delete('order-1')

    parked.release()
    expect(await claim, 'the claim must not resurrect a revoked lease').toEqual(['order-1'])
    expect(leases.get('order-1')).toBeUndefined()
  })

  it('installs when nothing moved, which is every claim today', async () => {
    const leases = new LeaseProjection()
    const parked = barrier()

    const pinned = leases.pin(['order-1'])
    const claim = (async () => {
      await parked.wait()
      return leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('attempt-1') }])
    })()

    await parked.reached()
    await settle()
    parked.release()

    expect(await claim).toEqual([])
    expect(leases.get('order-1')?.attemptId).toBe('attempt-1')
  })

  it('is not refused by traffic on an unrelated order', () => {
    // WHY THE VERSION IS PER ORDER, and it is a correctness requirement rather
    // than a refinement: renewals arrive continuously from the daemon, so a
    // projection-wide counter would refuse a claim of any duration because of
    // heartbeats that have nothing to do with it.
    const leases = new LeaseProjection()
    // Both orders must ALREADY have a version, or a projection-wide counter and
    // a per-order one are indistinguishable here: an order nobody has touched
    // reads 0 either way, and the test passes without producing the thing.
    leases.set('order-1', lease('attempt-0'))
    leases.set('order-2', lease('attempt-2'))
    const pinned = leases.pin(['order-1'])

    leases.renew('order-2', asShipAttemptId('attempt-2'), 1, 9_000)
    leases.delete('order-2')

    expect(
      leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('attempt-1') }]),
    ).toEqual([])
    expect(leases.get('order-1')?.attemptId).toBe('attempt-1')
  })

  it('installs the members that kept their lease and refuses only the one that lost it', () => {
    // A train claims several orders at once, and its members are revoked
    // individually — one member losing its lease is not a reason to abandon the
    // leases of the members that kept theirs.
    const leases = new LeaseProjection()
    const pinned = leases.pin(['order-1', 'order-2'])
    leases.set('order-2', lease('attempt-old'))
    leases.delete('order-2')
    expect(
      leases.installIfUnchanged(pinned, [
        { orderId: 'order-1', lease: lease('attempt-1') },
        { orderId: 'order-2', lease: lease('attempt-2') },
      ]),
    ).toEqual(['order-2'])
    expect(leases.get('order-1')?.attemptId).toBe('attempt-1')
    expect(leases.get('order-2')).toBeUndefined()
  })
})

describe('lease projection: a renewal replaces rather than mutates', () => {
  it('gives a reader that captured the old lease an unchanged object', () => {
    // A heartbeat used to assign `current.expiresAt` in place. With awaits in
    // the picture that moves a value under a claim that is deciding against it,
    // and it does not move the version such a claim pins.
    const leases = new LeaseProjection()
    leases.set('order-1', lease('attempt-1', 1, 1_000))
    const captured = leases.get('order-1')
    const before = leases.versionOf('order-1')

    expect(leases.renew('order-1', asShipAttemptId('attempt-1'), 1, 5_000)).toBe(true)
    expect(captured?.expiresAt, 'the captured lease is immutable').toBe(1_000)
    expect(leases.get('order-1')?.expiresAt).toBe(5_000)
    expect(leases.versionOf('order-1'), 'a renewal is a projection move').toBeGreaterThan(before)
  })

  it('refuses a renewal for a generation the projection no longer holds', () => {
    const leases = new LeaseProjection()
    leases.set('order-1', lease('attempt-2', 2))
    expect(leases.renew('order-1', asShipAttemptId('attempt-1'), 1, 5_000)).toBe(false)
    expect(leases.get('order-1')?.attemptId).toBe('attempt-2')
  })

  it('does not move the version when a delete removed nothing', () => {
    const leases = new LeaseProjection()
    const before = leases.versionOf('order-absent')
    leases.delete('order-absent')
    expect(
      leases.versionOf('order-absent'),
      'a no-op delete must not refuse a claim for that order',
    ).toBe(before)
  })
})
