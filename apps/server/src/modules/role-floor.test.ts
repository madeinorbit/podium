/**
 * THE ROLE-FLOOR DECISION (PDM-294) — what eighteen contracts declared and
 * nothing read.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE HAS TO BE ABLE TO SAY
 * ---------------------------------------------------------------------------
 *
 * PDM-294's census found thirty-one contracts declaring `roleFloor: 'admin'`
 * and thirteen enforcing it. The failure mode that produced that gap is not a
 * missing test — `classification-totality.test.ts` was green throughout, because
 * *a totality test proves every field is classified and proves nothing about
 * whether anything reads the classification*. So a suite that only checks the
 * ADMIN path would pass with the whole gate deleted, and that is the shape this
 * file has to avoid (false-green catalogue, entries 4 and 10).
 *
 * Every case below therefore asserts BOTH ARMS from the same contract: the
 * member refused BY NAME, and the admin served. The table is COMPUTED from the
 * shipped command tables rather than written out beside them — a second
 * hand-kept list is entry 7 — and its length is pinned before the cases run,
 * because an `it.each` over a list that shrank reports a clean pass about
 * nothing (entry 9).
 *
 * THE DECISION IS NOT MOCKED ANYWHERE HERE. `roleFloorFailure` is driven with a
 * real shipped contract and an explicit role; a test that stubbed the permission
 * call would prove nothing about the permission (entry 20). What this file does
 * NOT witness is the WIRING — whether the builder actually calls this — and that
 * is `derived-family.role-floor.test.ts`, over a real store and the real router.
 */

import { ACCOUNT_CONTRACTS, type AnyCommandContract } from '@podium/commands'
import { asSessionId, asUserId, type UserRole } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../command-principal'
import { ACCOUNT_COMMANDS_TRPC } from './accounts/registry'
import { CLOUD_COMMANDS_TRPC } from './cloud/registry'
import {
  AUTH_COMMANDS_TRPC,
  SETUP_COMMANDS_TRPC,
  TELEMETRY_COMMANDS_TRPC,
} from './instance/registry'
import { LOGS_COMMANDS_TRPC } from './logs/registry'
import { PERF_COMMANDS_TRPC } from './perf/commands'
import { assertNoSecretReadFloor, roleFloorFailure, roleFloorIsGated } from './role-floor'

const ALICE = asUserId('user:alice')

/** A human principal. The ROLE is supplied separately on purpose: the gate reads
 *  the live account grade from the store, never the capability's own `role`
 *  field, so a fixture that carried the grade inside the principal would be
 *  asserting on the fixture (entry 14). */
const human: CommandPrincipal = {
  kind: 'user',
  user: ALICE,
  capability: { role: 'worker', scope: { kind: 'owned', userId: ALICE }, actorUser: ALICE, onBehalfOf: ALICE },
}

/** An AGENT delegating from a human — the arm whose rights are its human's, so a
 *  member's agent must be refused exactly where the member is (ADR 9 D5 A1/A2). */
const agent: CommandPrincipal = {
  kind: 'agent',
  agentSessionId: asSessionId('sess-1'),
  onBehalfOf: ALICE,
  capability: { role: 'worker', scope: { kind: 'owned', userId: ALICE }, actorUser: ALICE, onBehalfOf: ALICE },
  chain: [],
}

/**
 * THE FAMILIES SERVED THROUGH `derivedFamilyProcedures` THAT DECLARE AN ADMIN
 * FLOOR, each with the joined table that DECIDES its membership.
 *
 * `modules/instance` is three entries and not one: it serves `setup`, `auth`
 * and `telemetry` through three separate builder calls.
 */
const TABLES: readonly { family: string; table: Record<string, { contract: AnyCommandContract }> }[] = [
  { family: 'accounts', table: ACCOUNT_COMMANDS_TRPC },
  { family: 'cloud', table: CLOUD_COMMANDS_TRPC },
  { family: 'logs', table: LOGS_COMMANDS_TRPC },
  { family: 'perf', table: PERF_COMMANDS_TRPC },
  { family: 'setup', table: SETUP_COMMANDS_TRPC },
  { family: 'auth', table: AUTH_COMMANDS_TRPC },
  { family: 'telemetry', table: TELEMETRY_COMMANDS_TRPC },
]

const ADMIN_FLOOR = TABLES.flatMap(({ family, table }) =>
  Object.entries(table)
    .filter(([, entry]) => entry.contract.policy.roleFloor === 'admin')
    .map(([name, entry]) => ({ qualified: `${family}.${name}`, contract: entry.contract })),
)

const MEMBER_FLOOR = TABLES.flatMap(({ family, table }) =>
  Object.entries(table)
    .filter(([, entry]) => entry.contract.policy.roleFloor === 'member')
    .map(([name, entry]) => ({ qualified: `${family}.${name}`, contract: entry.contract })),
)

describe('the table these cases run over is the shipped one', () => {
  /**
   * NON-VACUITY, pinned before any `it.each` uses the list. A list that silently
   * shrank would report a clean pass about nothing (catalogue entry 9).
   *
   * EIGHTEEN, and the eighteenth is worth naming because the pin caught it. The
   * census counted eighteen admin-floor contracts that nothing enforced, of
   * which SEVENTEEN are served through this builder — `operations.cancel` is the
   * other, and operations hand-writes its procedures and joins them to no
   * contract table. But the builder's own admin-floor set is also eighteen, and
   * it is a DIFFERENT eighteen: it includes `setup.activate`, which was already
   * enforced inside `InstanceService.requireAdmin()`. The two counts coincide by
   * accident, which is exactly the kind of agreement a written-out list is for.
   */
  it('carries every admin-floor contract the derived families declare', () => {
    expect(ADMIN_FLOOR.map((c) => c.qualified).sort()).toEqual([
      'accounts.connect',
      'accounts.disconnect',
      'accounts.login',
      'auth.setLoginRequired',
      'cloud.createAgent',
      'cloud.createMachine',
      'cloud.stop',
      'cloud.wake',
      'logs.setDaemonLevel',
      'logs.setLevel',
      'perf.reset',
      'setup.activate',
      'setup.complete',
      'setup.connect',
      'setup.join',
      'setup.setChannel',
      'telemetry.resetId',
      'telemetry.set',
    ])
  })

  it('also carries member-floor contracts, so the member arm is not vacuous', () => {
    expect(MEMBER_FLOOR.length).toBeGreaterThan(0)
  })
})

describe('the floor is READ, per contract', () => {
  it.each(ADMIN_FLOOR)('$qualified refuses a member and serves an admin', ({ qualified, contract }) => {
    const refusal = roleFloorFailure(qualified, contract, { principal: human, role: 'member' })
    expect(refusal?.code).toBe('FORBIDDEN')
    // BY NAME. A refusal that cannot say which command it refused would pass
    // this suite while telling an operator nothing.
    expect(refusal?.message).toBe(`${qualified} requires an admin account`)

    expect(roleFloorFailure(qualified, contract, { principal: human, role: 'admin' })).toBeUndefined()
  })

  it.each(ADMIN_FLOOR)("$qualified refuses a MEMBER'S AGENT and serves an admin's", ({ qualified, contract }) => {
    expect(roleFloorFailure(qualified, contract, { principal: agent, role: 'member' })?.code).toBe('FORBIDDEN')
    expect(roleFloorFailure(qualified, contract, { principal: agent, role: 'admin' })).toBeUndefined()
  })

  it.each(ADMIN_FLOOR)('$qualified refuses a principal with no account at all', ({ qualified, contract }) => {
    // `undefined` is not a role. An account that cannot act satisfies no floor —
    // the same rule `fleet/authz.ts` and `settings/authz.ts` state.
    expect(roleFloorFailure(qualified, contract, { principal: human, role: undefined })?.code).toBe('FORBIDDEN')
  })

  it.each(MEMBER_FLOOR)('$qualified is untouched by this gate, including with no role', ({ qualified, contract }) => {
    for (const role of ['member', 'admin', undefined] as (UserRole | undefined)[]) {
      expect(roleFloorFailure(qualified, contract, { principal: human, role })).toBeUndefined()
    }
  })
})

describe('the system principal', () => {
  /**
   * Constructed in-process only and unreachable from every transport (ADR 3
   * Amendment 1 D21.2). It has no account, so it satisfies no floor by the role
   * rule — the carve-out is explicit rather than reached by inventing a grade
   * for it, which is the service account ADR 9 D8 S5 rejects.
   */
  it('passes an admin floor despite having no role', () => {
    expect(
      roleFloorFailure('accounts.disconnect', ACCOUNT_CONTRACTS.disconnect as AnyCommandContract, {
        principal: systemPrincipal('pdm-294-test'),
        role: undefined,
      }),
    ).toBeUndefined()
  })
})

describe('this gate can say NO — and can say YES', () => {
  /**
   * Entry 4 of the catalogue: a test that cannot fail for the reason it exists
   * is not a guard. These two prove the suite above would notice a gate that
   * permitted everything AND one that refused everything, without editing the
   * gate to find out.
   */
  it('a gate that permitted everything would fail the refusal arm', () => {
    const permissive = (): undefined => undefined
    expect(permissive()).toBeUndefined()
    // The refusal arm asserts `FORBIDDEN`; a permissive gate answers undefined.
    expect(roleFloorFailure('accounts.connect', ACCOUNT_CONTRACTS.connect as AnyCommandContract, {
      principal: human,
      role: 'member',
    })).not.toBe(permissive())
  })

  it('a gate that refused everything would fail the served arm', () => {
    expect(
      roleFloorFailure('accounts.connect', ACCOUNT_CONTRACTS.connect as AnyCommandContract, {
        principal: human,
        role: 'admin',
      }),
    ).toBeUndefined()
  })
})

describe('roleFloorIsGated', () => {
  it('selects exactly the admin-floor contracts the builder pays a lookup for', () => {
    for (const { contract } of ADMIN_FLOOR) expect(roleFloorIsGated(contract)).toBe(true)
    for (const { contract } of MEMBER_FLOOR) expect(roleFloorIsGated(contract)).toBe(false)
  })
})

describe('a read behind an admin floor on a secret resource refuses to assemble', () => {
  /**
   * The existence-oracle rule (docs/multi-user-readiness.md §3.1.5). No derived
   * contract is this shape today, which is exactly why the case is a BUILD
   * failure rather than a branch in the gate: a branch nothing witnesses is the
   * shape PDM-134 was pulled up for.
   */
  const secretRead = {
    ...(ACCOUNT_CONTRACTS.disconnect as AnyCommandContract),
    policy: { ...(ACCOUNT_CONTRACTS.disconnect as AnyCommandContract).policy, action: 'read' as const },
  } as AnyCommandContract

  it('throws, naming the command and the rule', () => {
    expect(() => assertNoSecretReadFloor('accounts.probe', secretRead)).toThrow(/accounts\.probe/)
    expect(() => assertNoSecretReadFloor('accounts.probe', secretRead)).toThrow(/existence oracle/)
  })

  it('admits every contract the derived families actually ship', () => {
    for (const { qualified, contract } of [...ADMIN_FLOOR, ...MEMBER_FLOOR]) {
      expect(() => assertNoSecretReadFloor(qualified, contract)).not.toThrow()
    }
  })
})
