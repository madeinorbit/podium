/**
 * The adoption gate — may this device's pre-identity replica be adopted by whoever
 * is signed in now?
 *
 * ORDER IS DELIBERATE AND IS THE POINT OF THIS FILE. Both ADOPT arms are asserted
 * FIRST, against real evidence, before any refusal is asserted at all. A gate whose
 * only coverage is refusals passes identically when it is wired to `return false`,
 * and this run has already paid for that defect class five times (POD-351's suite
 * that would have passed with no ownership check; POD-732's "green against a server
 * serving nothing"). So the first question asked here is whether the instrument can
 * say YES.
 *
 * The refusal cases then each name a DIFFERENT deciding fact, because POD-376's
 * objection to a boolean verdict is the same objection in miniature: "refused"
 * cannot tell a working default from a gate nobody supplied evidence to.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from '../../outbox/records'
import {
  decideLegacyAdoption,
  type LegacyIdentityEvidence,
  type LegacyReplicaImportPlan,
  UNATTRIBUTABLE_REASON,
} from './index'

const COMMAND: OutboxCommand = {
  name: 'sessions.rename',
  version: 3,
  delivery: 'offline-eligible',
}
const ATTRIBUTION: OutboxAttribution = {
  actor: actorUser(asUserId('u_alice')),
  onBehalfOf: asUserId('u_alice'),
}
const NOW = 1_800_000_000_000

const record = (mutationId: string, input: unknown): OutboxRecord => ({
  mutationId: mutationId as MutationId,
  command: COMMAND,
  input,
  partitionKey: 'legacy-import',
  attribution: ATTRIBUTION,
  state: 'queued',
  queuedAt: 1_700_000_000_000,
  attempts: 0,
})

const plan = (...outbox: OutboxRecord[]): LegacyReplicaImportPlan => ({
  verdict: outbox.length > 0 ? 'import' : 'discard',
  outbox,
  retireKeys: ['podium.replica.outbox.v1'],
  rejected: [],
  cursorDiscarded: true,
})

/** The payload every redaction assertion looks for. If a test can find this string
 *  on a parked record, user A's unsent text reached user B's recovery UI. */
const SECRET = 'rename it to the thing I have not told anyone'

describe('the gate can say YES — both adoption arms, on real evidence', () => {
  it('adopts a pre-identity store when NO identities exist system-wide', () => {
    const evidence: LegacyIdentityEvidence = { kind: 'single-account', principal: 'operator' }
    const decision = decideLegacyAdoption(plan(record('m1', { title: SECRET })), evidence, NOW)

    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-single-account')
    expect(decision.redactedCount).toBe(0)
    // Adopted entries are DRAINABLE and INTACT — the whole reason this arm exists
    // is that refusing here would throw away the sole operator's own queued work.
    expect(decision.records).toHaveLength(1)
    expect(decision.records[0]?.state).toBe('queued')
    expect(decision.records[0]?.input).toEqual({ title: SECRET })
  })

  it('adopts when the device ledger names exactly the signed-in user', () => {
    const evidence: LegacyIdentityEvidence = {
      kind: 'multi-user',
      signedInAs: 'u_alice',
      identitiesEverSignedIn: ['u_alice'],
    }
    const decision = decideLegacyAdoption(plan(record('m1', { title: SECRET })), evidence, NOW)

    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-sole-identity')
    expect(decision.records[0]?.state).toBe('queued')
  })

  it('a repeated sign-in by the same user is ONE identity, not two', () => {
    // Guards the `new Set(...)` rather than the length: a ledger that appends per
    // session would refuse every returning user if this counted rows.
    const decision = decideLegacyAdoption(
      plan(record('m1', {})),
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: ['u_alice', 'u_alice'] },
      NOW,
    )
    expect(decision.reason).toBe('adopted-sole-identity')
    expect(decision.adopt).toBe(true)
  })
})

describe('the gate says NO, and says WHICH fact refused', () => {
  const cases: readonly [string, LegacyIdentityEvidence, string][] = [
    [
      'a second person has used this device',
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: ['u_alice', 'u_bob'] },
      'discarded-multiple-identities',
    ],
    [
      'the ledger names someone who is not signed in',
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: ['u_bob'] },
      'discarded-foreign-identity',
    ],
    [
      'the ledger is wired but empty — not the same as unwired',
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: [] },
      'discarded-foreign-identity',
    ],
    [
      'nobody supplied evidence at all — fails toward privacy',
      { kind: 'unknown' },
      'discarded-identity-unknown',
    ],
  ]

  for (const [name, evidence, reason] of cases) {
    it(`refuses when ${name}, as ${reason}`, () => {
      const decision = decideLegacyAdoption(plan(record('m1', { title: SECRET })), evidence, NOW)
      expect(decision.adopt).toBe(false)
      expect(decision.reason).toBe(reason)
    })
  }

  it('the four refusal reasons are distinct codes, not one collapsed "refused"', () => {
    const reasons = cases.map(
      ([, evidence]) => decideLegacyAdoption(plan(record('m1', {})), evidence, NOW).reason,
    )
    // Three distinct codes across four situations: the two foreign-ledger cases
    // share one deliberately (both are "the ledger answered, and it was not you").
    expect(new Set(reasons).size).toBe(3)
  })
})

describe('a discard parks the work — it never evaporates, and never leaks', () => {
  const REFUSED: LegacyIdentityEvidence = {
    kind: 'multi-user',
    signedInAs: 'u_bob',
    identitiesEverSignedIn: ['u_alice', 'u_bob'],
  }

  it('every entry survives as a dead letter, so the loss is surfaced (ADR 6 D4.3)', () => {
    const decision = decideLegacyAdoption(
      plan(record('m1', { title: SECRET }), record('m2', { title: SECRET })),
      REFUSED,
      NOW,
    )
    expect(decision.records).toHaveLength(2)
    expect(decision.redactedCount).toBe(2)
    for (const parked of decision.records) {
      expect(parked.state).toBe('dead-letter')
      expect(parked.parkedFrom).toBe('rejected')
      expect(parked.reason).toEqual(UNATTRIBUTABLE_REASON)
      expect(parked.deadLetteredAt).toBe(NOW)
      // Never sent, and the record must not claim otherwise.
      expect(parked.attempts).toBe(0)
    }
  })

  it('the payload is REDACTED — user A’s text does not reach user B', () => {
    const decision = decideLegacyAdoption(
      plan(record('m1', { title: SECRET, body: { nested: SECRET } })),
      REFUSED,
      NOW,
    )
    expect(decision.records[0]?.input).toBeNull()
    // Assert against the whole serialized record, not just `input`: a future
    // change that copied the payload into any other field would satisfy the
    // narrow assertion and still leak.
    expect(JSON.stringify(decision.records)).not.toContain(SECRET)
  })

  it('the envelope is KEPT, so the user is told what was lost and when', () => {
    const decision = decideLegacyAdoption(plan(record('m1', { title: SECRET })), REFUSED, NOW)
    const parked = decision.records[0]
    expect(parked?.mutationId).toBe('m1')
    expect(parked?.command).toEqual(COMMAND)
    expect(parked?.queuedAt).toBe(1_700_000_000_000)
  })

  it('an empty legacy outbox has nothing to protect — no verdict of discard, no parked record', () => {
    const decision = decideLegacyAdoption(plan(), REFUSED, NOW)
    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-nothing-to-protect')
    expect(decision.records).toEqual([])
    expect(decision.redactedCount).toBe(0)
  })
})

describe('nothing to protect — the store, not the device, is what the gate guards (POD-4000)', () => {
  // The ledger says two people have used this device. Every case below holds
  // that fixed and varies only WHAT STORE is in front of the gate.
  const SHARED_DEVICE: LegacyIdentityEvidence = {
    kind: 'multi-user',
    signedInAs: 'u_alice',
    identitiesEverSignedIn: ['u_alice', 'u_bob'],
  }
  const scoped = (...writtenUnder: string[]) =>
    ({ kind: 'principal-scoped', writtenUnder }) as const

  it('an empty principal-scoped store is adopted: there is no row of anyone’s to launder', () => {
    const decision = decideLegacyAdoption(plan(), SHARED_DEVICE, NOW, scoped())
    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-nothing-to-protect')
  })

  it('a store written only under the signed-in user is adopted, whoever else used the device', () => {
    const decision = decideLegacyAdoption(plan(), SHARED_DEVICE, NOW, scoped('u_alice'))
    expect(decision.adopt).toBe(true)
    expect(decision.reason).toBe('adopted-nothing-to-protect')
  })

  it('…even when the ledger does not name the signed-in user at all', () => {
    const decision = decideLegacyAdoption(
      plan(),
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: ['u_bob'] },
      NOW,
      scoped('u_alice'),
    )
    expect(decision.reason).toBe('adopted-nothing-to-protect')
  })

  it('a genuinely foreign store still discards — and its writer counts as a device identity', () => {
    // The ledger here names ONLY alice; the store itself is the evidence that bob
    // was on this device. A gate that trusted the ledger alone would adopt.
    const decision = decideLegacyAdoption(
      plan(record('m1', { title: SECRET })),
      { kind: 'multi-user', signedInAs: 'u_alice', identitiesEverSignedIn: ['u_alice'] },
      NOW,
      scoped('u_alice', 'u_bob'),
    )
    expect(decision.adopt).toBe(false)
    expect(decision.reason).toBe('discarded-multiple-identities')
    expect(JSON.stringify(decision.records)).not.toContain(SECRET)
  })

  it('a pre-identity store WITH entries on a shared device still discards (the default provenance)', () => {
    const decision = decideLegacyAdoption(plan(record('m1', { title: SECRET })), SHARED_DEVICE, NOW)
    expect(decision.adopt).toBe(false)
    expect(decision.reason).toBe('discarded-multiple-identities')
  })

  it('no evidence at all still refuses, whatever the store claims about itself', () => {
    const decision = decideLegacyAdoption(plan(), { kind: 'unknown' }, NOW, scoped('u_alice'))
    expect(decision.adopt).toBe(false)
    expect(decision.reason).toBe('discarded-identity-unknown')
  })
})
