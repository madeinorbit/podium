/**
 * THE DESKTOP SQLITE STORE IS ONLY ADOPTED WHEN ATTRIBUTION IS CERTAIN (POD-1252).
 *
 * This root was the one POD-310 said to make a bookkeeping decision about, because
 * POD-378's TanStack removal is expected to delete the file. It is fixed instead of
 * deferred: that deletion is blocked behind the main catch-up, and until it lands
 * this is a shipping desktop path holding one person's slice in a dedicated SQLite
 * file on a machine other people use. A finding parked against another issue's
 * deletion is a finding nobody holds — which is how this item became unowned in the
 * first place.
 *
 * WHY THE TEST DRIVES `attributeDesktopStore` AND NOT `desktopReplicaFactory`. The
 * factory's first act is a Tauri bridge probe, and everything after it arrives by
 * dynamic import from `@tauri-apps/plugin-sql` and the TanStack persistence core. A
 * test that faked all of that would be measuring its own fakes: the persistence
 * adapter, the driver, and the plugin's pool are precisely what cannot be
 * reproduced in jsdom, and the E2E lane is where the real shell is exercised. So
 * this drives the decision function the factory calls — the same code, one hop up
 * from the imports — and asserts what a refusal SPENDS.
 *
 * WHAT IT SPENDS IS THE POINT. POD-1220 found the shape where a gate has a caller
 * and no effect: on their root, entities and the cursor were retired
 * unconditionally either way, so the decision changed nothing observable and would
 * have passed a suite that only checked its return value. Both spends are asserted
 * here — the SQLite wipe, and the blackout of the legacy-blob migration source —
 * and the adopting case beside each proves neither happens by default.
 */

import { describe, expect, it, type Mock, vi } from 'vitest'
import { attributeDesktopStore } from './desktopReplica'

const SOLE_OPERATOR = { kind: 'single-account', principal: 'default' } as const
const UNKNOWN = { kind: 'unknown' } as const

function harness(): {
  clearPersisted: Mock<() => Promise<void>>
  now: () => number
} {
  return {
    clearPersisted: vi.fn<() => Promise<void>>(async () => {}),
    now: () => 1_700_000_000_000,
  }
}

describe('the desktop sqlite store is only adopted when attribution is CERTAIN', () => {
  it('ADOPTS under the shared-password grade, and touches nothing', async () => {
    const h = harness()
    const decision = await attributeDesktopStore({ ...h, evidence: SOLE_OPERATOR })
    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-single-account')
    // THE COUNTERFACTUAL FOR EVERY REFUSAL BELOW. A wipe that ran unconditionally
    // would satisfy all three refusal arms and none of the rule.
    expect(h.clearPersisted).not.toHaveBeenCalled()
    // `undefined` keeps the replica's surviving ambient reach for
    // `window.localStorage`, which is what the one-time localStorage→SQLite
    // migration reads. The adopting path is unchanged from before the gate existed.
    expect(decision.migrationSource).toBeUndefined()
  })

  it('ADOPTS when the device has only ever been this user — the certainty the rule allows', async () => {
    const h = harness()
    const decision = await attributeDesktopStore({
      ...h,
      evidence: { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['alice'] },
    })
    expect(decision.adopt).toBe(true)
    expect(h.clearPersisted).not.toHaveBeenCalled()
  })

  it('REFUSES when nobody could say who the store belongs to, and WIPES the file', async () => {
    const h = harness()
    const decision = await attributeDesktopStore({ ...h, evidence: UNKNOWN })
    expect(decision.reason).toBe('discarded-identity-unknown')
    expect(h.clearPersisted).toHaveBeenCalledTimes(1)
  })

  it('REFUSES a device that has held sessions for someone else, and WIPES the file', async () => {
    const h = harness()
    const decision = await attributeDesktopStore({
      ...h,
      evidence: {
        kind: 'multi-user',
        signedInAs: 'alice',
        identitiesEverSignedIn: ['alice', 'bob'],
      },
    })
    expect(decision.reason).toBe('discarded-multiple-identities')
    expect(h.clearPersisted).toHaveBeenCalledTimes(1)
  })

  it('REFUSES a ledger that does not name the signed-in user, and WIPES the file', async () => {
    const h = harness()
    const decision = await attributeDesktopStore({
      ...h,
      evidence: { kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['bob'] },
    })
    expect(decision.reason).toBe('discarded-foreign-identity')
    expect(h.clearPersisted).toHaveBeenCalledTimes(1)
  })

  it('BLINDS the legacy-blob migration on a refusal — and leaves the blobs where they are', async () => {
    // The second store, and the one easy to miss: SQLite mode is the single
    // surviving ambient reach in the replica, because the one-time migration reads
    // the old localStorage blobs through it. Wiping the SQLite file while letting
    // that migration carry the previous person's queued writes back in would be a
    // gate with half an effect.
    //
    // The refusal is `side-cache.ts`'s posture toward an unattributable queue —
    // LEFT WHERE IT IS, not adopted and not destroyed — so a later boot that CAN
    // attribute the device still takes the work. Substituting an EMPTY store is how
    // that is enforced: the migration reads nothing, and reading nothing it retires
    // nothing.
    const h = harness()
    const decision = await attributeDesktopStore({ ...h, evidence: UNKNOWN })
    const source = decision.migrationSource
    expect(source).toBeDefined()
    // Empty from the migration's point of view, whatever the real device holds.
    expect(source?.getItem('podium.replica.outbox.v1')).toBeNull()
    expect(source?.getItem('podium.replica.issues.v1')).toBeNull()
    // …and a working seam rather than a broken one: the replica probes its store,
    // and a stub that refused writes would take a fallback path nobody asked for.
    source?.setItem('probe', 'ok')
    expect(source?.getItem('probe')).toBe('ok')
  })
})
