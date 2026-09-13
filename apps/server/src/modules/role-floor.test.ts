/**
 * THE ROLE-FLOOR DECISION (PDM-294) — what eighteen contracts declared and
 * nothing read, and (PDM-302) what happens to this suite when one of them
 * legitimately moves.
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

import { ACCOUNT_CONTRACTS, type AnyCommandContract, SETUP_CONTRACTS } from '@podium/commands'
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

/**
 * An AGENT delegating from a human.
 *
 * Its capability carries `role: 'worker'`, which is what BOTH shipped mints
 * actually produce for a live agent session — `relay.ts`'s
 * `capabilityForLiveSession` and `SessionAuthz.capabilityForSession`, six return
 * statements between them and not one that can say `admin`. See
 * `agent-capability-mint.test.ts`, which pins that.
 *
 * THE ROLE IS SUPPLIED SEPARATELY, as for {@link human}, and for this principal
 * that is the whole point of the file: the `role` argument below is the
 * DELEGATING HUMAN'S live account grade, so passing `'admin'` constructs the
 * discriminating case — an ADMIN'S agent — which is the only fixture that can
 * tell PDM-299's rule from the absence of one.
 */
const agent: CommandPrincipal = {
  kind: 'agent',
  agentSessionId: asSessionId('sess-1'),
  onBehalfOf: ALICE,
  capability: { role: 'worker', scope: { kind: 'owned', userId: ALICE }, actorUser: ALICE, onBehalfOf: ALICE },
  chain: [],
}

/**
 * THE SAME AGENT WEARING AN ADMIN CAPABILITY — a principal no shipped mint can
 * produce, constructed on purpose.
 *
 * Why a fixture for an impossible capability is not entry 14 but its cure: the
 * gate must refuse an agent because a RULE refuses it, not because no transport
 * happens to hand it the value the rule compares against. `operations`'
 * pre-PDM-299 check was exactly that — `capability.role !== 'admin'` over a
 * field hard-coded to `worker` — and it would have gone on passing every
 * "an agent is refused" assertion with the rule deleted.
 *
 * So this principal separates the two. If the decision ever goes back to reading
 * the capability, this fixture is PERMITTED and the assertion below fails.
 */
const agentWearingAdminCapability: CommandPrincipal = {
  ...agent,
  capability: { role: 'admin', scope: { kind: 'all' }, actorUser: ALICE, onBehalfOf: ALICE },
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
   * SIXTEEN SINCE PDM-302, and the arithmetic is worth keeping because the pin is
   * what makes a floor change loud. It was EIGHTEEN under PDM-294, and that
   * eighteen was already a coincidence worth distrusting: the census counted
   * eighteen admin-floor contracts that nothing enforced, of which SEVENTEEN are
   * served through this builder (`operations.cancel` is the other, and operations
   * hand-writes its procedures and joins them to no contract table), while the
   * builder's own admin-floor set was a DIFFERENT eighteen that included
   * `setup.activate` — already enforced inside `InstanceService.requireAdmin()`.
   * Two counts agreeing by accident is exactly what a written-out list is for.
   *
   * PDM-302 dropped `accounts.connect` and `accounts.disconnect` to `member`
   * once PDM-280 keyed managed credentials per person, so they leave this list
   * and join MEMBER_FLOOR below. `accounts.login` STAYS — it writes the host's
   * shared native CLI store, not a per-person row — so the family is split on
   * purpose and this list is where that split is asserted rather than described.
   */
  it('carries every admin-floor contract the derived families declare', () => {
    expect(ADMIN_FLOOR.map((c) => c.qualified).sort()).toEqual([
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

/**
 * THE ACCOUNTS FAMILY IS SPLIT ON PURPOSE (PDM-302).
 *
 * The derived lists above already redden if a grade moves, but they say it as
 * an arithmetic difference in an eighteen-line array. These three say it by
 * name, because the risk this change carries is not a wrong list — it is a
 * later reader meeting a weakened floor on a credential write and restoring it.
 *
 * The reason lives in the contracts' own rationales. In one line: PDM-280 keyed
 * managed credentials `(owner_user_id, id)`, so `connect` and `disconnect`
 * became per-entity writes; `login` drives the host's SHARED native CLI store
 * and did not.
 */
describe('the accounts credential writes are member-floor and login is not', () => {
  it.each([
    ['connect', ACCOUNT_CONTRACTS.connect],
    ['disconnect', ACCOUNT_CONTRACTS.disconnect],
  ] as const)('accounts.%s is member-floor, so this gate does not consult it', (name, contract) => {
    expect(contract.policy.roleFloor).toBe('member')
    expect(roleFloorIsGated(contract as AnyCommandContract)).toBe(false)
    // Both grades and no grade at all are served identically — the gate is not
    // merely lenient to members, it is out of the way. A member with no account
    // row is the case an instance in open mode actually produces.
    for (const role of ['member', 'admin', undefined] as (UserRole | undefined)[]) {
      expect(
        roleFloorFailure(`accounts.${name}`, contract as AnyCommandContract, { principal: human, role }),
      ).toBeUndefined()
    }
  })

  it('accounts.login did NOT move, and a harmonizing edit must fail here', () => {
    expect(ACCOUNT_CONTRACTS.login.policy.roleFloor).toBe('admin')
    expect(
      roleFloorFailure('accounts.login', ACCOUNT_CONTRACTS.login as AnyCommandContract, {
        principal: human,
        role: 'member',
      })?.code,
    ).toBe('FORBIDDEN')
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

  /**
   * PDM-299: AN AGENT IS REFUSED AN ADMIN FLOOR WHOEVER IT ACTS FOR.
   *
   * This assertion used to read "refuses a MEMBER'S agent and serves an ADMIN'S"
   * — the delegating human's live store role decided, so an admin's agent was
   * permitted. PDM-107's coordinator ruled the other way and the argument is in
   * `role-floor.ts`'s header: narrowing later is a regression, widening later is
   * a deliberate act with a mechanism that already exists (ADR 9 D5 A2's
   * `--outside-scope` → `confirm-required` path), so the closed answer is the
   * one to take while almost no agent transport reaches these families.
   *
   * THE ADMIN'S AGENT IS THE DISCRIMINATING CASE and it is why both arms are
   * here. "An agent is refused" with `role: 'member'` alone would pass against a
   * gate that had never heard of delegation, because a member is refused anyway.
   * Only the `'admin'` arm fails on the unfixed line.
   */
  it.each(ADMIN_FLOOR)("$qualified refuses an agent whoever it acts for", ({ qualified, contract }) => {
    expect(roleFloorFailure(qualified, contract, { principal: agent, role: 'member' })?.code).toBe('FORBIDDEN')

    // THE ONE THAT FAILS ON THE UNFIXED LINE.
    const adminsAgent = roleFloorFailure(qualified, contract, { principal: agent, role: 'admin' })
    expect(adminsAgent?.code).toBe('FORBIDDEN')
    // BY REASON, not merely by refusal. A refusal saying "requires an admin
    // account" to an agent whose human IS an admin would send its operator to
    // check an account that is already correct.
    expect(adminsAgent?.message).toBe(
      `${qualified} requires an admin account — and an agent does not inherit its human's admin grade`,
    )
  })

  /**
   * THE CAPABILITY IS NOT WHAT DECIDES, and this is the arm that proves the
   * refusal above is a rule rather than an artefact of the mint.
   *
   * See {@link agentWearingAdminCapability}. Against a gate that compared
   * `capability.role` this principal is permitted; against PDM-299's rule it is
   * refused identically to every other agent.
   */
  it.each(ADMIN_FLOOR)(
    "$qualified refuses an agent even wearing an admin CAPABILITY — the rule refuses it, not the mint",
    ({ qualified, contract }) => {
      for (const role of ['admin', 'member'] as const) {
        expect(
          roleFloorFailure(qualified, contract, {
            principal: agentWearingAdminCapability,
            role,
          })?.code,
        ).toBe('FORBIDDEN')
      }
    },
  )

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
   *
   * THE SUBJECT MUST BE AN ADMIN-FLOOR CONTRACT, AND IT IS PINNED BELOW RATHER
   * THAN TRUSTED. This case used to run on `accounts.disconnect`. PDM-302
   * dropped that contract to `member`, and at a `member` floor `roleFloorFailure`
   * returns `undefined` from the `case 'member'` branch — so the assertion would
   * have gone on PASSING while witnessing nothing about the carve-out it exists
   * to prove. That is false-green catalogue entry 14, arriving silently: the
   * three other places pinning that value all reddened, and this one would not
   * have. `setup.complete` is the subject now, and the `expect` on its floor is
   * what stops the same thing happening the next time a grade moves.
   */
  it('passes an admin floor despite having no role', () => {
    // NON-VACUITY. Without this line the case below is satisfied by any floor.
    expect(SETUP_CONTRACTS.complete.policy.roleFloor).toBe('admin')
    expect(
      roleFloorFailure('setup.complete', SETUP_CONTRACTS.complete as AnyCommandContract, {
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
   *
   * BOTH RAN ON `accounts.connect` AND BOTH HAD TO MOVE WITH PDM-302, though
   * only one of them would have said so. At a `member` floor the refusal arm
   * below fails loudly — `roleFloorFailure` answers `undefined`, which is what
   * `permissive()` answers, so `.not.toBe` fails. The SERVED arm does not: it
   * asserts `undefined`, and a `member`-floor contract returns `undefined`
   * whoever asks, so it would have kept passing without exercising the admin
   * path at all. The epic's brief recorded this pair as loud; half of it was
   * silent, the same shape as the system-principal case above. `setup.complete`
   * is the subject for both, with its floor pinned so the next move is loud.
   */
  it('a gate that permitted everything would fail the refusal arm', () => {
    expect(SETUP_CONTRACTS.complete.policy.roleFloor).toBe('admin')
    const permissive = (): undefined => undefined
    expect(permissive()).toBeUndefined()
    // The refusal arm asserts `FORBIDDEN`; a permissive gate answers undefined.
    expect(roleFloorFailure('setup.complete', SETUP_CONTRACTS.complete as AnyCommandContract, {
      principal: human,
      role: 'member',
    })).not.toBe(permissive())
  })

  it('a gate that refused everything would fail the served arm', () => {
    expect(SETUP_CONTRACTS.complete.policy.roleFloor).toBe('admin')
    expect(
      roleFloorFailure('setup.complete', SETUP_CONTRACTS.complete as AnyCommandContract, {
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
  // `setup.complete` rather than `accounts.disconnect`, which carried this
  // fixture until PDM-302 dropped it to `member`: the guard only fires on
  // `admin` + `read` + `secret`, so a member-floor base would have made the two
  // `toThrow` assertions below fail. LOUD, unlike the two witnesses above, but
  // it is the fourth place in this file that pinned the accounts floor and the
  // brief listed three. Both properties it needs are pinned on the next line.
  const secretBase = SETUP_CONTRACTS.complete as AnyCommandContract
  const secretRead = {
    ...secretBase,
    policy: { ...secretBase.policy, action: 'read' as const },
  } as AnyCommandContract

  it('throws, naming the command and the rule', () => {
    expect(secretBase.policy.roleFloor).toBe('admin')
    expect(secretBase.policy.resource).toBe('secret')
    expect(() => assertNoSecretReadFloor('accounts.probe', secretRead)).toThrow(/accounts\.probe/)
    expect(() => assertNoSecretReadFloor('accounts.probe', secretRead)).toThrow(/existence oracle/)
  })

  it('admits every contract the derived families actually ship', () => {
    for (const { qualified, contract } of [...ADMIN_FLOOR, ...MEMBER_FLOOR]) {
      expect(() => assertNoSecretReadFloor(qualified, contract)).not.toThrow()
    }
  })
})
