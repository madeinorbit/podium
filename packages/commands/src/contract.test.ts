/**
 * THE CLASSIFICATION TOTALITY GATE (POD-728 acceptance criterion 2).
 *
 * The criterion is "classifications are total, with NO UNCLASSIFIED FIELD
 * DEFAULTING TO EXPOSED". Two halves, and only the first is free from the type
 * system: the type makes every field required, and this suite proves the
 * REQUIRED fields cannot be satisfied vacuously — an empty rationale, an
 * `outbox` exposure with an online-only class, a `secret` resource that is not
 * online-sensitive, a machine resource with no verb.
 *
 * The lint is verified as an INSTRUMENT before it is trusted: every negative
 * case below is derived by MUTATING a contract that the same function passes, so
 * a lint that returned `[]` unconditionally fails this file rather than reading
 * as a clean bill of health.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
  SERVED_NOWHERE,
} from './index'
import { MAIL_CONTRACTS } from './mail/contracts'

/** A minimal, fully classified contract — the positive control. */
const base: AnyCommandContract = {
  name: 'probe.command',
  version: 1,
  visibility: 'personal',
  input: z.object({ x: z.string() }),
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale: 'a probe',
  },
  exposure: SERVED_NOWHERE,
  delivery: {
    class: 'online-only',
    outboxReconciliation: 'a probe',
    applyTimeReauthorization: 'a probe',
  },
  redaction: { reviewed: true, inputPaths: [], outputPaths: [], note: 'a probe' },
  ownership: { creates: [], note: 'a probe' },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale: 'a probe',
  },
  errorConsistency: { callerSuppliedTargetId: false, note: 'a probe' },
}

/** Deep-ish override helper so each negative case is one mutation of `base`. */
const mutate = (patch: Partial<AnyCommandContract>): AnyCommandContract => ({ ...base, ...patch })

describe('the classification lint can say YES before its NO is believed', () => {
  it('passes a fully classified contract', () => {
    expect(classificationErrors(base)).toEqual([])
  })
})

describe('classification totality — each negative is one mutation of the passing contract', () => {
  it.each([
    [
      'an outbox exposure without an offline-eligible delivery class',
      mutate({ exposure: ['outbox'] }),
      /ADR 3 D3 rule 2/,
    ],
    [
      'a secret resource that is not online-sensitive',
      mutate({ policy: { ...base.policy, resource: 'secret' } }),
      /ADR 3 D4 rule 1/,
    ],
    [
      // POD-382, and deliberately ONE-DIRECTIONAL: owned-compute STATE must
      // authorize against the machine, while a machine RESOURCE says nothing about
      // the class of what the command writes — a spawn authorizes against compute
      // and writes a personal session. The two-directional version of this rule
      // fired on `mail.spawnAgent`, which is correctly classified.
      'owned-compute visibility without the machine resource',
      mutate({ visibility: 'owned-compute' }),
      /must name the `machine` resource/,
    ],
    [
      'a machine resource with no declared verb',
      mutate({ policy: { ...base.policy, resource: 'machine' } }),
      /must declare its verb/,
    ],
    [
      'a machine verb on a non-machine resource',
      mutate({ policy: { ...base.policy, machineVerb: 'use' } }),
      /non-machine resource/,
    ],
    [
      'machine `use` that hides unauthorized behind unreachable',
      mutate({
        policy: { ...base.policy, resource: 'machine', machineVerb: 'use' },
        errorConsistency: {
          callerSuppliedTargetId: true,
          invisibleFailsAs: 'nonexistent',
          distinguishesUnauthorizedFromUnreachable: false,
          note: 'a probe',
        },
      }),
      /distinguishable from unreachable/,
    ],
    [
      'an unexplained policy',
      mutate({ policy: { ...base.policy, rationale: '   ' } }),
      /policy.rationale is required/,
    ],
    [
      'an offline class with no reconciliation — the DEFAULTED case this issue forbids',
      mutate({ delivery: { ...base.delivery, outboxReconciliation: '' } }),
      /must be DELIBERATE/,
    ],
    [
      'no apply-time re-authorization answer',
      mutate({ delivery: { ...base.delivery, applyTimeReauthorization: '' } }),
      /ADR 3 D8/,
    ],
    [
      'redaction nobody reviewed',
      mutate({
        redaction: { ...base.redaction, reviewed: false as unknown as true },
      }),
      /explicitly reviewed/,
    ],
    [
      'attribution folded into a routing address',
      mutate({ attribution: { ...base.attribution, wirePlacement: 'folded-into-address' } }),
      /it is a PAIR/,
    ],
    [
      'a separate-field placement that names no key',
      mutate({ attribution: { ...base.attribution, reservedWireKeys: [] } }),
      /must name the reserved wire keys/,
    ],
    [
      'an on-behalf-of human with no actor',
      mutate({ attribution: { ...base.attribution, actor: 'not-applicable' } }),
      /is not an attribution PAIR/,
    ],
    ['version zero', mutate({ version: 0 }), /positive integer/],
    ['an undotted name', mutate({ name: 'send' }), /dotted wire name/],
  ])('rejects %s', (_label, contract, pattern) => {
    const errs = classificationErrors(contract)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.join('\n')).toMatch(pattern)
  })
})

describe('the shipped mail contracts', () => {
  it('are totally classified', () => {
    expect(registryClassificationErrors([...MAIL_CONTRACTS])).toEqual([])
  })

  it('names are unique — a duplicate is a silently shadowed contract', () => {
    const dupes = registryClassificationErrors([...MAIL_CONTRACTS, MAIL_CONTRACTS[0]])
    expect(dupes.join('\n')).toMatch(/duplicate contract name/)
  })

  it('NONE is exposed on the client outbox — mail is durable-queued, not offline-eligible', () => {
    // The decision this issue was told not to default. If a future contract
    // author reads "durable-queued" as "offline-eligible", this fails.
    for (const c of MAIL_CONTRACTS) {
      expect(c.exposure).not.toContain('outbox')
      expect(c.delivery.class).toBe('online-only')
      expect(c.delivery.outboxReconciliation).toMatch(
        /D4 rule 4|never enqueued|Never enqueued|query/,
      )
    }
  })

  it('every mutation carries the attribution PAIR, stamped from the transport', () => {
    for (const c of MAIL_CONTRACTS) {
      expect(c.attribution.actor).toBe('from-capability')
      expect(c.attribution.onBehalfOf).toBe('from-delegation')
      // The recorded wire-shape decision: a separate field, never folded into
      // a routing address.
      expect(c.attribution.wirePlacement).toBe('separate-field')
    }
  })

  it('declares owner and inheritance for everything it CREATES (ADR 9 D5 A4 / O4)', () => {
    const creators = MAIL_CONTRACTS.filter((c) => c.ownership.creates.length > 0)
    // The counterfactual: if spawnAgent ever stopped declaring what it creates,
    // this list would be empty and the loop below would assert nothing.
    expect(creators.map((c) => c.name)).toEqual(['mail.spawnAgent'])
    for (const c of creators) {
      const own = c.ownership as Extract<typeof c.ownership, { owner: unknown }>
      expect(own.owner).toBe('on-behalf-of-human')
      expect(own.inheritanceOnCreate).toBe('parent')
      expect(own.visibility).toBe('personal')
    }
  })

  it('awaitAgent is classified as a WAIT — a write, and it says why', () => {
    const c = MAIL_CONTRACTS.find((x) => x.name === 'mail.awaitAgent')
    expect(c?.policy.action).toBe('write')
    expect(c?.policy.resource).toBe('session')
    expect(c?.policy.rationale).toMatch(/notification-fact claim/)
  })
})
