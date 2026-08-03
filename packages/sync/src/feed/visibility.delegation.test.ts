/**
 * THE DELEGATION PORT — ADR 9 D5 A1/A2, as its own unit (POD-1196).
 *
 * The conformance suite exercises delegation end to end, but through a whole
 * authority; these cases pin the three properties the PORT is responsible for,
 * where a failure names the defect instead of surfacing as a wrong slice:
 *
 *   A2  an agent sees its human's rights INTERSECTED with its own scope
 *   A1  the scope is resolved LIVE, never cached across evaluations
 *       — and the port is not consulted at all for a principal with no delegation
 */

import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  asUserId,
  type Principal,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type DelegationScopePort,
  entityKey,
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  type VisibilityStatePort,
} from './visibility'

const REF: EntityRef = { entity: 'session', entityId: 's1' }

/** The HUMAN may read everything here, so every refusal below is the ceiling. */
const permissiveTables: VisibilityStatePort = {
  classOf: () => 'personal',
  mayRead: () => true,
  keyedUserOf: () => null,
}

const agent = (delegation: string): Principal => ({
  kind: 'agent',
  agentIdentity: asAgentIdentityId('agent-7'),
  onBehalfOf: asUserId('alice'),
  device: asDeviceId('conn-1'),
  capability: asCapabilityRef('cap:a'),
  delegation: asDelegationRef(delegation),
})

const human: Principal = {
  kind: 'user',
  user: asUserId('alice'),
  device: asDeviceId('conn-1'),
  capability: asCapabilityRef('cap:a'),
}

describe('A2 — an agent is bounded by what it was spawned for', () => {
  it('refuses an entity the human MAY read but the agent was not spawned for', () => {
    const delegations: DelegationScopePort = {
      scopeOf: () => ({ kind: 'entities', keys: new Set([entityKey('session', 'OTHER')]) }),
    }
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, delegations)

    // The human's answer is YES — so a refusal here can only be the ceiling.
    expect(policy.decide(human, REF).visible).toBe(true)
    expect(policy.decide(agent('del-narrow'), REF)).toEqual({
      visible: false,
      reason: 'outside-delegated-scope',
    })
  })

  it('admits the same entity under a delegation whose scope contains it', () => {
    const delegations: DelegationScopePort = {
      scopeOf: () => ({ kind: 'entities', keys: new Set([entityKey('session', 's1')]) }),
    }
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, delegations)

    expect(policy.decide(agent('del-broad'), REF)).toEqual({ visible: true, reason: 'granted' })
  })

  it('is an INTERSECTION, never a union: scope cannot widen past the human', () => {
    // The human may read NOTHING; the agent's scope names the entity anyway.
    const denyHuman: VisibilityStatePort = { ...permissiveTables, mayRead: () => false }
    const delegations: DelegationScopePort = {
      scopeOf: () => ({ kind: 'entities', keys: new Set([entityKey('session', 's1')]) }),
    }
    const policy = new GrantEdgeVisibilityPolicy(denyHuman, delegations)

    expect(policy.decide(agent('del-broad'), REF)).toEqual({
      visible: false,
      reason: 'personal-not-granted',
    })
  })
})

describe('A1 — the scope is resolved live, never frozen', () => {
  it('consults the port on EVERY decide', () => {
    let calls = 0
    const delegations: DelegationScopePort = {
      scopeOf: () => {
        calls += 1
        return { kind: 'all' }
      },
    }
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, delegations)

    policy.decide(agent('del-1'), REF)
    policy.decide(agent('del-1'), REF)

    // A cached ceiling outlives the delegation that granted it — the agent would
    // keep its reach after the revoke, which is exactly what A1 forbids.
    expect(calls).toBe(2)
  })

  it('follows the port when the scope NARROWS between two evaluations', () => {
    // The stronger form of the same property: counting calls proves it asked,
    // this proves it USED the new answer.
    let wide = true
    const delegations: DelegationScopePort = {
      scopeOf: () =>
        wide
          ? { kind: 'entities', keys: new Set([entityKey('session', 's1')]) }
          : { kind: 'entities', keys: new Set() },
    }
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, delegations)

    expect(policy.decide(agent('del-1'), REF).visible).toBe(true)
    wide = false
    expect(policy.decide(agent('del-1'), REF)).toEqual({
      visible: false,
      reason: 'outside-delegated-scope',
    })
  })

  it('never consults the port for a principal that carries no delegation', () => {
    let calls = 0
    const delegations: DelegationScopePort = {
      scopeOf: () => {
        calls += 1
        return { kind: 'all' }
      },
    }
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, delegations)

    expect(policy.decide(human, REF)).toEqual({ visible: true, reason: 'granted' })
    // A human's own connection is not scope-limited, and asking would invite a
    // port implementation to answer for one.
    expect(calls).toBe(0)
  })
})

describe('a principal with no human is outside the grant model', () => {
  it('refuses a system principal default-closed rather than inventing a human', () => {
    const policy = new GrantEdgeVisibilityPolicy(permissiveTables, {
      scopeOf: () => ({ kind: 'all' }),
    })
    const system: Principal = { kind: 'system', job: 'steward' }

    // ADR 3 Am1 D14.2/D21: no user, never assigned one. ADR 9 D8 S5 forbids
    // defaulting it to an operator — so the answer is NO, not a borrowed yes.
    expect(policy.decide(system, REF).visible).toBe(false)
  })
})
