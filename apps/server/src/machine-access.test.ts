/**
 * The machine `use` gate (POD-381) — ADR 3 Amendment 1 D18 / ADR 9 D6 / readiness
 * §3.1.4.
 *
 * Every test here fixes a property the acceptance criteria name, and each one is
 * written so it can FAIL: a denial assertion is always paired, in the SAME
 * fixture, with a principal or a machine that IS allowed — so "denied" can never
 * be the answer the fixture gives to everything.
 */

import { asUserId, type UserId } from '@podium/model'
import type { MachineGrant, MachineId, MachineVerb } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type AgentCommandPrincipal,
  attributionOf,
  type CommandPrincipal,
  INSTANCE_OWNER,
  resolvePrincipal,
  systemPrincipal,
} from './command-principal'
import {
  canSeeMachine,
  checkMachineUse,
  machineAccessMessage,
  type MachineOwnershipIndex,
  type MachineOwnershipRow,
  machineUseDecision,
  machineVerbsFor,
  ownershipFromMachines,
} from './machine-access'

const OWNER = INSTANCE_OWNER
const COLLEAGUE: UserId = asUserId('colleague')

const user = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'admin', scope: { kind: 'all' } },
})

const agent = (
  sessionId: string,
  onBehalfOf: UserId,
  chain: string[] = [],
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

describe('the pre-accounts default preserves today: one account owns every paired machine', () => {
  it('the instance owner holds all three verbs, and a second human holds none', () => {
    const ownership = ownershipFromMachines({
      listMachines: () => [{ id: 'local', name: 'This Mac' }],
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
    const ownership = ownershipFromMachines({ listMachines: () => [{ id: 'local' }] })

    expect(checkMachineUse(user(OWNER), 'local', ownership)).toBeUndefined()
    expect(checkMachineUse(user(COLLEAGUE), 'local', ownership)).toBe('absent')
  })

  it('an owner-less machine row grants use to NOBODY (the handshake guard, unchanged)', () => {
    const ownership = ownershipTable(new Map([['legacy', { owner: null, grants: [] }]]))

    expect(checkMachineUse(user(OWNER), 'legacy', ownership)).toBe('absent')
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
    const worker = agent('agent-1', OWNER)

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
    expect(checkMachineUse(agent('agent-1', OWNER), 'laptop', ownership)).toBe('absent')
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
    const child = agent('child', OWNER, ['parent'])

    expect(checkMachineUse(user(OWNER), 'b', ownership)).toBeUndefined()
    expect(checkMachineUse(child, 'b', ownership)).toBe('unauthorized')
    // Counterfactual: the narrowing denies 'b' specifically, not everything.
    expect(checkMachineUse(child, 'a', ownership)).toBeUndefined()
  })
})

describe('the principal itself', () => {
  it('an agent chain carries exactly ONE human, taken from the ROOT and not the leaf', () => {
    const parents = new Map([
      ['child', 'parent'],
      ['parent', 'root'],
    ])
    const onBehalfOf = new Map<string, UserId>([
      ['root', COLLEAGUE],
      // A leaf-supplied delegator that must NOT win: reading the pair off the
      // leaf is exactly how a sub-agent would carry a delegator its parent lacks.
      ['child', OWNER],
    ])

    const principal = resolvePrincipal(
      { role: 'worker', scope: { kind: 'none' }, actorSessionId: 'child' },
      { parentSessionOf: (id) => parents.get(id), onBehalfOfFor: (id) => onBehalfOf.get(id) },
    )

    expect(principal.kind).toBe('agent')
    expect(principal.kind === 'agent' && principal.onBehalfOf).toBe(COLLEAGUE)
    expect(principal.kind === 'agent' && principal.chain).toEqual(['parent', 'root'])
  })

  it('a cyclic spawnedBy graph terminates instead of hanging the resolve', () => {
    const cycle = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ])

    const principal = resolvePrincipal(
      { role: 'worker', scope: { kind: 'none' }, actorSessionId: 'a' },
      { parentSessionOf: (id) => cycle.get(id) },
    )

    expect(principal.kind === 'agent' && principal.chain).toEqual(['b'])
  })

  it('a capability with no actor session is a human; attribution is a pair either way', () => {
    const human = resolvePrincipal(
      { role: 'admin', scope: { kind: 'all' } },
      { parentSessionOf: () => undefined },
    )

    expect(human).toEqual({
      kind: 'user',
      user: INSTANCE_OWNER,
      capability: { role: 'admin', scope: { kind: 'all' } },
    })
    expect(attributionOf(human)).toEqual({ actor: INSTANCE_OWNER, onBehalfOf: INSTANCE_OWNER })
    expect(attributionOf(agent('agent-1', OWNER))).toEqual({
      actor: 'session:agent-1',
      onBehalfOf: OWNER,
    })
  })

  it('a system job has no human, and holds see + use but never manage', () => {
    const ownership = ownershipFromMachines({ listMachines: () => [{ id: 'local' }] })
    const steward = systemPrincipal('steward')

    expect(attributionOf(steward)).toEqual({ actor: 'system:steward', onBehalfOf: null })
    expect([...machineVerbsFor(steward, 'local', ownership)].sort()).toEqual(['see', 'use'])
  })
})
