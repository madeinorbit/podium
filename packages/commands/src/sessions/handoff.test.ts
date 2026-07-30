/**
 * The `sessions.handoff` contract — POD-642.
 *
 * What is asserted here is the DECLARATION: that it is total, that its input is
 * composed from the shared schema instances rather than restated, and that it
 * carries no serialized authority. The ENFORCEMENT is the handler's and is tested
 * there (`apps/server/src/modules/sessions/oracle-handoff.test.ts` refuses on both
 * machines, re-authorizes at two apply points, single-flights duplicate dispatch,
 * and asserts the attribution pair). Neither file is sufficient alone: a green
 * declaration with no enforcement is mechanism-presence, and enforcement with no
 * declaration is a policy no reviewer can audit.
 */

import { findCapabilitySnapshotKeys, SessionIdentity, SessionPlacement } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AnyCommandContract,
  classificationErrors,
  MACHINE_USE_OFFLINE_EXCEPTIONS,
} from '../contract'
import { MAIL_CONTRACTS } from '../mail/contracts'
import { EXPORTABLE_HARNESSES, sessionHandoffContract, sessionHandoffInput } from './handoff'

describe('sessions.handoff: the declaration is total', () => {
  it('passes the classification lint with no errors', () => {
    expect(classificationErrors(sessionHandoffContract as AnyCommandContract)).toEqual([])
  })

  it('declares the `use` verb on a `machine` resource — the pairing the lint requires', () => {
    expect(sessionHandoffContract.policy.resource).toBe('machine')
    expect(sessionHandoffContract.policy.machineVerb).toBe('use')
  })

  it('is ONLINE-ONLY, and is not on the D18.3 exception list', () => {
    // Two halves, because either alone would be satisfiable the wrong way: the
    // class is what the product does, and the absence from the list is what says
    // nobody licensed an exception for it.
    expect(sessionHandoffContract.delivery.class).toBe('online-only')
    expect(MACHINE_USE_OFFLINE_EXCEPTIONS).not.toContain('sessions.handoff')
  })

  it('is served on trpc ONLY — not on relay, where an agent could ask on its own authority', () => {
    // The exclusion is the load-bearing half. `relay` would let an agent request
    // its own placement onto another person's machine, and `use` is owner-only
    // until granted (readiness §3.1.4 M2).
    expect(sessionHandoffContract.exposure).toEqual(['trpc'])
    expect(sessionHandoffContract.exposure).not.toContain('relay')
    expect(sessionHandoffContract.exposure).not.toContain('outbox')
  })

  it('keeps unauthorized distinguishable from unreachable while invisible fails as nonexistent', () => {
    // The M5 carve-out against the D20.2 rule — both true at once, which is only
    // consistent because `unauthorized` is reachable solely inside the see set.
    expect(sessionHandoffContract.errorConsistency).toMatchObject({
      callerSuppliedTargetId: true,
      invisibleFailsAs: 'nonexistent',
      distinguishesUnauthorizedFromUnreachable: true,
    })
  })

  it('creates nothing, so it declares no owner — a move is not an ownership change', () => {
    expect(sessionHandoffContract.ownership.creates).toEqual([])
    expect(sessionHandoffContract.ownership).not.toHaveProperty('owner')
  })

  it('stamps both halves of the attribution pair from the transport', () => {
    expect(sessionHandoffContract.attribution.actor).toBe('from-capability')
    expect(sessionHandoffContract.attribution.onBehalfOf).toBe('from-delegation')
  })

  it('has NO optimistic reducer, which ADR 3 D6 says is a valid answer', () => {
    // Absence asserted rather than assumed: a client cannot compute the worktree
    // the import resolves on the target, and the move already has a server-set
    // overlay (`handoffTarget`). Guessing would be worse than showing pending.
    expect('optimisticReducer' in sessionHandoffContract).toBe(false)
  })
})

describe('sessions.handoff: the input is composed, not restated', () => {
  it('both fields ARE the shared schema instances', () => {
    // `toBe`, by reference. This is the ONLY instrument that sees a restatement:
    // branding is compile-time, so a field swapped for a fresh `z.string()` is
    // byte-identical on the wire and passes every golden fixture.
    expect(sessionHandoffInput.shape.sessionId).toBe(SessionIdentity.shape.sessionId)
    expect(sessionHandoffInput.shape.machineId).toBe(
      SessionPlacement.shape.machineId.unwrap(),
    )
  })

  it('requires the target machine, where the session aggregate leaves it optional', () => {
    // The tightening, stated where it is true: a session may run wherever the
    // server does; a handoff without a target is not a handoff.
    expect(SessionPlacement.shape.machineId.isOptional()).toBe(true)
    expect(sessionHandoffInput.shape.machineId.isOptional()).toBe(false)
    expect(sessionHandoffInput.safeParse({ sessionId: 's1' }).success).toBe(false)
  })

  it('takes TWO keys and strips anything else — a payload cannot carry identity', () => {
    // ADR 3 D7 rule 1: forged payload identity must be inert. Here it is not even
    // representable — it is dropped before a handler sees it, and the handler takes
    // its principal as a separate argument. The oracle asserts the other half (the
    // durable record still names the transport principal).
    const parsed = sessionHandoffInput.parse({
      sessionId: 's1',
      machineId: 'm2',
      actor: 'mallory',
      onBehalfOf: 'mallory',
      capability: { role: 'admin' },
    })
    expect(Object.keys(parsed).sort()).toEqual(['machineId', 'sessionId'])
  })

  it('carries no serialized authority — the target must resolve rights from its own principal', () => {
    // POD-643's audit, run over this contract's input rather than only over the
    // bundle: a command that shipped a scope or a role in its payload would be the
    // same privilege leak in a shorter-lived object.
    expect(findCapabilitySnapshotKeys(sessionHandoffInput)).toEqual([])
  })

  it("the audit can say YES, so its NO above means something", () => {
    // The instrument check. A detector that answered `[]` for everything would make
    // the assertion above vacuous, and it would look identical.
    const planted = sessionHandoffInput.extend({
      effectiveRights: SessionIdentity.shape.sessionId,
    })
    expect(findCapabilitySnapshotKeys(planted)).toEqual(['effectiveRights'])
  })

  it('names the exportable harnesses from the manifest that owns the list', () => {
    // Not part of the input — a handoff names a session, not a harness — but the
    // pair is asserted here so a second copy of it anywhere reds one test rather
    // than drifting silently. The handler refuses an unexportable session.
    expect(EXPORTABLE_HARNESSES).toEqual(['claude-code', 'codex'])
  })
})

describe('the D18.3 lint this contract is the first tenant of', () => {
  it('refuses a machine `use` command that claims to be offline-eligible', () => {
    // The rule can say NO. Without this, "handoff passes the lint" would be
    // consistent with a lint that never fires — and the clause was added by this
    // issue, so nothing else exercises it.
    const offender = {
      ...sessionHandoffContract,
      name: 'sessions.pretendOffline',
      delivery: { ...sessionHandoffContract.delivery, class: 'offline-eligible' as const },
    }
    expect(classificationErrors(offender as AnyCommandContract)).toEqual([
      expect.stringContaining('may not be offline-eligible'),
    ])
  })

  it('every name licensed as an exception belongs to a contract that EXISTS', () => {
    // The list is a licence, so it is checked rather than trusted. An entry naming
    // no contract would silently pre-authorize whoever next used that name — the
    // hazard POD-381 designed against in the protocol-side table, applied to this
    // one. The list is empty today and that emptiness IS the claim, so the loop
    // below must be able to fail: the second assertion plants a bogus name.
    const declared = new Set([...MAIL_CONTRACTS.map((c) => c.name), sessionHandoffContract.name])
    for (const licensed of MACHINE_USE_OFFLINE_EXCEPTIONS) {
      expect([...declared]).toContain(licensed)
    }
    const unlicensable = ['sessions.doesNotExist'].filter((name) => !declared.has(name))
    expect(unlicensable).toEqual(['sessions.doesNotExist'])
  })

  it('and it does NOT fire on a command that places no work on compute', () => {
    // The counterfactual: the same offline-eligible class on a contract with no
    // machineVerb is legitimate, so the rule must be keyed on the verb and not on
    // the delivery class alone.
    const innocent = {
      ...sessionHandoffContract,
      name: 'sessions.rename',
      policy: { ...sessionHandoffContract.policy, resource: 'session' as const, machineVerb: undefined },
      delivery: { ...sessionHandoffContract.delivery, class: 'offline-eligible' as const },
    }
    expect(classificationErrors(innocent as AnyCommandContract)).toEqual([])
  })
})
