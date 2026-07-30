/**
 * THE ANTI-FIXTURE GUARD: does the conformance suite talk to the shipped kernel,
 * or to a fixture wearing its name?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * This run's dominant defect class is a suite that cannot say NO, found three
 * times: POD-351 (every revocation test ran as OPERATOR, which short-circuits
 * `authorize` before the owner is read), POD-391 (a guard whose enforcing branch a
 * loopback test server can never reach, so deleting it survived with all 20 tests
 * green), POD-732 (a CLI suite driving a `Proxy` that answers every procedure —
 * "green against a server serving nothing").
 *
 * A CONFORMANCE SUITE is that shape one layer up, and it was in that state until
 * POD-306: `ConformanceAuthority` hand-rolled feed identity, the retention floor
 * and the backpressure demotion, so the gates certifying ADR 2 D1, D5 and D9 were
 * measuring the fixture. The gates were green, they were credited, and the kernel
 * had no code for any of it.
 *
 * POD-305's remedy for the same hazard was to bind its arbitration tests to the
 * SHIPPED `OWNERSHIP_MATRIX`, with a guard that fails FIRST if the matrix imports
 * empty. This file is that guard for the other half. It asserts the BINDING by
 * object identity — not that the fixture behaves plausibly, which a good fake also
 * does, but that the code producing the behaviour is the code that ships.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT DO, STATED SO IT IS NOT OVER-READ
 * ---------------------------------------------------------------------------
 *
 * It does not make `ConformanceAuthority` the real `Authority`. It is not, and it
 * should not be: this fixture holds the LOG and the CLOCK, and the suite must not
 * encode product policy Phase 3 (POD-290) has not decided. What this guard pins is
 * narrower and is the part that was wrong: every property for which SHIPPED kernel
 * code now exists must be produced BY that code.
 *
 * POD-1077 moved one more property across that line. The visibility POLICY used to
 * be a stub inside the fixture — the last thing the seven scoped gates were
 * certifying on the kernel's behalf — and the decision half now lives in
 * `feed/visibility.ts`. The fixture keeps the TABLES (who was granted what, which
 * kinds are classified), which is what a deployment's tables would hold anyway.
 *
 * So the honest summary of the suite's standing, which is what a reader of a green
 * run needs: feed identity, the send queue, the demotion and the visibility
 * DECISION are the kernel's; the log, the clock and the visibility TABLES are the
 * fixture's; the Replica and the Outbox were always real. What remains outside
 * this suite entirely is the AUTHENTICATOR — `CLIENT_PRINCIPAL_GRADE` is still
 * `device`, so a principal is expressible here and not yet distinguishable on a
 * real connection.
 */

import { describe, expect, it } from 'vitest'
import {
  BoundedSendQueue,
  FeedIdentityRegistry,
  GrantEdgeVisibilityPolicy,
  assertOpaqueEpoch,
} from '../feed'
import { ConformanceAuthority, FIRST_EPOCH, humanOf } from './authority'
import type { ConformancePrincipal } from './authority'

const ADA: ConformancePrincipal = { kind: 'user', userId: 'ada' }
const GRACE: ConformancePrincipal = { kind: 'user', userId: 'grace' }

describe('the guard fires FIRST: the shipped modules are present and non-trivial', () => {
  it('the shipped feed modules import as real constructors, not as empty objects', () => {
    // POD-305's "fails first if the matrix imports empty", transplanted. If a
    // barrel re-export breaks or a module is stubbed out, every binding assertion
    // below would fail with a confusing message about a fixture; this one fails
    // first and says what actually happened.
    expect(typeof FeedIdentityRegistry).toBe('function')
    expect(typeof BoundedSendQueue).toBe('function')
    expect(typeof assertOpaqueEpoch).toBe('function')
    // And the guard itself can say NO, which is the property a guard most often
    // lacks: a no-op `assertOpaqueEpoch` would satisfy every accepting case in
    // `../feed/identity.test.ts` and this line is what catches it.
    expect(() => assertOpaqueEpoch('4')).toThrow()
  })
})

describe('feed identity is produced by the SHIPPED registry (ADR 2 D1)', () => {
  it('the fixture DELEGATES rather than holding two fields', () => {
    const authority = new ConformanceAuthority()
    expect(authority.identity).toBeInstanceOf(FeedIdentityRegistry)
    // Identity, not equality: the epoch the fixture publishes must be the very
    // value the shipped registry minted, not a matching string kept alongside it.
    expect(authority.epoch).toBe(authority.identity.current().epoch)
    expect(authority.feedId).toBe(authority.identity.current().feedId)
  })

  it('the fixture cannot publish a counter epoch, because the shipped guard refuses it', () => {
    // The strongest available evidence that the shipped code is on the path: the
    // fixture is subject to a rule it does not implement. A fixture holding its own
    // string fields would happily publish `'epoch-2'`.
    const authority = new ConformanceAuthority()
    expect(() => assertOpaqueEpoch(authority.epoch)).not.toThrow()
    expect(authority.epoch).toBe(FIRST_EPOCH)
    expect(FIRST_EPOCH).not.toMatch(/^\d+$/)
  })

  it('bumpEpoch MINTS — the caller cannot supply the value', () => {
    // Arity, asserted the way the unscoped tests assert theirs. `bumpEpoch(next:
    // string)` is what made the D1 gate vacuous, so the shape of the method is
    // itself the thing to pin: it takes a CAUSE, and what it returns is a fact
    // about the authority rather than an echo of the test's literal.
    const authority = new ConformanceAuthority()
    const before = authority.epoch
    const after = authority.bumpEpoch('restore')

    expect(after).not.toBe(before)
    expect(authority.epoch).toBe(after)
    expect(authority.feedId).toBe(FEED_ID_OF(authority))
    expect(() => assertOpaqueEpoch(after)).not.toThrow()
  })
})

/** The feedId must not move across a bump — same feed, new generation (D1). */
const FEED_ID_OF = (authority: ConformanceAuthority): string =>
  authority.identity.current().feedId

describe('backpressure is produced by the SHIPPED queue (ADR 2 D9)', () => {
  it('the fixture DELEGATES to BoundedSendQueue', () => {
    const authority = new ConformanceAuthority()
    expect(authority.sendQueueFor(humanOf(ADA))).toBeInstanceOf(BoundedSendQueue)
    // Stable per principal, or a case could never overflow one: a fresh queue per
    // call is empty every time, and the demotion would be unreachable while every
    // assertion about it still passed.
    expect(authority.sendQueueFor(humanOf(ADA))).toBe(authority.sendQueueFor(humanOf(ADA)))
  })

  it('a demotion is REACHED by overflowing, and the frame comes from the queue', () => {
    const authority = new ConformanceAuthority()
    authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 1 } })
    authority.policy.grant('ada', 'issue', 'ADA-1')

    let demotion = null
    for (let i = 0; demotion === null && i < 10; i += 1) {
      demotion = authority.offerTo(humanOf(ADA), authority.frameFor(ADA, 0))
    }

    expect(demotion).not.toBeNull()
    expect(demotion?.kind).toBe('resync-required')
    // Carrying the CURRENT identity, so a demotion cannot be mistaken for a frame
    // from another generation — and so this assertion fails if the queue were
    // handed constants instead of the authority's live identity.
    expect(demotion?.feedId).toBe(authority.feedId)
    expect(demotion?.epoch).toBe(authority.epoch)
  })

  it('a healthy consumer that DRAINS is never demoted — the paired half', () => {
    // Without this, "the slow consumer demotes" is equally consistent with a queue
    // that demotes everyone, which would make the mechanism useless in exactly the
    // way D9 exists to avoid ("one slow phone takes down everyone's server").
    const authority = new ConformanceAuthority()
    authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 1 } })
    authority.policy.grant('ada', 'issue', 'ADA-1')
    const queue = authority.sendQueueFor(humanOf(ADA))

    for (let i = 0; i < 10; i += 1) {
      authority.offerTo(humanOf(ADA), authority.frameFor(ADA, 0))
      queue.drain()
    }
    expect(queue.isDemoted()).toBe(false)
    expect(queue.overflowCount()).toBe(0)
  })
})

describe('visibility is DECIDED by the shipped policy (POD-1077, ADR 9 D2/D3/D4)', () => {
  it('the fixture DELEGATES to GrantEdgeVisibilityPolicy rather than holding a predicate', () => {
    const authority = new ConformanceAuthority()
    expect(authority.policy.evaluator).toBeInstanceOf(GrantEdgeVisibilityPolicy)
    // Identity, not plausibility: the answer the fixture publishes must come from
    // the very evaluator the kernel ships, not from a matching predicate kept
    // alongside it. A `canSee` that agreed by coincidence is exactly the fixture
    // this whole file exists to catch.
    authority.policy.grant('ada', 'issue', 'ADA-1')
    expect(authority.policy.canSee(ADA, 'issue', 'ADA-1')).toBe(
      authority.policy.evaluator.mayDeliver(ADA, { entity: 'issue', entityId: 'ADA-1' }),
    )
  })

  it('the shipped policy can say NO to something the FIXTURE granted', () => {
    // The strongest available evidence that the kernel is on the path: the fixture
    // is subject to a rule it does not implement. A hand-rolled `grants.has(key)`
    // would return true here — the grant is really in the table — and the kernel
    // refuses anyway, because the entity kind carries no declared visibility class
    // (ADR 9 D4). This is the assertion a stub cannot pass.
    const authority = new ConformanceAuthority()
    authority.policy.grant('ada', 'automation', 'AUT-1')

    expect(authority.policy.canSee(ADA, 'automation', 'AUT-1')).toBe(false)
    expect(
      authority.policy.evaluator.decide(ADA, { entity: 'automation', entityId: 'AUT-1' }),
    ).toEqual({ visible: false, reason: 'unclassified' })
  })

  it('and it says YES for a declared kind with a grant — the paired half', () => {
    // Without this, the case above is equally consistent with an evaluator that
    // refuses everything, which would make all seven scoped gates vacuous in the
    // other direction.
    const authority = new ConformanceAuthority()
    authority.policy.grant('ada', 'issue', 'ADA-1')
    expect(authority.policy.canSee(ADA, 'issue', 'ADA-1')).toBe(true)
    expect(authority.policy.canSee(GRACE, 'issue', 'ADA-1')).toBe(false)
  })
})

describe('the retention floor is published on every frame (ADR 2 D5)', () => {
  it('the frame carries the authority’s own floor, and follows it when it moves', () => {
    const authority = new ConformanceAuthority()
    authority.append({ entity: 'issue', entityId: 'ADA-1', op: 'upsert', payload: { n: 1 } })
    authority.append({ entity: 'issue', entityId: 'ADA-2', op: 'upsert', payload: { n: 2 } })
    authority.policy.grant('ada', 'issue', 'ADA-1')

    expect(authority.frameFor(ADA, 0).minAvailableSeq).toBe(0)
    authority.compactTo(2)
    // The paired half: a fixture publishing a constant 0 passes the first
    // assertion and fails this one. It is the same field `changesSince` refuses
    // below, so the proactive signal and the reactive refusal cannot disagree.
    expect(authority.frameFor(ADA, 0).minAvailableSeq).toBe(2)
  })
})
