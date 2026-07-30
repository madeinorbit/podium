/**
 * THE L1 GATE OVER THE FOUR AUTOMATION CONTRACTS (POD-735).
 *
 * Written against the failure class that dominated this run — suites that cannot
 * say NO — and this family carries the sharpest instance of it that the fan-out
 * has produced:
 *
 * `visibility: 'personal'` IS ALSO WHAT THE BACKSTOP ANSWERS FOR A ROW NOBODY EVER
 * CLASSIFIED. `visibilityClassOf` is total and default-closed (ADR 9 D4), so
 * `visibilityClassOf('a-row-that-does-not-exist')` returns `personal` too. A test
 * comparing this contract to that lookup would therefore pass in a world where the
 * `automations-and-runs` row had been deleted, where it had never been written, and
 * where it had been renamed — three different failures, all reported green. The
 * spec family (POD-385) escaped this only because its answer happened to be
 * `owned-compute`, which the default cannot reach.
 *
 * So the matrix test below does NOT rest on the lookup. It binds to the DECLARED
 * ROW OBJECT, asserts the declaration is present by identity, and then demonstrates
 * the backstop's blindness explicitly — the same call under an empty index returns
 * the same answer — so that the reason this file is trustworthy is written down
 * rather than assumed.
 */

import { type MatrixRow, OWNERSHIP_MATRIX, visibilityClassOf } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from '../contract'
import {
  AUTOMATION_CONTRACT_NAMES,
  AUTOMATION_CONTRACTS,
  AUTOMATION_QUERY_NAMES,
  type AutomationContractName,
  automationCreateInput,
  automationPatchInput,
  automationSetEnabledInput,
} from './contracts'
import { MIN_SCHEDULE_INTERVAL_MS, minIntervalMs, parseCron, respectsScheduleFloor } from './cron'

/** The matrix row every automation write lands in. One string, so a typo cannot
 *  make one assertion pass against a different row. */
const AUTOMATION_ROW = 'automations-and-runs'

/** The declared row itself, or `undefined` — the thing the lookup CANNOT tell you
 *  apart from its own default. */
const declaredRow = (id: string): MatrixRow | undefined =>
  OWNERSHIP_MATRIX.find((row) => (row.id as string) === id)

/** An index with nothing in it: the counterfactual world in which the row was
 *  never written. The REAL function under a real absence, not a restatement of
 *  what its default is supposed to be. */
const EMPTY_INDEX = new Map<string, MatrixRow>()

const contracts = (): AnyCommandContract[] =>
  Object.values(AUTOMATION_CONTRACTS).map((c) => c as AnyCommandContract)

const FOUR: readonly AutomationContractName[] = ['create', 'remove', 'setEnabled', 'update']

describe('the four automation write contracts', () => {
  it('declares exactly create · update · setEnabled · remove, and no fifth', () => {
    expect(AUTOMATION_CONTRACT_NAMES).toEqual([...FOUR])
    expect(
      Object.values(AUTOMATION_CONTRACTS)
        .map((c) => c.name)
        .sort(),
    ).toEqual([
      'automations.create',
      'automations.remove',
      'automations.setEnabled',
      'automations.update',
    ])
    // The reads are NOT contracts and are named as such — an unlisted query would
    // read to the cutover audit as a procedure nobody declared.
    expect([...AUTOMATION_QUERY_NAMES]).toEqual(['list', 'runs'])
  })

  it('passes the classification lint with no unclassified field', () => {
    expect(registryClassificationErrors(contracts())).toEqual([])
  })

  /**
   * THE INSTRUMENT PROBE for the assertion above, aimed at the rule this family
   * is most likely to be broken on: ADR 3 Amendment 1 D18.3. A cron definition is
   * durable config that looks perfectly queueable, and ADR 1 §7's own column says
   * "defs offline-eligible" — so the next author has a written reason to make
   * exactly this change.
   */
  it('reports a defect when there is one — so the empty list above means something', () => {
    const queued = {
      ...(AUTOMATION_CONTRACTS.setEnabled as AnyCommandContract),
      delivery: { ...AUTOMATION_CONTRACTS.setEnabled.delivery, class: 'offline-eligible' },
    } as AnyCommandContract
    // The mutant CHANGED the value: a perturbation to what a field already held
    // applies cleanly, changes nothing and reads as a pass (POD-311).
    expect(AUTOMATION_CONTRACTS.setEnabled.delivery.class).toBe('online-only')
    expect(classificationErrors(queued)).toEqual([
      'automations.setEnabled: machine `use` executes on someone else’s hardware and may not be offline-eligible (ADR 3 Amendment 1 D18.3) — name it in MACHINE_USE_OFFLINE_EXCEPTIONS if it genuinely is one',
    ])
  })

  /**
   * THE MATRIX BINDING — the test that could most easily have been vacuous here.
   * See the file header: `personal` is the backstop's answer as well as this
   * row's, so agreement with `visibilityClassOf` proves nothing on its own.
   */
  it('agrees with ADR 1’s DECLARED matrix row, not with the default that looks like it', () => {
    const row = declaredRow(AUTOMATION_ROW)
    // 1. The declaration EXISTS. This is the assertion the lookup cannot make.
    expect(row, `${AUTOMATION_ROW} must be a declared matrix row`).toBeDefined()
    // 2. The contracts agree with the ROW's own field, read off the declaration.
    for (const contract of contracts()) {
      expect([contract.name, contract.visibility]).toEqual([contract.name, row?.visibility])
    }
    expect(row?.visibility).toBe('personal')
    // 3. THE BLINDNESS, DEMONSTRATED. The same lookup answers `personal` for this
    //    row and for a row that was never written — which is why steps 1 and 2 do
    //    the work here instead of a comparison against the lookup.
    expect(visibilityClassOf(AUTOMATION_ROW)).toBe('personal')
    expect(visibilityClassOf(AUTOMATION_ROW, EMPTY_INDEX)).toBe('personal')
    expect(visibilityClassOf('automations-and-runs-that-never-existed')).toBe('personal')
    // 4. …and the row-identity check DOES say no, so step 1 is not a check that
    //    passes for anything.
    expect(declaredRow('automations-and-runs-that-never-existed')).toBeUndefined()
  })

  /**
   * ADR 9 D8 S6's consequence, which the matrix row records and which is the
   * interesting half of this family's classification: revocation must reach a
   * schedule that outlives the session that wrote it.
   */
  it('carries the row’s account-disable verb into the apply-time re-authorization', () => {
    const row = declaredRow(AUTOMATION_ROW)
    expect(row?.visibilityMutability.verbs).toContain('account-disable')
    for (const contract of contracts()) {
      // The claim is about the FIRE, not only about the call — an automation is
      // long-lived and unattended, so a re-auth clause that only spoke about
      // enqueue-to-drain would miss the window that matters.
      expect([contract.name, contract.delivery.applyTimeReauthorization]).toEqual([
        contract.name,
        expect.stringContaining('AT EVERY FIRE'),
      ])
      expect([contract.name, contract.delivery.applyTimeReauthorization]).toEqual([
        contract.name,
        expect.stringContaining('D8 S6'),
      ])
    }
  })

  it('names a real matrix row as the thing `create` creates', () => {
    expect(AUTOMATION_CONTRACTS.create.ownership.creates).toEqual(['automation'])
    // `creates` is prose nothing else checks; an entity name matching no row would
    // read as a classification while pointing nowhere.
    expect(OWNERSHIP_MATRIX.some((r) => r.sites.some((s) => s.includes('automation')))).toBe(true)
    // The counterfactual: the other three mint nothing, and say so.
    for (const name of ['update', 'setEnabled', 'remove'] as const) {
      expect([name, AUTOMATION_CONTRACTS[name].ownership.creates]).toEqual([name, []])
    }
  })
})

describe('operator-only, declared rather than left to an omission', () => {
  it('declares `operatorOnly` on all four and serves the one wired arm', () => {
    for (const [name, contract] of Object.entries(AUTOMATION_CONTRACTS)) {
      expect([name, contract.operatorOnly]).toEqual([name, true])
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc']])
    }
  })

  /**
   * The agent transports, absent. The REACH half of this claim — that the relay
   * actually refuses `automations.*` — cannot be made in this package, because a
   * table cannot see what a server serves; it is made against the REAL
   * `AgentRelayGate` in `apps/server/src/automation-cutover.audit.test.ts`, with a
   * positive control so a gate that refuses everything cannot pass for one that
   * refuses this.
   */
  it('names none of relay, cli, mcp or outbox — and `includes` still says yes to trpc', () => {
    for (const contract of contracts()) {
      for (const tag of ['relay', 'cli', 'mcp', 'outbox'] as const) {
        expect([contract.name, tag, contract.exposure.includes(tag)]).toEqual([
          contract.name,
          tag,
          false,
        ])
      }
      // The counterfactual: `false` above is a decision, not a property of the
      // array — the identical call resolves true for the tag that IS named.
      expect([contract.name, contract.exposure.includes('trpc')]).toEqual([contract.name, true])
    }
  })

  /**
   * D3 rule 2, shown firing. `outbox` absence above is an omission claim; this is
   * the check that would have caught someone adding it back, and it proves the
   * lint can say YES about this family's own contracts rather than in principle.
   */
  it('would be rejected by the lint if it listed `outbox`', () => {
    const queued = {
      ...(AUTOMATION_CONTRACTS.create as AnyCommandContract),
      exposure: ['trpc', 'outbox'],
    } as AnyCommandContract
    expect(AUTOMATION_CONTRACTS.create.exposure).not.toContain('outbox')
    expect(classificationErrors(queued)).toContain(
      'automations.create: exposed on `outbox` without an offline-eligible delivery class (ADR 3 D3 rule 2)',
    )
  })
})

describe('the two gates — the row gate and the execution gate', () => {
  it('declares machine `use` on every write, with the row gate kept separate', () => {
    for (const contract of contracts()) {
      expect([contract.name, contract.policy.machineVerb]).toEqual([contract.name, 'use'])
      expect([contract.name, contract.policy.resource]).toEqual([contract.name, 'session'])
      expect([contract.name, contract.policy.action]).toEqual([contract.name, 'write'])
      expect([contract.name, contract.policy.roleFloor]).toEqual([contract.name, 'member'])
    }
    // `remove` is the one destructive member and is the only one confirmed.
    expect(AUTOMATION_CONTRACTS.remove.policy.confirmation).toBe('confirm')
    for (const name of ['create', 'update', 'setEnabled'] as const) {
      expect([name, AUTOMATION_CONTRACTS[name].policy.confirmation]).toEqual([name, 'none'])
    }
  })

  /**
   * The asymmetry `classificationErrors` records, checked rather than assumed:
   * a `machine` RESOURCE must declare a verb, but a verb does NOT imply a machine
   * resource (POD-640's correction). This family relies on the second direction —
   * execution gate `use`, row gate the automation's owner.
   *
   * AND THE MUTANT BELOW IS WHY IT IS NOT MERELY A PREFERENCE. Moving the row gate
   * onto `machine` makes readiness §3.1.4 M5 apply, which would demand this family
   * keep "not yours" DISTINGUISHABLE from "not reachable" — a distinction it
   * cannot honestly make, because no automation command names a machine (every
   * occurrence runs on the server host) and Amendment 1 D20.2 wants the opposite.
   * The lint says so out loud, which is the evidence that `session` is a
   * classification rather than a convenience.
   */
  it('is legal precisely because the verb does not imply the resource', () => {
    const asMachine = {
      ...(AUTOMATION_CONTRACTS.setEnabled as AnyCommandContract),
      policy: { ...AUTOMATION_CONTRACTS.setEnabled.policy, resource: 'machine' },
    } as AnyCommandContract
    // The mutant changed the value it claims to have changed.
    expect(AUTOMATION_CONTRACTS.setEnabled.policy.resource).toBe('session')
    expect(classificationErrors(asMachine)).toEqual([
      'automations.setEnabled: machine `use` must keep unauthorized distinguishable from unreachable (readiness §3.1.4 M5)',
    ])
    // …and a machine resource that forgets its verb is caught too (Amendment 1
    // D18), so the verb declared above is one the lint would miss the absence of.
    const machineNoVerb = {
      ...asMachine,
      policy: { ...asMachine.policy, machineVerb: undefined },
    } as AnyCommandContract
    expect(classificationErrors(machineNoVerb)).toEqual([
      'automations.setEnabled: a `machine` resource must declare its verb (ADR 3 Amendment 1 D18)',
    ])
  })
})

describe('the input schemas — the shipped validation, moved and not re-specified', () => {
  const parse = (payload: unknown) => automationCreateInput.safeParse(payload)
  const CRON_BASE = {
    name: 'Nightly sweep',
    agentKind: 'claude-code',
    prompt: 'Sweep the tree',
    cron: '0 3 * * *',
  }
  const ONCE_BASE = {
    name: 'Wake me',
    agentKind: 'claude-code',
    prompt: 'Check the deploy',
    scheduleKind: 'once',
    runAt: '2099-01-01T09:00:00.000Z',
  }

  it('accepts the two shapes the composer sends', () => {
    expect(parse(CRON_BASE).success).toBe(true)
    expect(parse(ONCE_BASE).success).toBe(true)
    // The global arm: no repoPath at all, which means the home directory.
    expect(parse({ ...CRON_BASE, repoPath: null }).success).toBe(true)
  })

  /** The one-off wake type's own validation (f3423088), all four messages. */
  it('enforces the one-off arm’s field rules with the shipped messages', () => {
    const messages = (payload: unknown): string[] => {
      const result = parse(payload)
      return result.success ? [] : result.error.issues.map((i) => i.message)
    }
    expect(messages({ ...ONCE_BASE, runAt: undefined })).toContain('required for one-off')
    expect(messages({ ...ONCE_BASE, cron: '0 3 * * *' })).toContain('not valid for one-off')
    expect(messages({ ...CRON_BASE, runAt: '2099-01-01T09:00:00.000Z' })).toContain(
      'not valid for cron',
    )
    expect(messages({ ...CRON_BASE, cron: 'not a cron' })).toContain(
      'invalid cron expression — 5 fields: minute hour day month weekday',
    )
    expect(messages({ ...CRON_BASE, cron: '* * * * *' })).toEqual([])
  })

  /**
   * THE RATE FLOOR'S REFUSING ARM IS UNREACHABLE FROM THIS SCHEMA, AND THAT IS A
   * PROPERTY OF THE GRAMMAR RATHER THAN A BUG — pinned here rather than papered
   * over with a test that pretends otherwise.
   *
   * Five-field cron has MINUTE granularity, so the tightest gap any valid
   * expression can produce is exactly `MIN_SCHEDULE_INTERVAL_MS`, and
   * `respectsScheduleFloor` therefore answers `true` for every expression that
   * parses. `cron.ts`'s own header says so ("every valid expression satisfies this
   * floor; keeping the invariant explicit protects the boundary if richer
   * schedules arrive later"), and the honest thing is to assert the invariant
   * instead of asserting a refusal the grammar cannot produce.
   *
   * So this test proves two things and claims nothing else: the floor's threshold
   * is genuinely at one minute (the densest legal cron sits exactly ON it, not
   * above it, so a floor raised to two minutes WOULD start refusing), and the
   * refine's message exists for the day a sub-minute grammar lands.
   */
  it('pins the one-minute floor as an invariant of the grammar, not a live refusal', () => {
    expect(minIntervalMs(parseCron('* * * * *'), new Date('2026-01-01T00:00:00Z'))).toBe(
      MIN_SCHEDULE_INTERVAL_MS,
    )
    // The tightest gaps the composer can express are all >= the floor, including
    // the midnight wrap and a two-fire morning.
    for (const expr of ['* * * * *', '0,1 9 * * *', '0,30 * * * *', '59 23 * * *']) {
      expect([expr, respectsScheduleFloor(expr, new Date('2026-01-01T00:00:00Z'))]).toEqual([
        expr,
        true,
      ])
      expect([expr, parse({ ...CRON_BASE, cron: expr }).success]).toEqual([expr, true])
    }
    // The instrument CAN say no — shown against a floor the grammar can violate,
    // so "always true" above is the grammar's doing and not a broken predicate.
    expect(minIntervalMs(parseCron('* * * * *'), new Date('2026-01-01T00:00:00Z'))).toBeLessThan(
      2 * MIN_SCHEDULE_INTERVAL_MS,
    )
  })

  /** An omitted `scheduleKind` is a CRON automation — the default the service
   *  applies, mirrored here so the two cannot disagree about which arm runs. */
  it('treats an omitted scheduleKind as cron and demands an expression', () => {
    const noKind = parse({ name: 'x', agentKind: 'claude-code', prompt: 'p' })
    expect(noKind.success).toBe(false)
    expect(noKind.success ? [] : noKind.error.issues.map((i) => i.message)).toContain(
      'invalid cron expression — 5 fields: minute hour day month weekday',
    )
  })

  /**
   * The patch is DELIBERATELY unrefined: `{ cron }` on a one-off automation is a
   * legal edit whose validity depends on the stored row, which this schema cannot
   * see. Asserted so the absence reads as a decision rather than as a gap, and
   * paired with the counterfactual that create DOES refuse the same payload.
   */
  it('leaves cross-field schedule validation on the patch to the service', () => {
    expect(automationPatchInput.safeParse({ cron: '0 3 * * *' }).success).toBe(true)
    expect(automationPatchInput.safeParse({ runAt: '2099-01-01T09:00:00.000Z' }).success).toBe(true)
    expect(automationPatchInput.safeParse({}).success).toBe(true)
    // …and it is still a SCHEMA: a malformed field is refused.
    expect(automationPatchInput.safeParse({ agentKind: 'not-a-harness' }).success).toBe(false)
    // The counterfactual on create, which does refine.
    expect(parse({ ...CRON_BASE, scheduleKind: 'once', runAt: null }).success).toBe(false)
  })

  it('addresses the three id-taking commands by a non-empty id', () => {
    expect(automationSetEnabledInput.safeParse({ id: 'aut_1', enabled: true }).success).toBe(true)
    expect(automationSetEnabledInput.safeParse({ id: '', enabled: true }).success).toBe(false)
    expect(automationSetEnabledInput.safeParse({ id: 'aut_1' }).success).toBe(false)
  })
})
