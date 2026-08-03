/**
 * The machine `use` gate (POD-381) — ADR 3 Amendment 1 D18 / ADR 9 D6 / readiness
 * §3.1.4.
 *
 * Every test here fixes a property the acceptance criteria name, and each one is
 * written so it can FAIL: a denial assertion is always paired, in the SAME
 * fixture, with a principal or a machine that IS allowed — so "denied" can never
 * be the answer the fixture gives to everything.
 */

import type { MachineId } from '@podium/model'
import { asSessionId, asUserId, type SessionId, type UserId } from '@podium/model'
import type { MachineGrant, MachineVerb } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type AgentCommandPrincipal,
  attributionOf,
  type CommandPrincipal,
  FIRST_ADMIN_USER_ID,
  resolvePrincipal,
  systemPrincipal,
} from './command-principal'
import {
  canSeeMachine,
  checkMachineUse,
  isMachineOwner,
  type MachineOwnershipIndex,
  type MachineOwnershipRow,
  machineAccessMessage,
  machineUseDecision,
  machineVerbsFor,
  ownershipFromMachines,
} from './machine-access'

const OWNER = FIRST_ADMIN_USER_ID
const COLLEAGUE: UserId = asUserId('colleague')

const user = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: {
    role: 'admin',
    scope: { kind: 'all' },
    actorUser: FIRST_ADMIN_USER_ID,
    onBehalfOf: FIRST_ADMIN_USER_ID,
  },
})

const agent = (
  sessionId: SessionId,
  onBehalfOf: UserId,
  chain: SessionId[] = [],
): AgentCommandPrincipal => ({
  kind: 'agent',
  agentSessionId: sessionId,
  onBehalfOf,
  capability: { role: 'worker', scope: { kind: 'none' }, actorSessionId: sessionId },
  chain,
})

/** A MUTABLE ownership table, so a test can revoke a grant between two applies. */
function ownershipTable(
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>,
  delegated?: Map<string, string[]>,
): MachineOwnershipIndex {
  return {
    rowFor: (machineId): MachineOwnershipRow | undefined => {
      const row = rows.get(machineId)
      if (!row) return undefined
      return {
        machine: machineId as MachineId,
        owner: row.owner,
        grants: row.grants,
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    },
    delegatedMachines: (sessionId) => {
      const allowed = delegated?.get(sessionId)
      return allowed === undefined ? undefined : new Set(allowed)
    },
  }
}

const grant = (subject: UserId, verb: MachineVerb): MachineGrant => ({ subject, verb })

/**
 * THE DERIVATION'S OWN INSTRUMENT CHECK (POD-642's rule, type-level half).
 *
 * `MachineOwnershipRow` is a `Pick` of the handshake's `ResolvedMachine` rather
 * than a restatement of its four keys. A schema fork is caught by asserting
 * instance identity with `toBe`; a TYPE fork cannot be, because there is no
 * runtime value to compare — so the protection is the derivation, and a
 * derivation needs proof it is not VACUOUS. One that resolved to `any` or to
 * `string` would compile, would forbid nothing, and would be completely silent.
 *
 * These probes are self-verifying in both directions. If the derivation went
 * vacuous, the `@ts-expect-error` lines would have nothing to suppress and the
 * compiler reports TS2578 on them — the probe fails LOUDLY rather than passing
 * empty. And the accepted row below proves it can still say yes.
 */
const _derivationIsNotVacuous: MachineOwnershipRow = {
  machine: 'box' as MachineId,
  owner: OWNER,
  grants: [],
}
void _derivationIsNotVacuous

// @ts-expect-error `owner` is a branded UserId, not any string — if the Pick
// collapsed, this line would have nothing to suppress.
const _ownerIsBranded: MachineOwnershipRow = { machine: 'box' as MachineId, owner: 'x', grants: [] }
void _ownerIsBranded

// @ts-expect-error `grants` is required — a Pick that lost the key would make
// this object legal.
const _grantsAreRequired: MachineOwnershipRow = { machine: 'box' as MachineId, owner: null }
void _grantsAreRequired

describe("the owner column decides: the machine's owner holds all three verbs, nobody else does", () => {
  it('the owner holds all three verbs, and a second human holds none', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'local', name: 'This Mac', ownerUserId: OWNER }],
    })

    expect([...machineVerbsFor(user(OWNER), 'local', ownership)].sort()).toEqual([
      'manage',
      'see',
      'use',
    ])
    expect([...machineVerbsFor(user(COLLEAGUE), 'local', ownership)]).toEqual([])
  })

  it("M4, the all-in-one case: authenticating to a server running on the owner's Mac does not confer execute on it", () => {
    // The `local` daemon IS the host machine. The owner may use it — so this is
    // not a fixture that denies everybody — and the colleague may not.
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'local', ownerUserId: OWNER }],
    })

    expect(checkMachineUse(user(OWNER), 'local', ownership)).toBeUndefined()
    expect(checkMachineUse(user(COLLEAGUE), 'local', ownership)).toBe('absent')
  })

  it('an owner-less machine row grants use to NOBODY (quarantine: admin see, nobody use)', () => {
    // D19.4b: unowned / quarantine is usable by nobody. Admins hold `see` so they
    // can assign an owner; that is not ambient execute. Members still cannot see.
    const ownership = ownershipTable(new Map([['legacy', { owner: null, grants: [] }]]))

    expect(checkMachineUse(user(OWNER), 'legacy', ownership)).toBe('unauthorized')
    expect(canSeeMachine(user(OWNER), 'legacy', ownership)).toBe(true)
    expect(machineVerbsFor(user(OWNER), 'legacy', ownership)).toEqual(new Set(['see']))
    const member: CommandPrincipal = {
      kind: 'user',
      user: COLLEAGUE,
      capability: {
        role: 'worker',
        scope: { kind: 'owned', userId: COLLEAGUE },
        actorUser: COLLEAGUE,
        onBehalfOf: COLLEAGUE,
      },
    }
    expect(checkMachineUse(member, 'legacy', ownership)).toBe('absent')
    expect(canSeeMachine(member, 'legacy', ownership)).toBe(false)
  })
})

describe('the retired sentinels get no arm of their own (POD-318)', () => {
  // `'local'` and `'__local__'` used to routinely have NO machines-table row —
  // a fresh session sat on the placeholder until something adopted it — so this
  // module carried a SYNTHESIZED row for them, owned by the instance installer.
  // The host's row is written at boot now, before any session can exist, and the
  // two literals name nothing at all. What replaces the arm is the plain rule.
  const noRows = ownershipTable(new Map())

  it.each([
    'local',
    '__local__',
    'localhost',
    'local-2',
    'Local',
    '__local',
    'box',
  ])('no row means absent, for %s exactly like any other unknown id', (unknown) => {
    expect(checkMachineUse(user(OWNER), unknown, noRows)).toBe('absent')
    expect(checkMachineUse(user(COLLEAGUE), unknown, noRows)).toBe('absent')
  })

  it('the HOST is usable because it has a real owned row, not because of its id', () => {
    // The counterfactual for the assertion above: the same gate says YES here,
    // so "absent everywhere" cannot be what these tests are actually pinning.
    // `ensureHostMachine` writes exactly this row at boot, under a minted UUID.
    const host = '9f1d0c2e-7c4a-4a1f-8f2e-2a0d0b7c9e51'
    const owned = ownershipTable(new Map([[host, { owner: OWNER, grants: [] }]]))

    expect(checkMachineUse(user(OWNER), host, owned)).toBeUndefined()
    // …and M4 still holds on it: a second human authenticating to a server on
    // the owner's Mac is refused execute, exactly as on any machine they do not own.
    expect(checkMachineUse(user(COLLEAGUE), host, owned)).toBe('absent')
  })
})

describe('absent / unauthorized are two different answers', () => {
  it('a machine the principal cannot SEE fails identically to one that was never paired', () => {
    const ownership = ownershipTable(
      new Map([
        ['owned', { owner: OWNER, grants: [] }],
        ['theirs', { owner: COLLEAGUE, grants: [], name: 'Their Mac' }],
      ]),
    )

    const invisible = checkMachineUse(user(OWNER), 'theirs', ownership)
    const nonexistent = checkMachineUse(user(OWNER), 'never-paired', ownership)

    // The check can say yes in this same fixture...
    expect(checkMachineUse(user(OWNER), 'owned', ownership)).toBeUndefined()
    // ...and the two failures are the SAME failure, message included. That
    // identity IS the property (D20's consistent-error rule).
    expect(invisible).toBe('absent')
    expect(nonexistent).toBe('absent')
    expect(machineAccessMessage('absent', 'theirs', 'Their Mac')).toBe("unknown machine 'theirs'")
    expect(machineAccessMessage('absent', 'never-paired', undefined)).toBe(
      "unknown machine 'never-paired'",
    )
  })

  it('inside the SEE set, unauthorized is its own answer and is not the absent one (M5)', () => {
    // `see` without `use`: the fleet view shows the machine, and spawning on it
    // is refused with a reason that is neither "offline" nor "no such machine".
    const ownership = ownershipTable(
      new Map([['shared', { owner: COLLEAGUE, grants: [grant(OWNER, 'see')], name: 'Shared' }]]),
    )

    expect(canSeeMachine(user(OWNER), 'shared', ownership)).toBe(true)
    expect(checkMachineUse(user(OWNER), 'shared', ownership)).toBe('unauthorized')
    expect(machineAccessMessage('unauthorized', 'shared', 'Shared')).toBe(
      "you do not have access to run agents on machine 'Shared'",
    )
    expect(machineAccessMessage('unauthorized', 'shared', 'Shared')).not.toBe(
      machineAccessMessage('absent', 'shared', 'Shared'),
    )
  })

  it("a `see` grant never implies `use` — M2's boundary is not an ordinary visibility bit", () => {
    const ownership = ownershipTable(
      new Map([
        ['seen', { owner: COLLEAGUE, grants: [grant(OWNER, 'see')] }],
        ['used', { owner: COLLEAGUE, grants: [grant(OWNER, 'use')] }],
      ]),
    )

    expect(machineUseDecision(user(OWNER), 'seen', ownership)).toBe('denied')
    expect(machineUseDecision(user(OWNER), 'used', ownership)).toBe('granted')
  })
})

describe('agent delegation resolves LIVE, with no reaper', () => {
  it('an agent whose human loses the grant is denied on the NEXT apply, same principal object', () => {
    const rows = new Map([['laptop', { owner: COLLEAGUE, grants: [grant(OWNER, 'use')] }]])
    const ownership = ownershipTable(rows)
    const worker = agent(asSessionId('agent-1'), OWNER)

    expect(checkMachineUse(worker, 'laptop', ownership)).toBeUndefined()

    // Revoke the HUMAN's grant. Nothing notifies the agent; nothing kills it.
    rows.set('laptop', { owner: COLLEAGUE, grants: [] })

    expect(checkMachineUse(worker, 'laptop', ownership)).toBe('absent')
  })

  it('an agent can never exceed its delegating human', () => {
    const ownership = ownershipTable(new Map([['laptop', { owner: COLLEAGUE, grants: [] }]]))

    // The colleague owns it; an agent acting for the OWNER may not use it, even
    // though its capability is otherwise unconstrained.
    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBeUndefined()
    expect(checkMachineUse(agent(asSessionId('agent-1'), OWNER), 'laptop', ownership)).toBe(
      'absent',
    )
  })

  it('a sub-agent cannot reach past a machine its PARENT could not use', () => {
    const ownership = ownershipTable(
      new Map([
        ['a', { owner: OWNER, grants: [] }],
        ['b', { owner: OWNER, grants: [] }],
      ]),
      // The PARENT's delegation is narrowed to machine 'a'. The human may still
      // use 'b' — which is what makes this a CHAIN test rather than a second run
      // of the human gate above.
      new Map([['parent', ['a']]]),
    )
    const child = agent(asSessionId('child'), OWNER, [asSessionId('parent')])

    expect(checkMachineUse(user(OWNER), 'b', ownership)).toBeUndefined()
    expect(checkMachineUse(child, 'b', ownership)).toBe('unauthorized')
    // Counterfactual: the narrowing denies 'b' specifically, not everything.
    expect(checkMachineUse(child, 'a', ownership)).toBeUndefined()
  })
})

describe('the principal itself', () => {
  it('an agent chain carries exactly ONE human, taken from the ROOT and not the leaf', () => {
    const parents = new Map<SessionId, SessionId>([
      [asSessionId('child'), asSessionId('parent')],
      [asSessionId('parent'), asSessionId('root')],
    ])
    const onBehalfOf = new Map<SessionId, UserId>([
      [asSessionId('root'), COLLEAGUE],
      // A leaf-supplied delegator that must NOT win: reading the pair off the
      // leaf is exactly how a sub-agent would carry a delegator its parent lacks.
      [asSessionId('child'), OWNER],
    ])

    const principal = resolvePrincipal(
      { role: 'worker', scope: { kind: 'none' }, actorSessionId: asSessionId('child') },
      { parentSessionOf: (id) => parents.get(id), onBehalfOfFor: (id) => onBehalfOf.get(id) },
    )

    expect(principal.kind).toBe('agent')
    expect(principal.kind === 'agent' && principal.onBehalfOf).toBe(COLLEAGUE)
    expect(principal.kind === 'agent' && principal.chain).toEqual(['parent', 'root'])
  })

  it('a cyclic spawnedBy graph terminates instead of hanging the resolve', () => {
    const cycle = new Map<SessionId, SessionId>([
      [asSessionId('a'), asSessionId('b')],
      [asSessionId('b'), asSessionId('a')],
    ])

    const principal = resolvePrincipal(
      {
        role: 'worker',
        scope: { kind: 'none' },
        actorSessionId: asSessionId('a'),
        onBehalfOf: OWNER,
      },
      { parentSessionOf: (id) => cycle.get(id) },
    )

    expect(principal.kind === 'agent' && principal.chain).toEqual(['b'])
  })

  it('a capability with no actor session is a human; attribution is a pair either way', () => {
    const human = resolvePrincipal(
      {
        role: 'admin',
        scope: { kind: 'all' },
        actorUser: FIRST_ADMIN_USER_ID,
        onBehalfOf: FIRST_ADMIN_USER_ID,
      },
      { parentSessionOf: () => undefined },
    )

    expect(human).toEqual({
      kind: 'user',
      user: FIRST_ADMIN_USER_ID,
      capability: {
        role: 'admin',
        scope: { kind: 'all' },
        actorUser: FIRST_ADMIN_USER_ID,
        onBehalfOf: FIRST_ADMIN_USER_ID,
      },
    })
    expect(attributionOf(human)).toEqual({
      actor: FIRST_ADMIN_USER_ID,
      onBehalfOf: FIRST_ADMIN_USER_ID,
    })
    expect(attributionOf(agent(asSessionId('agent-1'), OWNER))).toEqual({
      actor: 'session:agent-1',
      onBehalfOf: OWNER,
    })
  })

  it('a system job has no human, and holds see + use but never manage', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'local', ownerUserId: OWNER }],
    })
    const steward = systemPrincipal('steward')

    expect(attributionOf(steward)).toEqual({ actor: 'system:steward', onBehalfOf: null })
    expect([...machineVerbsFor(steward, 'local', ownership)].sort()).toEqual(['see', 'use'])
  })
})

/**
 * THE PERSISTED HALF (POD-1079) — `ownershipFromMachines` over a source that
 * carries a real owner column and real grant edges, rather than over the
 * one-account default it replaced.
 *
 * The fixtures below are MUTABLE and every principal in them is a COLLEAGUE,
 * never the owner. POD-351's failure was a revocation suite that ran as a
 * principal whose scope short-circuited the check before ownership was read: it
 * would have passed against an implementation with no ownership check at all.
 * A colleague has no such short-circuit, so a `denied` here is a real denial.
 */
describe('ownership and grants come from the source, live', () => {
  /** A source whose rows and edges can be edited BETWEEN two decisions. */
  function liveSource() {
    const rows = new Map<string, string | null>([['laptop', OWNER]])
    const edges = new Map<string, { grantee: string; verb: string }[]>()
    return {
      rows,
      edges,
      source: {
        ownershipRows: () => [...rows].map(([id, ownerUserId]) => ({ id, ownerUserId })),
        grantsForMachine: (machineId: string) => edges.get(machineId) ?? [],
      },
    }
  }

  it('a `use` grant admits a colleague the owner column alone would refuse', () => {
    const { edges, source } = liveSource()
    const ownership = ownershipFromMachines(source)

    // The instrument can say NO first — this is the state before the share.
    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBe('absent')

    edges.set('laptop', [{ grantee: COLLEAGUE, verb: 'use' }])

    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBeUndefined()
    // …and the owner is unaffected, so the fixture is not simply permissive now.
    expect(checkMachineUse(user(OWNER), 'laptop', ownership)).toBeUndefined()
  })

  it('REVOCATION takes effect at the next decision, with nothing to invalidate', () => {
    const { edges, source } = liveSource()
    const ownership = ownershipFromMachines(source)
    edges.set('laptop', [{ grantee: COLLEAGUE, verb: 'use' }])
    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBeUndefined()

    edges.set('laptop', [])

    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBe('absent')
  })

  it('`see` alone discloses existence and REFUSES execution — the M2 line', () => {
    const { edges, source } = liveSource()
    const ownership = ownershipFromMachines(source)
    edges.set('laptop', [{ grantee: COLLEAGUE, verb: 'see' }])

    expect(canSeeMachine(user(COLLEAGUE), 'laptop', ownership)).toBe(true)
    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBe('unauthorized')
  })

  it('an owner-less row refuses use to everyone, including the owner of OTHER machines', () => {
    // D19.4b quarantine: the first admin may SEE the orphan (to assign an owner)
    // but holds neither use nor manage on it — ownership of other machines does
    // not spill. A member still cannot see it at all.
    const { rows, source } = liveSource()
    rows.set('orphan', null)
    const ownership = ownershipFromMachines(source)

    expect(checkMachineUse(user(OWNER), 'orphan', ownership)).toBe('unauthorized')
    expect(canSeeMachine(user(OWNER), 'orphan', ownership)).toBe(true)
    expect(checkMachineUse(user(OWNER), 'laptop', ownership)).toBeUndefined()
  })

  it('a stored verb this build does not know is DROPPED rather than admitted', () => {
    const { edges, source } = liveSource()
    const ownership = ownershipFromMachines(source)
    edges.set('laptop', [
      { grantee: COLLEAGUE, verb: 'teleport' },
      // `read` and `write` are real GRANT_VERBS — for other classes. Neither is a
      // machine verb, and neither may leak in as one.
      { grantee: COLLEAGUE, verb: 'write' },
    ])

    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBe('absent')

    // The same source, one line different, says YES — so the refusal above is
    // about the VERB and not about the fixture being unable to grant anything.
    edges.set('laptop', [{ grantee: COLLEAGUE, verb: 'use' }])
    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBeUndefined()
  })

  it('a source with no grant half resolves owner-only — the closed direction', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'laptop', ownerUserId: OWNER }],
    })

    expect(checkMachineUse(user(COLLEAGUE), 'laptop', ownership)).toBe('absent')
    expect(checkMachineUse(user(OWNER), 'laptop', ownership)).toBeUndefined()
  })
})

/**
 * THE TRANSFER AUTHORITY (POD-1495) — `isMachineOwner`, which now has two
 * callers that must agree: the gate that REFUSES `machines.transferOwnership`
 * and the wire projection that decides whether the settings panel OFFERS it.
 *
 * Each denial below is paired, in the same fixture, with the owner saying YES,
 * so no assertion can be satisfied by a fixture that simply denies everyone.
 */
describe('isMachineOwner: the one predicate behind both the transfer gate and the offer', () => {
  it('the owner is the owner; a second human with no edge at all is not', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'laptop', name: 'Laptop', ownerUserId: OWNER }],
    })

    expect(isMachineOwner(user(OWNER), 'laptop', ownership)).toBe(true)
    expect(isMachineOwner(user(COLLEAGUE), 'laptop', ownership)).toBe(false)
  })

  it('A MANAGE GRANTEE IS NOT AN OWNER — the FORBIDDEN the panel must never offer', () => {
    // The colleague holds the STRONGEST verb a machine can grant, and holding it
    // is proved here rather than assumed: `manage` is in their verb set, and
    // ownership is still refused. That is the whole point of the predicate —
    // giving the machine away is larger than any verb the machine can grant.
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'laptop', ownerUserId: OWNER }],
      grantsForMachine: () => [{ grantee: COLLEAGUE, verb: 'manage' }],
    })

    expect(machineVerbsFor(user(COLLEAGUE), 'laptop', ownership).has('manage')).toBe(true)
    expect(isMachineOwner(user(COLLEAGUE), 'laptop', ownership)).toBe(false)
    expect(isMachineOwner(user(OWNER), 'laptop', ownership)).toBe(true)
  })

  it('AN UNOWNED MACHINE IS TRANSFERABLE BY NOBODY — not even the admin who can see it', () => {
    // D19.4b: owner null is quarantine. An admin holds `see` on it (proved
    // below, so the fixture is not merely invisible), and still owns nothing —
    // adopting an unowned machine is a different act with different authority.
    const ownership = ownershipFromMachines({
      ownershipRows: () => [
        { id: 'orphan', ownerUserId: null },
        { id: 'laptop', ownerUserId: OWNER },
      ],
    })

    expect(canSeeMachine(user(OWNER), 'orphan', ownership)).toBe(true)
    expect(isMachineOwner(user(OWNER), 'orphan', ownership)).toBe(false)
    // Same principal, same call, a machine it DOES own: the false above is about
    // the empty owner column, not about the principal.
    expect(isMachineOwner(user(OWNER), 'laptop', ownership)).toBe(true)
  })

  it('an unknown machine id owns nothing, and a system principal owns nothing either', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'laptop', ownerUserId: OWNER }],
    })

    expect(isMachineOwner(user(OWNER), 'no-such-machine', ownership)).toBe(false)
    // A system principal holds `see` and `use` — proved, so this is not a
    // fixture that refuses it everything — but it acts for no human, and there
    // is no account to hand a machine to.
    expect(machineVerbsFor(systemPrincipal('steward'), 'laptop', ownership).has('use')).toBe(true)
    expect(isMachineOwner(systemPrincipal('steward'), 'laptop', ownership)).toBe(false)
  })

  it('an agent is the owner exactly when ITS HUMAN is — never on its own account', () => {
    const ownership = ownershipFromMachines({
      ownershipRows: () => [{ id: 'laptop', ownerUserId: OWNER }],
    })
    const session = asSessionId('s-1')

    expect(isMachineOwner(agent(session, OWNER), 'laptop', ownership)).toBe(true)
    expect(isMachineOwner(agent(session, COLLEAGUE), 'laptop', ownership)).toBe(false)
  })
})
