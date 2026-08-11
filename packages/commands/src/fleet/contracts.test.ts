/**
 * The L1 gate over the fifteen fleet contracts: classifications are TOTAL, the
 * `manage` / `use` partition is exact, the server-role split is exact, and the
 * visibility classes agree with ADR 1's matrix rather than with a literal
 * written twice.
 *
 * EVERY ABSENCE ASSERTION IS PRECEDED BY A PROBE showing the instrument can
 * report the corresponding PRESENCE. A lint that returned `[]` because it
 * stopped looking reads exactly like a clean bill of health, and this run has
 * five instances of a suite that could not say no.
 */

import { OWNERSHIP_MATRIX, visibilityClassOf } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AnyCommandContract,
  classificationErrors,
  registryClassificationErrors,
} from '../contract'
import {
  FLEET_COMMAND_NAMES,
  FLEET_CONTRACTS,
  type FleetContractName,
  fleetServerRoleOf,
} from './contracts'

const FIFTEEN: readonly FleetContractName[] = [
  'machines.rename',
  'machines.applyUpdate',
  'machines.setUpdateChannel',
  'machines.share',
  'machines.unshare',
  'machines.transferOwnership',
  'machines.adopt',
  'machines.revoke',
  'machines.transferServer',
  'machines.pairingCode',
  'repos.add',
  'repos.addMany',
  'repos.remove',
  'repos.setPrefix',
  'discovery.refreshRepos',
  'discovery.scanFolder',
  'discovery.scanMachine',
]

const contracts = (): AnyCommandContract[] =>
  Object.values(FLEET_CONTRACTS).map((c) => c as AnyCommandContract)

/**
 * Is this id a row the matrix actually declares?
 *
 * `visibilityClassOf` is TOTAL and default-closed — an unknown id resolves to
 * `personal` — which is correct as a semantic backstop and useless as a spell
 * checker. Without this, a mistyped row id would resolve `personal`, match
 * nothing in this family, and produce a confusing failure instead of a clear
 * one; worse, a typo'd `secret` row would resolve `personal` and silently make
 * the pairing assertion below untrue-but-green if it were ever inverted.
 */
const isDeclaredMatrixRow = (row: string): boolean =>
  OWNERSHIP_MATRIX.some((r) => (r.id as string) === row)

describe('the fifteen fleet contracts', () => {
  it('declares exactly the fifteen fleet commands, and no sixteenth', () => {
    expect([...FLEET_COMMAND_NAMES].sort()).toEqual([...FIFTEEN].sort())
  })

  it('passes the classification lint with no unclassified field', () => {
    expect(registryClassificationErrors(contracts())).toEqual([])
  })

  /**
   * THE INSTRUMENT PROBE for the assertion above, planted on THIS family's own
   * contracts so it exercises the rules this family actually depends on rather
   * than a generic one. Three separate rules, because three different mistakes
   * were plausible here and each has its own detector.
   */
  it('reports a defect when there is one — so the empty list above means something', () => {
    // Rule: `owned-compute` requires the `machine` resource (ADR 9 D6). The
    // mistake this catches is classifying a repo write as owned compute while
    // authorizing it against something else.
    const wrongResource = {
      ...(FLEET_CONTRACTS['repos.add'] as AnyCommandContract),
      policy: { ...FLEET_CONTRACTS['repos.add'].policy, resource: 'repo', machineVerb: undefined },
    } as AnyCommandContract
    expect(classificationErrors(wrongResource)).toEqual([
      'repos.add: visibility `owned-compute` must name the `machine` resource (ADR 9 D6)',
    ])

    // Rule: a `secret` class forces `online-sensitive` (ADR 3 D4 rule 1). The
    // mistake this catches is the pairing mint being given the family's shared
    // `online-only` delivery cell by copy-paste.
    const wrongDelivery = {
      ...(FLEET_CONTRACTS['machines.pairingCode'] as AnyCommandContract),
      delivery: { ...FLEET_CONTRACTS['machines.pairingCode'].delivery, class: 'online-only' },
    } as AnyCommandContract
    expect(classificationErrors(wrongDelivery)).toEqual([
      'machines.pairingCode: a `secret` resource forces `online-sensitive` (ADR 3 D4 rule 1)',
      'machines.pairingCode: a `secret` visibility class forces `online-sensitive` (ADR 3 D4 rule 1)',
    ])

    // Rule: a `use` command may not be offline-eligible (Amendment 1 D18.3).
    const wrongOfflineClass = {
      ...(FLEET_CONTRACTS['discovery.scanMachine'] as AnyCommandContract),
      delivery: {
        ...FLEET_CONTRACTS['discovery.scanMachine'].delivery,
        class: 'offline-eligible',
      },
    } as AnyCommandContract
    expect(classificationErrors(wrongOfflineClass)).toEqual([
      'discovery.scanMachine: machine `use` executes on someone else’s hardware and may not be offline-eligible (ADR 3 Amendment 1 D18.3) — name it in MACHINE_USE_OFFLINE_EXCEPTIONS if it genuinely is one',
    ])
  })

  /**
   * THE CONTRACT AND THE MATRIX, LOCKED TOGETHER — asserted per command against
   * the row it writes, never against a literal repeated in two files. If
   * POD-1071 ever reclassifies the machine row, these contracts go RED instead
   * of quietly disagreeing with the row they mirror.
   */
  it('agrees with ADR 1’s matrix about the class each command writes', () => {
    // Written out per command rather than derived from `ownership.creates`,
    // because five of the ten create nothing and still write (or, for
    // `scanFolder`, disclose) state — a derivation would have skipped exactly
    // the ones whose class was the hard call.
    const writesInto: Record<FleetContractName, string> = {
      'machines.rename': 'machine',
      'machines.applyUpdate': 'machine',
      'machines.setUpdateChannel': 'machine',
      'machines.share': 'machine',
      'machines.transferOwnership': 'machine',
      'machines.adopt': 'machine',
      'machines.unshare': 'machine',
      'machines.revoke': 'machine',
      'machines.transferServer': 'machine',
      'machines.pairingCode': 'pairing-token',
      'repos.add': 'repo-prefix',
      'repos.addMany': 'repo-prefix',
      'repos.remove': 'repo-prefix',
      'repos.setPrefix': 'repo-prefix',
      'discovery.refreshRepos': 'repo-prefix',
      'discovery.scanFolder': 'repo-prefix',
      'discovery.scanMachine': 'repo-prefix',
    }
    for (const [name, row] of Object.entries(writesInto)) {
      expect([name, isDeclaredMatrixRow(row)]).toEqual([name, true])
      expect([name, FLEET_CONTRACTS[name as FleetContractName].visibility]).toEqual([
        name,
        visibilityClassOf(row),
      ])
    }
  })

  /**
   * THE COUNTERFACTUAL for the assertion above. Twelve of the thirteen share one class,
   * so an assertion that only ever compared `owned-compute` to `owned-compute`
   * would pass against a table where every contract had been copied from its
   * neighbour — which is precisely the mistake the brief flagged as costliest
   * here. The pairing mint is the arm that differs, and it must differ.
   */
  it('does not classify the pairing mint like its neighbours', () => {
    expect(FLEET_CONTRACTS['machines.pairingCode'].visibility).toBe('secret')
    expect(FLEET_CONTRACTS['machines.rename'].visibility).toBe('owned-compute')
    expect(visibilityClassOf('pairing-token')).not.toBe(visibilityClassOf('machine'))
    // And the class it is NOT: `personal` is what a copied session contract
    // would have made every one of these.
    for (const contract of contracts()) expect(contract.visibility).not.toBe('personal')
  })

  it('partitions `manage` from `use` exactly, and names no verb where nothing is placed', () => {
    // Read through the ERASED type: the literal union has no `machineVerb` key
    // on the pairing arm at all, which is the shape being asserted and is not
    // something the reader should have to narrow around.
    const byVerb = Object.fromEntries(
      contracts().map((c) => [c.name, c.policy.machineVerb ?? null]),
    )
    expect(byVerb).toEqual({
      'machines.rename': 'manage',
      'machines.applyUpdate': 'manage',
      'machines.setUpdateChannel': 'manage',
      'machines.share': 'manage',
      'machines.transferOwnership': 'manage',
      'machines.transferServer': 'manage',
      // ADOPTION IS THE ONE `see`, and it is a rule rather than a weaker check:
      // `machineVerbsFor` grants an admin `see` only while the owner is null, so
      // `see` here resolves to "an admin, on an unowned machine" and nothing
      // else. `manage` would refuse every caller — nobody holds it on an
      // unowned machine.
      'machines.adopt': 'see',
      'machines.unshare': 'manage',
      'machines.revoke': 'manage',
      // No machine exists yet, so there is no machine to hold a verb against.
      'machines.pairingCode': null,
      'repos.add': 'manage',
      'repos.addMany': 'manage',
      'repos.remove': 'manage',
      'repos.setPrefix': 'manage',
      'discovery.refreshRepos': 'use',
      'discovery.scanFolder': 'use',
      'discovery.scanMachine': 'use',
    })
  })

  /**
   * M5 is required for `use` commands that take a target id and MUST NOT be
   * claimed by the others — a family that answered `true` everywhere would be
   * reporting machine liveness on rows the caller cannot see.
   */
  it('keeps unauthorized distinguishable from unreachable on the `use` arm only', () => {
    for (const contract of contracts()) {
      const name = contract.name
      const errs = contract.errorConsistency
      if (!errs.callerSuppliedTargetId) continue
      expect([name, errs.distinguishesUnauthorizedFromUnreachable]).toEqual([
        name,
        contract.policy.machineVerb === 'use' || name === 'machines.transferServer',
      ])
      expect([name, errs.invisibleFailsAs]).toEqual([name, 'nonexistent'])
    }
    // The counterfactual: at least one arm of each answer is present, so the
    // loop above is comparing two different things rather than agreeing with
    // itself. `refreshRepos` is `use` and has no target id, which is why the
    // implication is one-directional and worth stating.
    expect(FLEET_CONTRACTS['discovery.scanFolder'].errorConsistency).toMatchObject({
      callerSuppliedTargetId: true,
      distinguishesUnauthorizedFromUnreachable: true,
    })
    expect(FLEET_CONTRACTS['repos.add'].errorConsistency).toMatchObject({
      callerSuppliedTargetId: true,
      distinguishesUnauthorizedFromUnreachable: false,
    })
    expect(FLEET_CONTRACTS['discovery.refreshRepos'].errorConsistency.callerSuppliedTargetId).toBe(
      false,
    )
  })

  it('splits the hub-role surface from core exactly as the shipped router does', () => {
    const byRole = Object.fromEntries(
      Object.entries(FLEET_CONTRACTS).map(([n, c]) => [n, c.serverRole]),
    )
    expect(byRole).toEqual({
      'machines.rename': 'hub',
      'machines.applyUpdate': 'hub',
      'machines.setUpdateChannel': 'hub',
      'machines.share': 'hub',
      'machines.transferOwnership': 'hub',
      'machines.transferServer': 'hub',
      'machines.adopt': 'hub',
      'machines.unshare': 'hub',
      'machines.revoke': 'hub',
      'machines.pairingCode': 'hub',
      'repos.add': 'core',
      'repos.addMany': 'core',
      'repos.remove': 'core',
      'repos.setPrefix': 'core',
      'discovery.refreshRepos': 'core',
      'discovery.scanFolder': 'core',
      'discovery.scanMachine': 'core',
    })
  })

  it('resolves an unknown name to the SMALLER surface, not to core', () => {
    expect(fleetServerRoleOf('machines.rename')).toBe('hub')
    expect(fleetServerRoleOf('repos.add')).toBe('core')
    // Default-closed: a typo must not silently widen where a command is served.
    expect(fleetServerRoleOf('machines.renam')).toBe('hub')
    expect(fleetServerRoleOf('constructor')).toBe('hub')
    expect(fleetServerRoleOf('__proto__')).toBe('hub')
  })

  it('serves every contract on tRPC and nothing anywhere else', () => {
    for (const [name, contract] of Object.entries(FLEET_CONTRACTS)) {
      expect([name, [...contract.exposure]]).toEqual([name, ['trpc']])
    }
  })

  it('reviews redaction everywhere and redacts the credential on the one command that returns one', () => {
    for (const contract of contracts()) expect(contract.redaction.reviewed).toBe(true)
    expect(FLEET_CONTRACTS['machines.pairingCode'].redaction.outputPaths).toEqual([
      'code',
      'joinCommand',
    ])
    // The counterfactual: a fleet write that carries no credential redacts
    // nothing, so `reviewed: true` is doing work rather than rubber-stamping.
    expect(FLEET_CONTRACTS['machines.rename'].redaction.outputPaths).toEqual([])
  })

  it('records an offline class per contract with its reasoning', () => {
    for (const [name, contract] of Object.entries(FLEET_CONTRACTS)) {
      expect([name, contract.delivery.class]).toEqual([
        name,
        name === 'machines.pairingCode' ? 'online-sensitive' : 'online-only',
      ])
      expect(contract.delivery.outboxReconciliation.length).toBeGreaterThan(80)
      expect(contract.delivery.applyTimeReauthorization).toContain('LIVE')
      // ADR 3 D3 rule 2 from the other side: none of these could name `outbox`,
      // and none does.
      expect([name, contract.exposure.includes('outbox')]).toEqual([name, false])
    }
  })

  it('sets the role floor to admin only where no ownership check could ever admit a member', () => {
    const byFloor = Object.fromEntries(
      Object.entries(FLEET_CONTRACTS).map(([n, c]) => [n, c.policy.roleFloor]),
    )
    // TWO admin floors, and they are the same argument twice rather than two
    // exceptions. The rule is "admin only where no ownership check could ever
    // admit a member", so the question per command is whether there is an owner
    // for such a check to read.
    //
    //  - `machines.pairingCode` mints a credential for a machine that does not
    //    exist yet, so there is no row to own (ADR 9 D3 rule 5).
    //  - `machines.adopt` (POD-1494) acts on a machine whose owner is precisely
    //    what is MISSING — its declared precondition is `unowned`. An owner
    //    check could not admit a member here either, because there is no owner
    //    column with anybody in it.
    //
    // Everywhere else there IS an owner, and a floor of `admin` would make ADR 9
    // D6 M1's "Owner + admins" unreachable for the owner themselves.
    const ADMIN_FLOOR = ['machines.pairingCode', 'machines.adopt', 'machines.transferServer']
    for (const name of ADMIN_FLOOR) expect([name, byFloor[name]]).toEqual([name, 'admin'])
    for (const name of FIFTEEN.filter((n) => !ADMIN_FLOOR.includes(n))) {
      expect([name, byFloor[name]]).toEqual([name, 'member'])
    }
    // Non-vacuity: the admin set is a strict, non-empty subset. If a refactor
    // made every floor `admin` the loop above would pass and this would not.
    expect(ADMIN_FLOOR.length).toBeLessThan(FIFTEEN.length)
    expect(Object.values(byFloor).some((f) => f === 'member')).toBe(true)
  })

  it('validates through the SAME schema the shipped procedure validated with', () => {
    // A rename over 80 chars was refused before this migration and must still
    // be: the input schemas are a move, not a re-specification.
    expect(FLEET_CONTRACTS['machines.rename'].input.safeParse({ id: 'm1', name: '' }).success).toBe(
      false,
    )
    expect(
      FLEET_CONTRACTS['machines.rename'].input.safeParse({ id: 'm1', name: 'x'.repeat(81) })
        .success,
    ).toBe(false)
    expect(
      FLEET_CONTRACTS['machines.rename'].input.safeParse({ id: 'm1', name: 'laptop' }).success,
    ).toBe(true)
    // The pairing mint's input is optional at the top level, exactly as shipped.
    expect(FLEET_CONTRACTS['machines.pairingCode'].input.safeParse(undefined).success).toBe(true)
    expect(
      FLEET_CONTRACTS['machines.pairingCode'].input.safeParse({ copyAgentCredentials: true })
        .success,
    ).toBe(true)
    // `scanFolder`'s depth is a positive integer or absent — never 0, which
    // would mean "inspect in place" and is `refreshRepos`'s job.
    expect(
      FLEET_CONTRACTS['discovery.scanFolder'].input.safeParse({ path: '/a', maxDepth: 0 }).success,
    ).toBe(false)
  })
})
