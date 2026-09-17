import { resolvePrincipal } from '../../command-principal'
/**
 * THE FLEET AUTHORIZATION GATE (POD-1079) — what POD-384 declared and nothing
 * read until now.
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS, BECAUSE NEITHER SEES THE OTHER'S FAILURE
 * ---------------------------------------------------------------------------
 *
 * The DECISION suite drives `fleetAuthzFailure` directly, because that is the
 * only way to present a SECOND HUMAN: the transport still resolves every
 * connection to one account (`CLIENT_PRINCIPAL_GRADE === 'device'`), so a
 * colleague cannot be produced through the router at all. Testing only through
 * the router would mean testing only the principal that is allowed everything —
 * POD-351's failure exactly.
 *
 * The WIRING suite drives the REAL derived router, because a decision function
 * nothing calls refuses nothing. Its refusal is produced by an environmental
 * fact the test environment CAN create without a second login: an UNOWNED
 * machine row, which `machineUseAllowed` refuses to everybody including the sole
 * account. Both arms assert the positive first, so neither can pass against a
 * gate that refuses everything.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FLEET_CONTRACTS, type FleetContractName } from '@podium/commands'
import { asMachineId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import type { MachineVerb } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../../command-principal'
import { openEnrollmentLedger } from '../../enrollment-ledger'
import { PairingManager } from '../../hub/pairing'

import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../machine-access'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { SuperagentService } from '../superagent'
import { FLEET_TARGETS, type FleetAuthzDeps, fleetAuthzFailure, roleSatisfiesFloor } from './authz'

const OWNER = firstAdminMemberId()
const COLLEAGUE: UserId = asUserId('colleague')

const user = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'worker', scope: { kind: 'all' } },
})

/** One machine, `laptop`, owned by OWNER — plus whatever grants a test sets. */
function deps(
  principal: CommandPrincipal,
  opts: {
    role?: 'admin' | 'member'
    grants?: { subject: UserId; verb: MachineVerb }[]
    owner?: UserId | null
    machines?: string[]
    /**
     * What the LEDGER says the owner is, when a test needs it to differ from the
     * row. Defaults to the row's owner, so every pre-existing test is unchanged
     * and the two agree unless a test deliberately separates them — which is the
     * only way to tell a gate that reads the ledger from one that reads the
     * projection and currently happens to agree with it.
     */
    effectiveOwner?: UserId | null
  } = {},
): FleetAuthzDeps {
  const ids = (opts.machines ?? ['laptop']).map(asMachineId)
  const ownership: MachineOwnershipIndex = {
    rowFor: (machineId): MachineOwnershipRow | undefined =>
      ids.includes(machineId)
        ? {
            machine: machineId as MachineOwnershipRow['machine'],
            owner: opts.owner === undefined ? OWNER : opts.owner,
            grants: opts.grants ?? [],
            daemonAssigned: true,
            daemonAvailable: true,
            name: machineId,
          }
        : undefined,
  }
  return {
    principal: opts.role === 'admin' && principal.kind !== 'system'
      ? { ...principal, capability: { ...principal.capability, role: 'admin' } } : principal,
    ownership,
    role: opts.role ?? 'admin',
    defaultMachine: async () => ids[0] ?? asMachineId('laptop'),
    allMachineIds: async () => ids,
    machineName: async (id) => id,
    effectiveOwner: async (machineId) =>
      ids.includes(machineId)
        ? opts.effectiveOwner !== undefined
          ? opts.effectiveOwner
          : opts.owner === undefined
            ? OWNER
            : opts.owner
        : undefined,
  }
}

/** Any input that satisfies every extractor in the table. */
const anyInput = { id: 'laptop', machineId: 'laptop', path: '/repo', paths: ['/repo'], prefix: 'X' }

const NAMES = Object.keys(FLEET_CONTRACTS) as FleetContractName[]
const MACHINE_COMMANDS = NAMES.filter(
  (n) => (FLEET_CONTRACTS[n].policy as { machineVerb?: MachineVerb }).machineVerb !== undefined,
)

describe('the target table covers the contract table, in both directions', () => {
  it('every contract has an extractor and every extractor has a contract', () => {
    expect(Object.keys(FLEET_TARGETS).sort()).toEqual([...NAMES].sort())
    // Non-vacuity: if the family were empty this would pass trivially.
    expect(NAMES).toHaveLength(22)
    expect(MACHINE_COMMANDS).toHaveLength(21)
  })
})

describe('the role floor is read from the contract', () => {
  it('a member may not attempt an `admin`-floor command, and an admin may', async () => {
    // `machines.pairingCode` is the only admin floor in the family (POD-384).
    const asMember = await fleetAuthzFailure(
      'machines.pairingCode',
      {},
      deps(user(OWNER), { role: 'member' }),
    )
    expect(asMember?.code).toBe('FORBIDDEN')

    expect(
      await fleetAuthzFailure('machines.pairingCode', {}, deps(user(OWNER), { role: 'admin' })),
    ).toBeUndefined()
  })

  it('a member DOES clear the `member` floor — the floor admits, and the row gate refuses', async () => {
    // POD-384's whole reasoning: the nine are `member` so that D6 M1's owner
    // column stays reachable. If the floor refused members, this would be a
    // FORBIDDEN about the floor rather than the machine.
    expect(
      await fleetAuthzFailure('machines.rename', anyInput, deps(user(OWNER), { role: 'member' })),
    ).toBeUndefined()
  })

  it('a principal with NO readable account satisfies no floor', async () => {
    // A disabled or unknown account reads back as `undefined` from the store.
    expect(roleSatisfiesFloor(undefined, 'member')).toBe(false)
    expect(roleSatisfiesFloor(undefined, 'admin')).toBe(false)
    // …and the same function says yes for a real one, so it is not always-false.
    expect(roleSatisfiesFloor('member', 'member')).toBe(true)
    expect(roleSatisfiesFloor('admin', 'admin')).toBe(true)
    expect(roleSatisfiesFloor('member', 'admin')).toBe(false)

    const refusal = await fleetAuthzFailure('machines.rename', anyInput, {
      ...deps(user(OWNER)),
      role: undefined,
    })
    expect(refusal?.code).toBe('FORBIDDEN')
  })

  it('a system principal cannot mint a human enrollment credential', async () => {
    expect(
      await fleetAuthzFailure(
        'machines.pairingCode',
        {},
        { ...deps(systemPrincipal('boot-reconcile')), role: undefined },
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('the machine verb is read from the contract, per command', () => {
  it.each(MACHINE_COMMANDS)('%s refuses a colleague who cannot see the machine', async (name) => {
    const refusal = await fleetAuthzFailure(name, anyInput, deps(user(COLLEAGUE)))
    expect(refusal?.code).toBe('NOT_FOUND')
    // The SAME words a never-paired id gets: the refusal must not disclose that
    // this machine exists (D20 / readiness §3.1.2).
    expect(refusal?.message).toContain('unknown machine')
  })

  // `machines.adopt` is excluded, and the exclusion is asserted rather than
  // assumed — see the test directly below. It is the one machine command whose
  // precondition is the ABSENCE of an owner, so "admits the owner" is exactly
  // what it must not do.
  const OWNER_ADMITTING = MACHINE_COMMANDS.filter((n) => n !== 'machines.adopt')

  it.each(OWNER_ADMITTING)('%s admits the machine OWNER', async (name) => {
    expect(await fleetAuthzFailure(name, anyInput, deps(user(OWNER)))).toBeUndefined()
  })

  it('`machines.adopt` is the one machine command that REFUSES the owner', async () => {
    // The filter above is a claim about exactly one command, so it is checked in
    // both directions: adoption is refused on an owned machine, and it is the
    // only member of the family that is.
    expect(MACHINE_COMMANDS).toContain('machines.adopt')
    expect(OWNER_ADMITTING).toHaveLength(MACHINE_COMMANDS.length - 1)
    expect((await fleetAuthzFailure('machines.adopt', anyInput, deps(user(OWNER))))?.code).toBe('FORBIDDEN')
  })

  it('a `see` grant is not enough for a `manage` command, and IS enough to be told forbidden', async () => {
    const seeOnly = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'see' }] })
    const refusal = await fleetAuthzFailure('machines.rename', anyInput, seeOnly)

    // Inside the `see` set the answer changes from "does not exist" to "you may
    // not" — which is the M5 distinction, and the reason `see` is a real verb.
    expect(refusal?.code).toBe('FORBIDDEN')
  })

  it('a `manage` grant admits the manage family and NOT the use family', async () => {
    const manage = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'manage' }] })

    expect(await fleetAuthzFailure('machines.rename', anyInput, manage)).toBeUndefined()
    expect(await fleetAuthzFailure('repos.add', anyInput, manage)).toBeUndefined()
    // `discovery.scanMachine` walks the target's filesystem through its daemon —
    // POD-384 classified it `use` for exactly this reason, and a manage grant
    // must not carry it.
    expect((await fleetAuthzFailure('discovery.scanMachine', anyInput, manage))?.code).toBe('FORBIDDEN')
  })

  it('a manage grantee cannot re-delegate machine access', async () => {
    const manage = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'manage' }] })
    const input = { id: 'laptop', grantee: 'another-user', verb: 'use' }

    expect((await fleetAuthzFailure('machines.share', input, manage))?.code).toBe('FORBIDDEN')
    expect((await fleetAuthzFailure('machines.unshare', input, manage))?.code).toBe('FORBIDDEN')
    expect(await fleetAuthzFailure('machines.share', input, deps(user(OWNER)))).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // TRANSFER OF OWNERSHIP (POD-1480)
  // -------------------------------------------------------------------------
  //
  // TWO PRINCIPALS IN EVERY CASE. A one-actor test cannot tell "the gate
  // enforces owner-only" from "there was only ever one person", and the positive
  // arm is asserted alongside each refusal so none of these can pass against a
  // gate that refuses everybody.

  it('only the machine OWNER may transfer ownership — not a manage grantee, not an admin', async () => {
    const input = { id: 'laptop', newOwnerUserId: COLLEAGUE }

    // The owner: admitted. Assert this FIRST — without it the three refusals
    // below are satisfied by a gate that refuses everyone.
    expect(
      await fleetAuthzFailure('machines.transferOwnership', input, deps(user(OWNER))),
    ).toBeUndefined()

    // A manage grantee holds every other manage-family command on this machine…
    const manage = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'manage' }] })
    expect(await fleetAuthzFailure('machines.rename', anyInput, manage)).toBeUndefined()
    // …and still may not give the machine away. Delegated manage is not
    // authority over the root of the delegation.
    expect((await fleetAuthzFailure('machines.transferOwnership', input, manage))?.code).toBe('FORBIDDEN')
    expect((await fleetAuthzFailure('machines.transferOwnership', input, manage))?.message).toBe(
      'only the machine owner may change sharing',
    )

    // An INSTANCE ADMIN who does not own the machine cannot take it either
    // (D19.4b: not the first admin's Mac to hand out). `role: 'admin'` clears
    // the floor, so this refusal is the owner rule and not the floor.
    const admin = deps(user(COLLEAGUE), { role: 'admin' })

    expect((await fleetAuthzFailure('machines.transferOwnership', input, admin))?.code).toBe('FORBIDDEN')
  })

  it('requires an admin-grade caller with manage authority on the named target', async () => {
    const input = {
      targetMachineId: 'laptop',
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0',
      confirmation: 'TRANSFER SERVER' as const,
    }
    expect(await fleetAuthzFailure('machines.moveServer', input, deps(user(OWNER)))).toBeUndefined()

    const memberManage = deps(user(COLLEAGUE), {
      role: 'member',
      grants: [{ subject: COLLEAGUE, verb: 'manage' }],
    })
    expect((await fleetAuthzFailure('machines.moveServer', input, memberManage))?.code).toBe('FORBIDDEN')

    const adminManage = deps(user(COLLEAGUE), {
      role: 'admin',
      grants: [{ subject: COLLEAGUE, verb: 'manage' }],
    })
    expect(await fleetAuthzFailure('machines.moveServer', input, adminManage)).toBeUndefined()

    const admin = deps(user(COLLEAGUE), { role: 'admin' })
    expect(await fleetAuthzFailure('machines.moveServer', input, admin)).toBeUndefined()
  })

  it('naming yourself as the recipient does not make you the owner', async () => {
    // The gate reads the TARGET machine, never `newOwnerUserId`. If the
    // extractor read the recipient instead, a colleague could nominate
    // themselves and be gated against a machine they own.
    const colleagueOwns = deps(user(COLLEAGUE), {
      machines: ['laptop', COLLEAGUE],
      owner: COLLEAGUE,
    })
    expect(
      (await fleetAuthzFailure(
        'machines.transferOwnership',
        { id: 'laptop', newOwnerUserId: COLLEAGUE },
        deps(user(COLLEAGUE)),
      ))?.code,
    ).toBe('NOT_FOUND')
    // Non-vacuity: the same principal IS admitted on a machine it owns.
    expect(
      await fleetAuthzFailure(
        'machines.transferOwnership',
        { id: 'laptop', newOwnerUserId: OWNER },
        colleagueOwns,
      ),
    ).toBeUndefined()
  })

  it('an UNOWNED machine is transferable by nobody, including an admin', async () => {
    // A quarantined machine (D19.4b) has no owner to derive authority from, and
    // it is refused BEFORE the owner rule is reached: `machineVerbsFor` gives a
    // quarantine admin `see` and nothing else, so the `manage` check answers
    // FORBIDDEN. A member sees nothing at all and gets the absent-shaped answer.
    // Both arms refuse; adoption is a separate act with separate authority.
    const input = { id: 'laptop', newOwnerUserId: COLLEAGUE }
    const unownedAdmin = deps(user(OWNER), { owner: null, role: 'admin' })
    expect((await fleetAuthzFailure('machines.transferOwnership', input, unownedAdmin))?.code).toBe(
      'NOT_FOUND',
    )
    // A genuine non-admin. Two different roles are in play and only one decides
    // this: `machineVerbsFor`'s quarantine arm reads the CAPABILITY role (an
    // `IssueRole`), while `deps.role` is the ACCOUNT role the floor consults.
    // `user()` hardcodes capability `admin`, so lowering the account role alone
    // would leave the caller admin-graded exactly where it matters.
    const memberPrincipal: CommandPrincipal = {
      kind: 'user',
      user: COLLEAGUE,
      capability: { role: 'worker', scope: { kind: 'all' } },
    }
    const unownedMember = deps(memberPrincipal, { owner: null, role: 'member' })
    expect((await fleetAuthzFailure('machines.transferOwnership', input, unownedMember))?.code).toBe(
      'NOT_FOUND',
    )
    // Non-vacuity: the SAME command on an owned machine admits its owner.
    expect(
      await fleetAuthzFailure('machines.transferOwnership', input, deps(user(OWNER))),
    ).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // ADOPTION (POD-1494) — the act the case above leaves undone
  // -------------------------------------------------------------------------
  //
  // The test directly above establishes that an unowned machine is transferable
  // by NOBODY. These establish who may give it an owner instead, and each one
  // drives TWO principals for the reason stated at the top of this block: with a
  // single actor, "an admin may adopt" and "everyone may adopt" produce
  // identical output.

  it('only an ADMIN may adopt an unowned machine — a member is refused at the floor', async () => {
    const input = { id: 'laptop', newOwnerUserId: COLLEAGUE }

    // POSITIVE FIRST. An admin, on a machine with no owner: admitted. Without
    // this the refusals below are satisfied by a gate that refuses everybody —
    // which is precisely what `machines.transferOwnership` does on this exact
    // input, so the vacuous version of this test would look identical.
    const admin = deps(user(OWNER), { owner: null, role: 'admin' })
    expect(await fleetAuthzFailure('machines.adopt', input, admin)).toBeUndefined()

    // A SECOND, GENUINELY NON-ADMIN PRINCIPAL on the SAME machine. Both roles
    // are lowered for the reason the transfer test above documents: the
    // capability role is what `machineVerbsFor`'s quarantine arm reads, and
    // `user()` hardcodes it to `admin`, so lowering `deps.role` alone would
    // leave the caller admin-graded exactly where it decides.
    const memberPrincipal: CommandPrincipal = {
      kind: 'user',
      user: COLLEAGUE,
      capability: { role: 'worker', scope: { kind: 'all' } },
    }
    const member = deps(memberPrincipal, { owner: null, role: 'member' })
    const refusal = await fleetAuthzFailure('machines.adopt', input, member)
    expect(refusal?.code).toBe('FORBIDDEN')
    // The FLOOR refused, before the machine id was read — so a member learns
    // nothing about the machine, not even that it is unowned.
    expect(refusal?.message).toBe('machines.adopt requires an admin account')

    // And the member is not merely locked out of everything: the same principal
    // on the same machine is admitted by a command whose floor it does clear.
    // This is what separates "the floor fired" from "this principal is inert".
    expect(
      await fleetAuthzFailure('machines.rename', anyInput, deps(memberPrincipal, { owner: COLLEAGUE })),
    ).toBeUndefined()
  })

  it('an admin sees an owned machine but cannot adopt it', async () => {
    const input = { id: 'laptop', newOwnerUserId: COLLEAGUE }

    // Role admits management; the unowned precondition still refuses adoption.
    const otherPersonsMachine = deps(user(COLLEAGUE), { role: 'admin', owner: OWNER })
    const refusal = await fleetAuthzFailure('machines.adopt', input, otherPersonsMachine)
    expect(refusal?.code).toBe('FORBIDDEN')
    expect(refusal?.message).toBe("machine already has an owner — only its owner may transfer it")
    const neverPaired = await fleetAuthzFailure(
      'machines.adopt',
      { ...input, id: 'never-paired' },
      otherPersonsMachine,
    )
    expect(neverPaired?.code).toBe('NOT_FOUND')
    expect(neverPaired?.message).toBe("unknown machine 'never-paired'")

    // The OWNER of that machine is an admin too, and reaches further — past the
    // verb, into the declared precondition, which is where the "already owned"
    // rule lives. Two principals, two different refusal shapes, one rule.
    const ownerAdmin = deps(user(OWNER), { role: 'admin', owner: OWNER })
    const owned = await fleetAuthzFailure('machines.adopt', input, ownerAdmin)
    expect(owned?.code).toBe('FORBIDDEN')
    expect(owned?.message).toBe('machine already has an owner — only its owner may transfer it')

    // Non-vacuity: drop the owner and the SAME principal is admitted.
    expect(
      await fleetAuthzFailure('machines.adopt', input, deps(user(OWNER), { role: 'admin', owner: null })),
    ).toBeUndefined()
  })

  it('the unowned precondition reads the LEDGER, not the machines row', async () => {
    // D19.4d makes `machines.owner_user_id` a PROJECTION of the enrollment
    // ledger, so the row can legitimately disagree with the ledger in the window
    // between an append and its projection. Every other test in this file has
    // the two agreeing, which means none of them can tell which one the gate
    // reads. These two separate them, in both directions.
    const input = { id: 'laptop', newOwnerUserId: COLLEAGUE }

    // ROW says unowned, LEDGER says COLLEAGUE owns it — a transfer appended and
    // has not projected yet. Reading the row would let an admin adopt a machine
    // that is, at this instant, somebody's. REFUSED.
    const staleNullRow = deps(user(OWNER), {
      role: 'admin',
      owner: null,
      effectiveOwner: COLLEAGUE,
    })
    expect((await fleetAuthzFailure('machines.adopt', input, staleNullRow))?.code).toBe('FORBIDDEN')

    // ROW still shows a departed owner, LEDGER has none — the machine is
    // adoptable and reading the row would refuse a legitimate adoption. Note the
    // admin needs `see`, which the owner-null arm of `machineVerbsFor` does not
    // grant here because the ROW is not null; OWNER holds it as the row's owner,
    // which is what makes this arm reach the precondition at all.
    const staleOwnedRow = deps(user(OWNER), { role: 'admin', owner: OWNER, effectiveOwner: null })
    expect(await fleetAuthzFailure('machines.adopt', input, staleOwnedRow)).toBeUndefined()
  })

  it('adoption gates the MACHINE, never the person it is adopted for', async () => {
    // Same extractor hazard `machines.transferOwnership` documents: if
    // FLEET_TARGETS read `newOwnerUserId`, an admin could name a machine id as
    // the recipient and be gated against the wrong subject entirely.
    const admin = deps(user(OWNER), { owner: null, role: 'admin', machines: ['laptop'] })
    // The recipient is a machine that does not exist; the TARGET still resolves.
    expect(
      await fleetAuthzFailure('machines.adopt', { id: 'laptop', newOwnerUserId: 'nonexistent' }, admin),
    ).toBeUndefined()
    // And an unknown TARGET is refused however good the recipient is.
    expect(
      (await fleetAuthzFailure('machines.adopt', { id: 'ghost', newOwnerUserId: COLLEAGUE }, admin))?.code,
    ).toBe('NOT_FOUND')
  })

  it('a `use` grant admits the discovery family and NOT the manage family', async () => {
    const use = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'use' }] })

    expect(await fleetAuthzFailure('discovery.scanMachine', anyInput, use)).toBeUndefined()
    expect((await fleetAuthzFailure('machines.revoke', anyInput, use))?.code).toBe('FORBIDDEN')
  })

  it('an omitted machine selector is gated against the DEFAULT machine, not waved through', async () => {
    // `repos.add` with no `machineId` resolves `machines.defaultMachine()` in the
    // handler. If the gate treated "no selector" as "no machine", the whole repo
    // family would be ungated by simply leaving the field out.
    const colleague = deps(user(COLLEAGUE))
    expect((await fleetAuthzFailure('repos.add', { path: '/repo' }, colleague))?.code).toBe('NOT_FOUND')
    expect(await fleetAuthzFailure('repos.add', { path: '/repo' }, deps(user(OWNER)))).toBeUndefined()
  })

  it('`machines.pairingCode` names no machine and is gated by its floor alone', async () => {
    // It carries no `machineVerb` (there is no machine yet), so a principal that
    // can see nothing still passes once the floor is met.
    expect(
      await fleetAuthzFailure('machines.pairingCode', {}, deps(user(COLLEAGUE), { role: 'admin' })),
    ).toBeUndefined()
  })

  it('the fleet-wide command is narrowed, not refused, while it can reach ANY machine', async () => {
    const two = { machines: ['laptop', 'workstation'] }
    // The colleague holds `use` on one of the two.
    const partial = deps(user(COLLEAGUE), {
      ...two,
      grants: [{ subject: COLLEAGUE, verb: 'use' }],
    })
    expect(await fleetAuthzFailure('discovery.refreshRepos', undefined, partial)).toBeUndefined()

    // …and is refused when it can reach none, rather than silently scanning
    // everybody's machines.
    const none = deps(user(COLLEAGUE), two)
    expect((await fleetAuthzFailure('discovery.refreshRepos', undefined, none))?.code).toBe('NOT_FOUND')
  })
})

/**
 * THE WIRING ARM. Every assertion above is about a function; these are about the
 * SERVED procedure, and they would all pass against a gate nothing calls if the
 * refusing case were missing. The refusal is produced by an unowned row.
 */
describe('the derived fleet router actually calls the gate', () => {
  async function caller(ownerUserId: string | null, opts: { stateDir?: string } = {}) {
    const store = await openTestStore(':memory:')
    await store.machines.upsertMachine({
      id: 'm1',
      name: 'machine-one',
      hostname: 'host-one',
      tokenHash: 'h1',
      assignment: { server: false, agentExecution: true },
      ownerUserId: ownerUserId === null ? null : asUserId(ownerUserId),
    })
    const registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      pairing: new PairingManager(),
      // Ownership transfer commits to the ledger, so the wiring arm needs a real
      // one. Every other command here is indifferent to it.
      ...(opts.stateDir ? { enrollment: openEnrollmentLedger(opts.stateDir) } : {}),
    })
    await registry.modules.machines.ensureHostMachine('machine-under-test')
    await registry.modules.machines.attach(asMachineId('m1'), () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
    return {
      store,
      // Exposed so a test can read the LEDGER (`effectiveOwner`) and not only
      // the row it projects onto — the two are the same in a healthy world and
      // only the ledger is the commit point.
      registry,
      call: appRouter.createCaller({
        registry,
        repos,
        superagent,
        capability: OPERATOR,
        principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
      }),
    }
  }

  const edge = (verb: 'see' | 'use' | 'manage', resourceId = 'm1') => ({
    resourceKind: 'machine',
    resourceId,
    grantee: firstAdminMemberId(),
    verb,
    owner: 'someone-else',
    visibility: 'owned-compute',
    createdAt: '2026-07-30T00:00:00.000Z',
    actorKind: 'user',
    actorId: 'someone-else',
    onBehalfOf: 'someone-else',
  })

  it('renames a machine the caller owns', async () => {
    const { call } = await caller(firstAdminMemberId())
    const after = await call.machines.rename({ id: 'm1', name: 'renamed' })
    expect(after.find((m) => m.id === 'm1')?.name).toBe('renamed')
  })

  it('persists owner-issued grants with authenticated attribution and revokes them', async () => {
    const { call, store } = await caller(firstAdminMemberId())

    await call.machines.share({ id: 'm1', grantee: COLLEAGUE, verb: 'use' })
    expect(await store.grants.listForResource('machine', 'm1')).toEqual([
      expect.objectContaining({
        grantee: COLLEAGUE,
        verb: 'use',
        owner: firstAdminMemberId(),
        actorKind: 'user',
        // The actor id is the MEMBER id now. It read `'sole'` while the first
        // admin was `'user:sole'` and the attribution encoder split that on the
        // colon; a `mem_` id has no colon to split, so the whole id is the actor.
        actorId: firstAdminMemberId(),
        onBehalfOf: firstAdminMemberId(),
      }),
    ])

    await call.machines.unshare({ id: 'm1', grantee: COLLEAGUE, verb: 'use' })
    expect(await store.grants.listForResource('machine', 'm1')).toEqual([])
  })

  it('transfers ownership through the SERVED procedure, executing the projection tail', async () => {
    // THE ACCEPTANCE TEST FOR POD-1480. Until this command existed, the tail of
    // `transferOwnership` — row write, cache invalidate, broadcast — had no
    // caller that reached it: the one caller anywhere passed `skipRowUpdate`.
    // This drives the real derived tRPC procedure, so it also proves the
    // contract/registry/target wiring produced a procedure at all.
    const dir = mkdtempSync(join(tmpdir(), 'podium-fleet-transfer-'))
    try {
      const { call, store } = await caller(firstAdminMemberId(), { stateDir: dir })
      await store.users.create(
        {
          id: COLLEAGUE,
          displayName: 'Colleague',
          role: 'member',
          createdAt: '2026-07-30T00:00:00.000Z',
          disabledAt: null,
        },
        'hash',
      )

      const after = await call.machines.transferOwnership({
        id: 'm1',
        newOwnerUserId: COLLEAGUE,
      })

      // The row moved — the projection half of D19.4d, which no caller had ever
      // reached before this command existed.
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBe(COLLEAGUE)
      // Role preserves manage after transfer; execution still needs consent.
      expect(after.map((m) => m.id)).toContain('m1')
      await call.machines.rename({ id: 'm1', name: 'not-mine-anymore' })
      expect((await store.machines.getMachine('m1'))?.name).toBe('not-mine-anymore')
      await expect(call.discovery.scanMachine({ machineId: 'm1' })).rejects.toThrow(/do not have access/)

    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to transfer a machine the caller does not own', async () => {
    // SECOND PRINCIPAL, produced the only way this environment can: an unowned
    // row, which belongs to nobody and therefore not to the caller either. The
    // positive arm above is what stops this passing against a dead procedure.
    const dir = mkdtempSync(join(tmpdir(), 'podium-fleet-transfer-'))
    try {
      const { call, store } = await caller(null, { stateDir: dir })
      await expect(
        call.machines.transferOwnership({ id: 'm1', newOwnerUserId: COLLEAGUE }),
      ).rejects.toThrow(/unknown machine/)
      // Refused BEFORE the handler: no row write, so nothing to unwind.
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ADOPTS an unowned machine through the SERVED procedure, and the ledger holds it', async () => {
    // THE ACCEPTANCE TEST FOR POD-1494, and the counterfactual for every
    // decision-level adoption test above: those drive a function, and a function
    // nothing calls refuses nothing. This drives the real derived procedure, so
    // it also proves the contract/registry/target wiring produced one at all —
    // the exact defect class POD-1479 found on `transferOwnership`.
    //
    // `caller(null)` is an UNOWNED row: the machine every other test in this
    // block uses to produce a refusal is the one adoption is FOR.
    const dir = mkdtempSync(join(tmpdir(), 'podium-fleet-adopt-'))
    try {
      const { call, store, registry } = await caller(null, { stateDir: dir })
      await store.users.create(
        {
          id: COLLEAGUE,
          displayName: 'Colleague',
          role: 'member',
          createdAt: '2026-07-30T00:00:00.000Z',
          disabledAt: null,
        },
        'hash',
      )
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBeNull()

      const after = await call.machines.adopt({ id: 'm1', newOwnerUserId: COLLEAGUE })

      // The projection moved…
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBe(COLLEAGUE)
      // …and the LEDGER — the commit point — is what it moved from.
      expect(await registry.modules.machines.effectiveOwner(asMachineId('m1'))).toBe(COLLEAGUE)
      expect(after.map((m) => m.id)).toContain('m1')

      // Adoption ends the unowned state, so a repeat is refused by its precondition.
      await expect(call.machines.adopt({ id: 'm1', newOwnerUserId: COLLEAGUE })).rejects.toThrow(
        /already has an owner/,
      )
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBe(COLLEAGUE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('served adoption follows the database when a compatibility transfer skips its write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-fleet-adopt-database-'))
    try {
      const { call, store, registry } = await caller(null, { stateDir: dir })
      await registry.modules.machines.transferOwnership(asMachineId('m1'), COLLEAGUE, { skipRowUpdate: true })
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBeNull()
      expect(await registry.modules.machines.effectiveOwner(asMachineId('m1'))).toBeNull()
      await call.machines.adopt({ id: 'm1', newOwnerUserId: OWNER })
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBe(OWNER)
      expect(await registry.modules.machines.effectiveOwner(asMachineId('m1'))).toBe(OWNER)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('an admin manages an unowned row without use', async () => {
    const { call, store } = await caller(null)
    await call.machines.rename({ id: 'm1', name: 'renamed' })
    expect((await store.machines.getMachine('m1'))?.name).toBe('renamed')
    const rows = await call.machines.list()
    expect(rows.find((m) => m.id === 'm1')).toMatchObject({ unowned: true, adoptable: true, use: 'denied' })
  })

  it('explicit adoption defaults to the authenticated human', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-fleet-self-adopt-'))
    try {
      const { call, store } = await caller(null, { stateDir: dir })
      await call.machines.adopt({ id: 'm1' })
      expect((await store.machines.getMachine('m1'))?.ownerUserId).toBe(OWNER)
      expect((await call.machines.list()).find((m) => m.id === 'm1')).toMatchObject({ unowned: false, adoptable: false, owned: true, use: 'granted' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('admin manage permits repository registration but not execution on an unowned machine', async () => {
    const { call } = await caller(null)
    await call.repos.add({ path: '/tmp/x', machineId: 'm1' })
    await expect(call.discovery.scanMachine({ machineId: 'm1' })).rejects.toThrow(/do not have access/)
  })

  it('an authoritative database null grantee is unowned in the client projection', async () => {
    const { call, store, registry } = await caller(OWNER)
    await store.machines.setMachineOwner('m1', null)
    expect(await registry.modules.machines.effectiveOwner(asMachineId('m1'))).toBeNull()
    expect((await call.machines.list()).find((m) => m.id === 'm1')).toMatchObject({
      unowned: true, adoptable: true, owned: false, use: 'denied',
    })
    await call.machines.adopt({ id: 'm1' })
    expect(await registry.modules.machines.effectiveOwner(asMachineId('m1'))).toBe(OWNER)
  })

  it('admin manage survives removal of a share without granting use', async () => {
    const { call, store } = await caller('someone-else')
    await call.machines.rename({ id: 'm1', name: 'before' })
    await store.grants.upsert(edge('manage'))
    await store.grants.remove('machine', 'm1', firstAdminMemberId(), 'manage')
    await call.machines.rename({ id: 'm1', name: 'after' })
    expect((await store.machines.getMachine('m1'))?.name).toBe('after')
    await expect(call.discovery.scanMachine({ machineId: 'm1' })).rejects.toThrow(/do not have access/)
  })

  it('a `manage` grant does not carry `use`: discovery on the same machine is still refused', async () => {
    const { call, store } = await caller('someone-else')
    await store.grants.upsert(edge('manage'))

    // Visible now (any verb implies `see`), so the refusal is FORBIDDEN-shaped
    // rather than the unknown-machine wording — the M2 line, at the router.
    await expect(call.discovery.scanMachine({ machineId: 'm1' })).rejects.toThrow(
      /do not have access/,
    )
  })
})

/**
 * THE PAIRING PATH, END TO END — the one that broke first.
 *
 * `PairingGrant.ownerUserId` is stamped at MINT, from the transport principal,
 * and carried opaquely to redeem. The first version of this change added the
 * field and never set it, and every freshly paired machine came out UNOWNED and
 * therefore unusable — caught by `server.role.test.ts` driving a real pair
 * handshake. That is the regression these two cases pin, and they pin it at the
 * seam rather than through an HTTP server.
 */
describe('a paired machine belongs to whoever minted its code', () => {
  async function service() {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, {
      instanceId: 'default',
      pairing: new PairingManager(),
    })
    return { store, machines: registry.modules.machines }
  }

  const pairFrame = (code: string) => ({
    type: 'pair' as const,
    code,
    machineId: asMachineId('joiner'),
    hostname: 'joiner.local',
    name: 'joiner',
  })

  it('the pairer named at mint becomes the owner of the machine that redeems the code', async () => {
    const { store, machines } = await service()
    const code = machines.mintPairingCode({ ownerUserId: firstAdminMemberId() })

    expect((await machines.authenticateDaemon(pairFrame(code))).ok).toBe(true)
    expect((await store.machines.getMachine('joiner'))?.ownerUserId).toBe(firstAdminMemberId())
  })

  it('a code minted with NO pairer produces an unowned machine — refused, not shared', async () => {
    const { store, machines } = await service()
    const code = machines.mintPairingCode({})

    expect((await machines.authenticateDaemon(pairFrame(code))).ok).toBe(true)
    expect((await store.machines.getMachine('joiner'))?.ownerUserId).toBeNull()
    // Unowned is the fail-CLOSED arm for use/manage: not ambient team compute.
    // Admins hold `see` (D19.4b quarantine) so rename is FORBIDDEN rather than
    // NOT_FOUND — the machine is visible to the people who must assign an owner.
    expect(
      (await fleetAuthzFailure(
        'machines.rename',
        { id: 'joiner' },
        deps(user(OWNER), { owner: null, machines: ['joiner'] }),
      ))?.code,
    ).toBe('NOT_FOUND')
  })
})

describe('explicit replacement pairing authority', () => {
  it('admits the retained identity grantee but refuses another member', async () => {
    const input = { replaceMachineId: 'laptop' }
    expect(await fleetAuthzFailure('machines.pairingCode', input, deps(user(OWNER), { role: 'member' }))).toBeUndefined()
    expect(await fleetAuthzFailure('machines.pairingCode', input, deps(user(COLLEAGUE), { role: 'member' }))).toMatchObject({ code: 'FORBIDDEN' })
    expect(await fleetAuthzFailure('machines.pairingCode', {}, deps(user(OWNER), { role: 'member' }))).toMatchObject({ code: 'FORBIDDEN' })
  })
})
