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
  CONTRACT_CONFLICT_CLASSES,
  type ContractConflictClass,
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
  // POD-1250: required, so the positive control has to answer. `n/a` is the
  // honest answer for a probe that writes nothing, and it keeps this control
  // clear of the `cmd` pair the cases below mutate it into.
  conflict: 'n/a',
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
      // M5 applies where the caller can NAME a machine, which is the `machine`
      // resource. The second-axis case (a verb on a session/none resource) is the
      // POSITIVE control below — it is legal, and asserting it here as an error is
      // what POD-640 had to correct.
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
    // ---- ADR 1, the conflict declaration (POD-1250) ----
    [
      'a `cmd` class with no rule — the row arbitration.ts refuses to arbitrate',
      mutate({ conflict: 'cmd' }),
      /requires conflictRule/,
    ],
    [
      'a `cmd` class whose rule is whitespace',
      mutate({ conflict: 'cmd', conflictRule: '   ' }),
      /requires conflictRule/,
    ],
    [
      'a rule attached to a class that nothing reads it for',
      mutate({ conflict: 'append', conflictRule: 'a rule nobody consults' }),
      /`cmd` rows only/,
    ],
    [
      'a conflict class outside the vocabulary',
      mutate({ conflict: 'whole-aggregate-LWW' as ContractConflictClass }),
      /no safe default/,
    ],
    [
      'an absent conflict class — the state POD-1250 removed, still caught semantically',
      mutate({ conflict: undefined as unknown as ContractConflictClass }),
      /no safe default/,
    ],
    [
      '`exp-rev` on an input with nowhere to put the revision',
      mutate({ conflict: 'exp-rev' }),
      /requires an `expectedRevision`/,
    ],
    [
      '`n/a` on a command that creates entities',
      mutate({
        conflict: 'n/a',
        ownership: {
          creates: ['widget'],
          owner: 'on-behalf-of-human',
          visibility: 'personal',
          inheritanceOnCreate: 'on-behalf-of-human',
          note: 'a probe',
        },
      }),
      /contradicts ownership\.creates/,
    ],
    [
      '`n/a` on a command queued in the client Outbox',
      mutate({
        conflict: 'n/a',
        exposure: ['outbox'],
        delivery: { ...base.delivery, class: 'offline-eligible' },
      }),
      /contradicts `outbox` exposure/,
    ],
  ])('rejects %s', (_label, contract, pattern) => {
    const errs = classificationErrors(contract)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.join('\n')).toMatch(pattern)
  })
})

/**
 * THE CONFLICT DECLARATION'S POSITIVE CONTROLS (POD-1250).
 *
 * The negatives above prove the checks FIRE. These prove they are not simply
 * always-on — a check that rejected every conflict declaration would satisfy
 * every case in the table above and still be worthless. Each case here is a
 * declaration the fleet actually contains.
 */
describe('the conflict declaration accepts what the fleet actually declares', () => {
  it('accepts `cmd` WITH its rule — the pair, which is the only legal `cmd`', () => {
    expect(
      classificationErrors(mutate({ conflict: 'cmd', conflictRule: 'first decision settles it' })),
    ).toEqual([])
  })

  it('accepts a ruleless class, which is every class but `cmd`', () => {
    for (const cls of ['append', 'single-writer', 'field-LWW', 'op-stream', 'n/a'] as const) {
      expect(classificationErrors(mutate({ conflict: cls }))).toEqual([])
    }
  })

  it('accepts `exp-rev` once the input can carry the revision it arbitrates on', () => {
    expect(
      classificationErrors(
        mutate({
          conflict: 'exp-rev',
          input: z.object({ x: z.string(), expectedRevision: z.number() }),
        }),
      ),
    ).toEqual([])
  })

  it('sees through the wrappers the tables use — .merge() and .optional()', () => {
    const merged = z.object({ x: z.string() }).merge(z.object({ expectedRevision: z.number() }))
    expect(classificationErrors(mutate({ conflict: 'exp-rev', input: merged }))).toEqual([])
    expect(classificationErrors(mutate({ conflict: 'exp-rev', input: merged.optional() }))).toEqual(
      [],
    )
  })

  it('lists every member of the vocabulary — a class the type admits and the list omits', () => {
    // The type-level tripwire in `contract.ts` is the real guard; this is its
    // runtime witness, and it fails if a seventh class is added to the union
    // without being added to the checked list.
    // Two classes carry a further requirement of their own, so a bare
    // declaration of them is EXPECTED to complain — and naming which is part of
    // the witness: a check that had stopped firing would show up here as an
    // empty array where a message belongs.
    const furtherRequirement: Partial<Record<ContractConflictClass, RegExp>> = {
      cmd: /requires conflictRule/,
      'exp-rev': /requires an `expectedRevision`/,
    }
    for (const cls of CONTRACT_CONFLICT_CLASSES) {
      const errs = classificationErrors(mutate({ conflict: cls }))
      const expected = furtherRequirement[cls]
      if (expected === undefined) expect(errs, cls).toEqual([])
      else expect(errs.join('\n'), cls).toMatch(expected)
    }
  })
})

/**
 * THE SECOND AXIS (POD-640, closing POD-1179).
 *
 * `machineVerb` is a second axis on the policy, NOT a synonym for
 * `resource: 'machine'` — `framework.ts` says so on `CommandPolicy.machineVerb`
 * and the shipped session command plane depends on it (`sessions.sendText` is
 * `resource: 'session'` AND `machineVerb: 'use'`). The lint used to reject that
 * shape, which would have forced a command that both writes a row and executes on
 * compute to lie about one of the two.
 *
 * These are POSITIVE controls, so they need the negatives beside them or they
 * would pass against a lint that had simply been deleted — hence the third case,
 * which proves the surviving direction still fires.
 */
describe('machineVerb is a SECOND axis, not a restatement of the resource', () => {
  it('accepts `use` on a non-machine resource — the sessions-plane shape', () => {
    expect(
      classificationErrors(
        mutate({ policy: { ...base.policy, resource: 'session', machineVerb: 'use' } }),
      ),
    ).toEqual([])
  })

  it('accepts `use` on a non-machine resource that does NOT distinguish unauthorized from unreachable', () => {
    // The mail shape: D20.2 requires invisible to read as nonexistent, and M5
    // must not contradict it where the caller cannot name a machine to probe.
    expect(
      classificationErrors(
        mutate({
          policy: { ...base.policy, resource: 'session', machineVerb: 'use' },
          errorConsistency: {
            callerSuppliedTargetId: true,
            invisibleFailsAs: 'nonexistent',
            distinguishesUnauthorizedFromUnreachable: false,
            note: 'a probe',
          },
        }),
      ),
    ).toEqual([])
  })

  it('STILL requires a verb when the resource IS the machine — the direction that survives', () => {
    // Without this, the two cases above would be equally satisfied by a lint with
    // no machine rules at all.
    expect(
      classificationErrors(mutate({ policy: { ...base.policy, resource: 'machine' } })).join('\n'),
    ).toMatch(/must declare its verb/)
  })

  it('STILL enforces M5 when the caller can name the machine', () => {
    expect(
      classificationErrors(
        mutate({
          policy: { ...base.policy, resource: 'machine', machineVerb: 'use' },
          errorConsistency: {
            callerSuppliedTargetId: true,
            invisibleFailsAs: 'nonexistent',
            distinguishesUnauthorizedFromUnreachable: false,
            note: 'a probe',
          },
        }),
      ).join('\n'),
    ).toMatch(/distinguishable from unreachable/)
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
