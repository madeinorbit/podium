import { asShipAttemptId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { applyAfterCommit, spanOpen } from '../../store/executor/synchronous-span'
import { openTestStore } from '../../test-support/open-test-store'
import { type Lease, LeaseProjection } from './lease-projection'

/**
 * THE SHIPPING LEASE PROJECTION WAITS FOR THE OUTERMOST COMMIT [POD-3366,
 * sites 11 and 12 of POD-3361's audit].
 *
 * Both claims — `claimAttempt` and `claimDurableTrain` — install a lease on the
 * statement after a `ledger.commit`, and every revoke path (cancel, hold,
 * settle, train abandon) deletes one there. Nested inside a caller's span that
 * commit is a SAVEPOINT: an install recorded a lease for an attempt the
 * enclosing span could still roll back, and a delete dropped a lease for a
 * revoke that could equally be rolled back.
 *
 * DRIVEN THROUGH THE REAL SPAN, not a fake one: `store.transact` and the
 * server's own `spanOpen` / `applyAfterCommit`, which is the pair `relay.ts`
 * hands `ShippingService`. A fake span would prove the helper and not the
 * wiring, and the wiring is the half that was missing.
 *
 * NOTHING RELOADS between the rollback and the assertion. The lease projection
 * has no row to re-read anyway — a claim's attempt id exists only once its
 * write has returned — which is exactly why a stale entry here is invisible to
 * any fixture that re-derives.
 */
describe('the shipping lease projection waits for the outermost commit (POD-3366)', () => {
  const lease = (attemptId: string, generation = 1, expiresAt = 1_000): Lease => ({
    attemptId: asShipAttemptId(attemptId),
    generation,
    expiresAt,
  })

  const wired = () => new LeaseProjection({ spanOpen, onCommit: applyAfterCommit })

  it('drops a claim the enclosing span rolled back (sites 11 and 12)', async () => {
    const store = await openTestStore(':memory:')
    const leases = wired()

    expect(() =>
      store.transact(() => {
        const pinned = leases.pin(['order-1'])
        expect(leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('a1') }])).toEqual(
          [],
        )
        // The savepoint is released and the install has happened today. The
        // claimant must see its own lease…
        expect(leases.get('order-1')?.attemptId).toBe('a1')
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // …and the attempt row is gone, so the lease must be too. Left behind, it
    // holds the order for an attempt the ledger never kept and the next pass
    // hands the daemon a generation nothing durable backs.
    expect(leases.get('order-1')).toBeUndefined()
  })

  it('keeps a claim whose enclosing span commits', async () => {
    const store = await openTestStore(':memory:')
    const leases = wired()

    await store.transact(() => {
      const pinned = leases.pin(['order-1'])
      leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('a1') }])
    })

    expect(leases.get('order-1')?.attemptId).toBe('a1')
  })

  it('does not drop a lease for a revoke the enclosing span rolled back', async () => {
    // The INVERSE direction, and the one a deferral-only fix would miss: every
    // revoke path deletes here, and a delete that outlives its rolled-back
    // transaction leaves the order unheld while the database still says an
    // attempt owns it.
    const store = await openTestStore(':memory:')
    const leases = wired()
    leases.set('order-1', lease('a1'))

    expect(() =>
      store.transact(() => {
        leases.delete('order-1')
        expect(leases.get('order-1')).toBeUndefined()
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(leases.get('order-1')?.attemptId).toBe('a1')
  })

  it('refuses an in-span claim against an in-span revoke (the versions are not staged)', async () => {
    // WHY THE VERSIONS STAY UNSTAGED. They exist so a decision taken before a
    // write can be refused after it, and that has to hold for two writes inside
    // ONE span, neither of which is durable yet. Staging the version would make
    // this claim pin a number the revoke had not moved, and the refusal this
    // class exists for would not happen.
    const store = await openTestStore(':memory:')
    const leases = wired()
    leases.set('order-1', lease('a1'))

    await store.transact(() => {
      const pinned = leases.pin(['order-1'])
      leases.delete('order-1')
      expect(leases.installIfUnchanged(pinned, [{ orderId: 'order-1', lease: lease('a2') }])).toEqual(
        ['order-1'],
      )
    })

    expect(leases.get('order-1')).toBeUndefined()
  })

  it('a renewal in the same span sees the claim it renews (the in-window reader)', async () => {
    const store = await openTestStore(':memory:')
    const leases = wired()

    await store.transact(() => {
      leases.set('order-1', lease('a1', 3, 1_000))
      // `renew` reads the stored lease and refuses unless the attempt and
      // generation match. With a bare deferral it would read straight past the
      // claim it is renewing and refuse.
      expect(leases.renew('order-1', asShipAttemptId('a1'), 3, 5_000)).toBe(true)
    })

    expect(leases.get('order-1')?.expiresAt).toBe(5_000)
  })
})
