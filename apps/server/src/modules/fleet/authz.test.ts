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

import { FLEET_CONTRACTS, type FleetContractName } from '@podium/commands'
import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import type { MachineVerb } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../../command-principal'
import { PairingManager } from '../../hub/pairing'
import { OPERATOR } from '../../issue-authz'
import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../machine-access'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SessionStore } from '../../store'
import { SuperagentService } from '../superagent'
import { type FleetAuthzDeps, FLEET_TARGETS, fleetAuthzFailure, roleSatisfiesFloor } from './authz'

const OWNER = FIRST_ADMIN_USER_ID
const COLLEAGUE: UserId = asUserId('colleague')

const user = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'admin', scope: { kind: 'all' } },
})

/** One machine, `laptop`, owned by OWNER — plus whatever grants a test sets. */
function deps(
  principal: CommandPrincipal,
  opts: {
    role?: 'admin' | 'member'
    grants?: { subject: UserId; verb: MachineVerb }[]
    owner?: UserId | null
    machines?: string[]
  } = {},
): FleetAuthzDeps {
  const ids = opts.machines ?? ['laptop']
  const ownership: MachineOwnershipIndex = {
    rowFor: (machineId): MachineOwnershipRow | undefined =>
      ids.includes(machineId)
        ? {
            machine: machineId as MachineOwnershipRow['machine'],
            owner: opts.owner === undefined ? OWNER : opts.owner,
            grants: opts.grants ?? [],
            name: machineId,
          }
        : undefined,
  }
  return {
    principal,
    ownership,
    role: opts.role ?? 'admin',
    defaultMachine: () => ids[0] ?? 'laptop',
    allMachineIds: () => ids,
    machineName: (id) => id,
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
    expect(NAMES).toHaveLength(10)
    expect(MACHINE_COMMANDS).toHaveLength(9)
  })
})

describe('the role floor is read from the contract', () => {
  it('a member may not attempt an `admin`-floor command, and an admin may', () => {
    // `machines.pairingCode` is the only admin floor in the family (POD-384).
    const asMember = fleetAuthzFailure('machines.pairingCode', {}, deps(user(OWNER), { role: 'member' }))
    expect(asMember?.code).toBe('FORBIDDEN')

    expect(
      fleetAuthzFailure('machines.pairingCode', {}, deps(user(OWNER), { role: 'admin' })),
    ).toBeUndefined()
  })

  it('a member DOES clear the `member` floor — the floor admits, and the row gate refuses', () => {
    // POD-384's whole reasoning: the nine are `member` so that D6 M1's owner
    // column stays reachable. If the floor refused members, this would be a
    // FORBIDDEN about the floor rather than the machine.
    expect(
      fleetAuthzFailure('machines.rename', anyInput, deps(user(OWNER), { role: 'member' })),
    ).toBeUndefined()
  })

  it('a principal with NO readable account satisfies no floor', () => {
    // A disabled or unknown account reads back as `undefined` from the store.
    expect(roleSatisfiesFloor(undefined, 'member')).toBe(false)
    expect(roleSatisfiesFloor(undefined, 'admin')).toBe(false)
    // …and the same function says yes for a real one, so it is not always-false.
    expect(roleSatisfiesFloor('member', 'member')).toBe(true)
    expect(roleSatisfiesFloor('admin', 'admin')).toBe(true)
    expect(roleSatisfiesFloor('member', 'admin')).toBe(false)

    const refusal = fleetAuthzFailure(
      'machines.rename',
      anyInput,
      { ...deps(user(OWNER)), role: undefined },
    )
    expect(refusal?.code).toBe('FORBIDDEN')
  })

  it('a system principal clears every floor — in-process only, and it has no account', () => {
    expect(
      fleetAuthzFailure(
        'machines.pairingCode',
        {},
        { ...deps(systemPrincipal('boot-reconcile')), role: undefined },
      ),
    ).toBeUndefined()
  })
})

describe('the machine verb is read from the contract, per command', () => {
  it.each(MACHINE_COMMANDS)('%s refuses a colleague who cannot see the machine', (name) => {
    const refusal = fleetAuthzFailure(name, anyInput, deps(user(COLLEAGUE)))
    expect(refusal?.code).toBe('NOT_FOUND')
    // The SAME words a never-paired id gets: the refusal must not disclose that
    // this machine exists (D20 / readiness §3.1.2).
    expect(refusal?.message).toContain('unknown machine')
  })

  it.each(MACHINE_COMMANDS)('%s admits the machine OWNER', (name) => {
    expect(fleetAuthzFailure(name, anyInput, deps(user(OWNER)))).toBeUndefined()
  })

  it('a `see` grant is not enough for a `manage` command, and IS enough to be told forbidden', () => {
    const seeOnly = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'see' }] })
    const refusal = fleetAuthzFailure('machines.rename', anyInput, seeOnly)

    // Inside the `see` set the answer changes from "does not exist" to "you may
    // not" — which is the M5 distinction, and the reason `see` is a real verb.
    expect(refusal?.code).toBe('FORBIDDEN')
  })

  it('a `manage` grant admits the manage family and NOT the use family', () => {
    const manage = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'manage' }] })

    expect(fleetAuthzFailure('machines.rename', anyInput, manage)).toBeUndefined()
    expect(fleetAuthzFailure('repos.add', anyInput, manage)).toBeUndefined()
    // `discovery.scanMachine` walks the target's filesystem through its daemon —
    // POD-384 classified it `use` for exactly this reason, and a manage grant
    // must not carry it.
    expect(fleetAuthzFailure('discovery.scanMachine', anyInput, manage)?.code).toBe('FORBIDDEN')
  })

  it('a `use` grant admits the discovery family and NOT the manage family', () => {
    const use = deps(user(COLLEAGUE), { grants: [{ subject: COLLEAGUE, verb: 'use' }] })

    expect(fleetAuthzFailure('discovery.scanMachine', anyInput, use)).toBeUndefined()
    expect(fleetAuthzFailure('machines.revoke', anyInput, use)?.code).toBe('FORBIDDEN')
  })

  it('an omitted machine selector is gated against the DEFAULT machine, not waved through', () => {
    // `repos.add` with no `machineId` resolves `machines.defaultMachine()` in the
    // handler. If the gate treated "no selector" as "no machine", the whole repo
    // family would be ungated by simply leaving the field out.
    const colleague = deps(user(COLLEAGUE))
    expect(fleetAuthzFailure('repos.add', { path: '/repo' }, colleague)?.code).toBe('NOT_FOUND')
    expect(fleetAuthzFailure('repos.add', { path: '/repo' }, deps(user(OWNER)))).toBeUndefined()
  })

  it('`machines.pairingCode` names no machine and is gated by its floor alone', () => {
    // It carries no `machineVerb` (there is no machine yet), so a principal that
    // can see nothing still passes once the floor is met.
    expect(
      fleetAuthzFailure('machines.pairingCode', {}, deps(user(COLLEAGUE), { role: 'admin' })),
    ).toBeUndefined()
  })

  it('the fleet-wide command is narrowed, not refused, while it can reach ANY machine', () => {
    const two = { machines: ['laptop', 'workstation'] }
    // The colleague holds `use` on one of the two.
    const partial = deps(user(COLLEAGUE), {
      ...two,
      grants: [{ subject: COLLEAGUE, verb: 'use' }],
    })
    expect(fleetAuthzFailure('discovery.refreshRepos', undefined, partial)).toBeUndefined()

    // …and is refused when it can reach none, rather than silently scanning
    // everybody's machines.
    const none = deps(user(COLLEAGUE), two)
    expect(fleetAuthzFailure('discovery.refreshRepos', undefined, none)?.code).toBe('NOT_FOUND')
  })
})

/**
 * THE WIRING ARM. Every assertion above is about a function; these are about the
 * SERVED procedure, and they would all pass against a gate nothing calls if the
 * refusing case were missing. The refusal is produced by an unowned row.
 */
describe('the derived fleet router actually calls the gate', () => {
  function caller(ownerUserId: string | null) {
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({
      id: 'm1',
      name: 'machine-one',
      hostname: 'host-one',
      tokenHash: 'h1',
      ownerUserId,
    })
    const registry = new SessionRegistry(store, undefined, { pairing: new PairingManager() })
    registry.modules.machines.ensureLocalMachine()
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
    return {
      store,
      call: appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR }),
    }
  }

  const edge = (verb: 'see' | 'use' | 'manage', resourceId = 'm1') => ({
    resourceKind: 'machine',
    resourceId,
    grantee: FIRST_ADMIN_USER_ID,
    verb,
    owner: 'someone-else',
    visibility: 'owned-compute',
    createdAt: '2026-07-30T00:00:00.000Z',
    actorKind: 'user',
    actorId: 'someone-else',
    onBehalfOf: 'someone-else',
  })

  it('renames a machine the caller owns', async () => {
    const { call } = caller(FIRST_ADMIN_USER_ID)
    const after = await call.machines.rename({ id: 'm1', name: 'renamed' })
    expect(after.find((m) => m.id === 'm1')?.name).toBe('renamed')
  })

  it('refuses to rename an UNOWNED machine, with the unknown-machine wording', async () => {
    const { call, store } = caller(null)

    await expect(call.machines.rename({ id: 'm1', name: 'renamed' })).rejects.toThrow(
      /unknown machine/,
    )
    // And the write did not happen — the refusal is before the handler, not a
    // message alongside a completed rename.
    expect(store.machines.getMachine('m1')?.name).toBe('machine-one')
  })

  it('refuses a repo write against an unowned machine', async () => {
    const { call } = caller(null)
    await expect(call.repos.add({ path: '/tmp/x', machineId: 'm1' })).rejects.toThrow(
      /unknown machine/,
    )
  })

  it('an unowned machine refuses EVERYONE, grant or no grant', async () => {
    const { call, store } = caller(null)
    store.grants.upsert(edge('manage'))

    // `machineUseAllowed`'s rule, reaching the router: an owner-less machine is
    // not team compute with an empty ACL, it is a machine nobody may touch. A
    // grant issued against it confers nothing, because there was no owner whose
    // rights the grant could have been within (ADR 9 D2 rule 4).
    await expect(call.machines.rename({ id: 'm1', name: 'granted' })).rejects.toThrow(
      /unknown machine/,
    )
  })

  it("a grant on SOMEBODY ELSE'S machine is what admits the caller — and its absence refuses", async () => {
    // The only shape in which this build can express a second person: the ROW
    // names an owner the transport cannot authenticate as. The caller is the sole
    // account, and the machine is not theirs.
    const { call, store } = caller('someone-else')

    await expect(call.machines.rename({ id: 'm1', name: 'nope' })).rejects.toThrow(
      /unknown machine/,
    )

    store.grants.upsert(edge('manage'))

    const after = await call.machines.rename({ id: 'm1', name: 'granted' })
    expect(after.find((m) => m.id === 'm1')?.name).toBe('granted')

    // …and revoking it takes effect at the NEXT call, with nothing to invalidate.
    store.grants.remove('machine', 'm1', FIRST_ADMIN_USER_ID, 'manage')
    await expect(call.machines.rename({ id: 'm1', name: 'again' })).rejects.toThrow(
      /unknown machine/,
    )
  })

  it('a `manage` grant does not carry `use`: discovery on the same machine is still refused', async () => {
    const { call, store } = caller('someone-else')
    store.grants.upsert(edge('manage'))

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
  function service() {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { pairing: new PairingManager() })
    return { store, machines: registry.modules.machines }
  }

  const pairFrame = (code: string) =>
    ({
      type: 'pair' as const,
      code,
      machineId: 'joiner',
      hostname: 'joiner.local',
      name: 'joiner',
    })

  it('the pairer named at mint becomes the owner of the machine that redeems the code', () => {
    const { store, machines } = service()
    const code = machines.mintPairingCode({ ownerUserId: FIRST_ADMIN_USER_ID })

    expect(machines.authenticateDaemon(pairFrame(code)).ok).toBe(true)
    expect(store.machines.getMachine('joiner')?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
  })

  it('a code minted with NO pairer produces an unowned machine — refused, not shared', () => {
    const { store, machines } = service()
    const code = machines.mintPairingCode({})

    expect(machines.authenticateDaemon(pairFrame(code)).ok).toBe(true)
    expect(store.machines.getMachine('joiner')?.ownerUserId).toBeNull()
    // Unowned is the fail-CLOSED arm: `machineUseAllowed` refuses everyone,
    // rather than the machine landing as ambient team compute.
    expect(
      fleetAuthzFailure(
        'machines.rename',
        { id: 'joiner' },
        deps(user(OWNER), { owner: null, machines: ['joiner'] }),
      )?.code,
    ).toBe('NOT_FOUND')
  })
})
