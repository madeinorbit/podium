/**
 * The `use`-verb check point, at the unit — POD-642.
 *
 * Two implementations of one seam, and the interesting assertions are about the
 * SHAPE OF THE REFUSAL rather than about who wins: `absent` and `unauthorized`
 * are two different disclosures, and readiness §3.1.4 M5 / §3.1.5 decide which
 * one each situation gets. The coordinator-level cases live in
 * `oracle-handoff.test.ts`; these are the ones a two-machine fixture cannot
 * express cheaply, notably an admin-vs-owner-vs-grantee matrix.
 */

import type { MachineId } from '@podium/model'
import type { ResolvedMachine, UserId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { OPERATOR } from '../../../issue-authz'
import { grantedMachineUse, legacyAdminMachineUse, MachineUseDenied } from './access'

const user = (id: string): UserId => id as UserId

const machine = (
  id: string,
  owner: string | null,
  grants: { subject: string; verb: 'see' | 'use' | 'manage' }[] = [],
): ResolvedMachine => ({
  machine: id as MachineId,
  owner: owner === null ? null : user(owner),
  grants: grants.map((grant) => ({ subject: user(grant.subject), verb: grant.verb })),
})

/** The refusal, as `(failure, message)` — asserted as a pair because the failure
 *  kind is what policy decides and the message is what a person reads. */
const refusal = (run: () => void): [string, string] | 'allowed' => {
  try {
    run()
    return 'allowed'
  } catch (error) {
    if (error instanceof MachineUseDenied) return [error.failure, error.message]
    throw error
  }
}

describe("legacy admin backing (what today's fleet can express)", () => {
  const gate = (capability: Parameters<typeof legacyAdminMachineUse>[0]['capability']) =>
    legacyAdminMachineUse({ capability })

  it('an admin-scoped capability may use a paired machine', () => {
    expect(refusal(() => gate(OPERATOR)('m1'))).toBe('allowed')
  })

  it('an admin is allowed a machine id this gate has never heard of — existence is not a rights question', () => {
    // DELIBERATE, and it was a bug before it was a decision: an earlier draft also
    // refused an id that was not in the machine list, which read as defence in
    // depth and actually refused a handoff FROM the local machine on installs
    // whose `local` row is written lazily. Whether the target exists or is
    // reachable is the choreography's answer ('target machine is offline'), pinned
    // by oracle-errors.test.ts; this gate answers only "may this caller use it".
    expect(refusal(() => gate(OPERATOR)('never-seen'))).toBe('allowed')
  })

  it('a constrained capability is refused as ABSENT, not unauthorized — it holds no see either', () => {
    // Both halves matter. Refused: `use` is owner-only until granted and there is
    // no grant list yet (§3.1.4 M1). Spelled `absent`: answering `unauthorized`
    // would confirm m1 exists to a principal with no `see` on it (§3.1.5).
    expect(refusal(() => gate({ role: 'worker', scope: { kind: 'all' } })('m1'))).toEqual([
      'absent',
      "unknown machine 'm1'",
    ])
  })

  it('a subtree-scoped ADMIN is refused: admin over issues is not use on compute', () => {
    // The scope half of the check is load-bearing and easy to drop. An admin role
    // with a constrained scope is not the operator, and machine `use` is not an
    // issue-tracker verb it inherits.
    expect(
      refusal(() => gate({ role: 'admin', scope: { kind: 'subtree', rootId: 'i1' } })('m1')),
    ).toEqual(['absent', "unknown machine 'm1'"])
  })
})

describe('grant-table backing (the shape POD-1079 plugs in)', () => {
  const fleet: Record<string, ResolvedMachine> = {
    'alice-mac': machine('alice-mac', 'alice'),
    'bob-mac': machine('bob-mac', 'bob'),
    'bob-shared': machine('bob-shared', 'bob', [{ subject: 'alice', verb: 'use' }]),
    'bob-visible': machine('bob-visible', 'bob', [{ subject: 'alice', verb: 'see' }]),
    legacy: machine('legacy', null, [{ subject: 'alice', verb: 'use' }]),
  }
  const gate = (subject: string | null, admin = false) =>
    grantedMachineUse({
      subject: () => (subject === null ? null : user(subject)),
      admin: () => admin,
      ownershipOf: (id) => fleet[id],
    })

  it('the owner may use their own machine', () => {
    expect(refusal(() => gate('alice')('alice-mac'))).toBe('allowed')
  })

  it("a use grant is what lets alice run on bob's machine", () => {
    expect(refusal(() => gate('alice')('bob-shared'))).toBe('allowed')
  })

  it('a SEE grant does not imply use — the code-execution boundary (M2)', () => {
    // The whole reason `use` is a separate verb: seeing a machine in a list is a
    // privacy fact, running an agent on it is arbitrary execution on someone
    // else's hardware with their keys. Distinguishable from absent, because alice
    // legitimately knows this machine exists.
    expect(refusal(() => gate('alice')('bob-visible'))).toEqual([
      'unauthorized',
      "not authorized to use machine 'bob-visible'",
    ])
  })

  it("a machine alice cannot see at all is ABSENT, exactly like a nonexistent id", () => {
    const invisible = refusal(() => gate('alice')('bob-mac'))
    const nonexistent = refusal(() => gate('alice')('no-such-machine'))

    expect(invisible).toEqual(['absent', "unknown machine 'bob-mac'"])
    expect(nonexistent).toEqual(['absent', "unknown machine 'no-such-machine'"])
    // The property is that the two are the same KIND of refusal; only the echoed
    // id differs, and the caller supplied that.
    expect(invisible[0]).toBe(nonexistent[0])
  })

  it('an OWNER-LESS machine grants use to nobody, even a grant holder — the all-in-one guard', () => {
    // `machineUseAllowed`'s rule, reached through this gate rather than restated:
    // on an all-in-one install the `local` daemon IS the host, and a legacy row
    // with no owner must not be ambient team compute (§3.1.4 M4). Note the row
    // even carries an explicit `use` grant for alice and is still refused — so
    // this asserts the owner-null clause and not just a missing grant.
    expect(refusal(() => gate('alice')('legacy'))).toEqual([
      'unauthorized',
      "not authorized to use machine 'legacy'",
    ])
  })

  it('an admin SEES every machine but does not thereby USE it', () => {
    // M1: admins hold see and manage for fleet management; `use` stays with the
    // owner. So an admin's refusal on someone else's machine is `unauthorized`
    // (they may see it) rather than `absent`.
    expect(refusal(() => gate('carol', true)('bob-mac'))).toEqual([
      'unauthorized',
      "not authorized to use machine 'bob-mac'",
    ])
    // And an admin still cannot see a machine that does not exist.
    expect(refusal(() => gate('carol', true)('no-such-machine'))).toEqual([
      'absent',
      "unknown machine 'no-such-machine'",
    ])
  })

  it('no subject at all (an unauthenticated or user-less principal) is refused everywhere', () => {
    expect(refusal(() => gate(null)('alice-mac'))).toEqual([
      'absent',
      "unknown machine 'alice-mac'",
    ])
  })

  it('rights are re-read on EVERY call, so a revocation between two calls takes effect', () => {
    // This is what makes the coordinator's apply-time checkpoints mean something:
    // if the gate captured its answer, the second call below would still pass and
    // the mid-transfer revocation test would be asserting nothing.
    let subject: string | null = 'alice'
    const live = grantedMachineUse({
      subject: () => (subject === null ? null : user(subject)),
      admin: () => false,
      ownershipOf: (id) => fleet[id],
    })

    expect(refusal(() => live('alice-mac'))).toBe('allowed')
    subject = 'bob'
    expect(refusal(() => live('alice-mac'))).toEqual(['absent', "unknown machine 'alice-mac'"])
  })
})
