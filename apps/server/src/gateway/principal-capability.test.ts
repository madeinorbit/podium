/**
 * ACTOR AND ON-BEHALF-OF, FROM THE TRANSPORT INTO THE COMMAND LAYER — ADR 3
 * Amendment 1 D17. The capability built here is the value `authorize()` consumes,
 * so these cases are the proof that both halves survive the trip and that neither
 * is ever defaulted.
 */

import { asIssueId, authorize, capabilityAttribution, type IssueScope } from '@podium/model'
import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  asUserId,
  type MachineId,
  type Principal,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { capabilityFromPrincipal } from './principal-capability'

const ALL: IssueScope = { kind: 'all' }
const cap = asCapabilityRef('cap:test')

const userPrincipal: Principal = {
  kind: 'user',
  user: asUserId('usr-ada'),
  device: asDeviceId('dev-laptop'),
  capability: cap,
}

const agentPrincipal: Principal = {
  kind: 'agent',
  agentIdentity: asAgentIdentityId('sess-agent-1'),
  onBehalfOf: asUserId('usr-ada'),
  device: asDeviceId('conn-9'),
  capability: cap,
  delegation: asDelegationRef('del-1'),
}

describe('capabilityFromPrincipal', () => {
  it('a human is both halves of the pair, and it is still a pair', () => {
    const capability = capabilityFromPrincipal(userPrincipal, { role: 'admin', scope: ALL })
    expect(capabilityAttribution(capability)).toEqual({ actor: 'usr-ada', onBehalfOf: 'usr-ada' })
  })

  it('an agent is the actor; its human is the on-behalf-of', () => {
    const capability = capabilityFromPrincipal(agentPrincipal, {
      role: 'worker',
      scope: { kind: 'subtree', rootId: asIssueId('iss-1') },
    })
    expect(capabilityAttribution(capability)).toEqual({
      actor: 'sess-agent-1',
      onBehalfOf: 'usr-ada',
    })
    // The existing actor seam is preserved, not replaced: the steward's
    // skip-the-causing-session logic (#116) keeps working off actorSessionId.
    expect(capability.actorSessionId).toBe('sess-agent-1')
  })

  it('a machine has NO on-behalf-of — not even a placeholder', () => {
    const machine: Principal = {
      kind: 'machine',
      machine: 'mach-vps' as MachineId,
      device: asDeviceId('conn-1'),
      capability: cap,
    }
    const capability = capabilityFromPrincipal(machine, { role: 'worker', scope: ALL })
    expect(capability.onBehalfOf).toBeUndefined()
    expect(capabilityAttribution(capability)).toEqual({ actor: 'mach-vps', onBehalfOf: null })
  })

  it('a system job has no human and is never assigned one (D21)', () => {
    const capability = capabilityFromPrincipal(
      { kind: 'system', job: 'steward' },
      { role: 'admin', scope: ALL },
    )
    expect(capability.onBehalfOf).toBeUndefined()
    expect(capabilityAttribution(capability)).toEqual({ actor: 'steward', onBehalfOf: null })
  })

  it('the pair reaches the command layer intact — authorize() runs on this value', () => {
    const capability = capabilityFromPrincipal(agentPrincipal, {
      role: 'worker',
      scope: { kind: 'subtree', rootId: asIssueId('iss-1') },
    })
    // The authz decision is unchanged by the added attribution …
    expect(authorize(capability, 'write', { id: 'iss-1' })).toBe('allow')
    expect(authorize(capability, 'write', { id: 'iss-9' })).toBe('confirm-required')
    expect(authorize(capability, 'manage', { id: 'iss-1' })).toBe('forbidden')
    // … and the pair is still on the value the command layer holds.
    expect(capabilityAttribution(capability).onBehalfOf).toBe('usr-ada')
  })

  it('carries no scope from the principal: the scope is the policy layer\'s input', () => {
    // There is no parameter through which a frame-supplied scope could arrive, and
    // the principal itself has none to copy (ADR 3 Am.1 D16.1).
    expect(Object.keys(agentPrincipal)).not.toContain('scope')
    const narrow = capabilityFromPrincipal(agentPrincipal, {
      role: 'worker',
      scope: { kind: 'none' },
    })
    expect(narrow.scope).toEqual({ kind: 'none' })
  })
})
