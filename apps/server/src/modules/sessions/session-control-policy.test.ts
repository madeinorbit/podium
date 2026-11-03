/**
 * POD-1081 session control policy — pure decisions.
 *
 * Product rules: docs/design/session-control-identity.md
 */

import {
  agentIdentityFromSessionId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  attributionOfSubject,
  contextFromOwnership,
  controllerStillAuthorized,
  controlSubjectFromCommand,
  identityOf,
  mayDrive,
  mayWatch,
  type ControlSubject,
  type SessionControlContext,
} from './session-control-policy'

const OWNER = asUserId('user:owner')
const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const ADMIN = asUserId(firstAdminMemberId())

const ownerSubject = (user = OWNER): ControlSubject => ({
  kind: 'user',
  human: user,
  role: 'member',
})

const adminSubject = (): ControlSubject => ({
  kind: 'user',
  human: ADMIN,
  role: 'admin',
})

const agentSubject = (human: typeof OWNER = OWNER): ControlSubject => ({
  kind: 'agent',
  human,
  role: null,
  agentSessionId: asSessionId('sess-agent'),
})

const ctx = (
  partial: Partial<SessionControlContext> & Pick<SessionControlContext, 'machineUse'>,
): SessionControlContext =>
  contextFromOwnership({ owner: partial.owner ?? OWNER }, partial.machineUse)

describe('session control policy — watch / drive', () => {
  it('owner may watch and drive when machine use is granted', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(ownerSubject(), c)).toBe(true)
    expect(mayDrive(ownerSubject(), c)).toBe(true)
  })

  it('the owner without machine use cannot attach (no back door to execution)', () => {
    const c = ctx({ machineUse: 'denied' })
    expect(mayWatch(ownerSubject(), c)).toBe('unauthorized')
    expect(mayDrive(ownerSubject(), c)).toBe('unauthorized')
  })

  it('anyone else is refused, with machine use or without (POD-6283)', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(ownerSubject(ALICE), c)).toBe('unauthorized')
    expect(mayDrive(ownerSubject(BOB), c)).toBe('unauthorized')
  })

  it('the admin role grants nothing on another person’s session (POD-6283)', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(adminSubject(), c)).toBe('unauthorized')
    expect(mayDrive(adminSubject(), c)).toBe('unauthorized')
    // …and nothing is lost on the admin's own session.
    expect(mayDrive(adminSubject(), ctx({ owner: ADMIN, machineUse: 'granted' }))).toBe(true)
  })

  it('an agent drives its own human’s session and nobody else’s', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayDrive(agentSubject(OWNER), c)).toBe(true)
    expect(mayDrive(agentSubject(ALICE), c)).toBe('unauthorized')
  })

  it('agent rights are the human ceiling — the human loses the session, the agent loses drive at next apply', () => {
    expect(mayDrive(agentSubject(OWNER), ctx({ machineUse: 'granted' }))).toBe(true)
    // No reaper: next apply re-checks against the current owner and machine use.
    const after = ctx({ owner: ALICE, machineUse: 'denied' })
    expect(mayDrive(agentSubject(OWNER), after)).toBe('unauthorized')
    expect(controllerStillAuthorized(agentSubject(OWNER), after)).toBe(false)
  })

  it('absent machine use refuses like denied — attach fails closed', () => {
    expect(mayWatch(ownerSubject(), ctx({ machineUse: 'absent' }))).toBe('unauthorized')
  })
})

describe('session control policy — identity + attribution', () => {
  it('stamps user identity from the transport subject', () => {
    expect(identityOf(ownerSubject(ALICE))).toEqual({ kind: 'user', user: ALICE })
  })

  it('stamps agent + on-behalf-of pair for an agent controller', () => {
    const subject = agentSubject(OWNER)
    expect(identityOf(subject)).toEqual({
      kind: 'agent',
      agentIdentity: agentIdentityFromSessionId(asSessionId('sess-agent')),
      onBehalfOf: OWNER,
    })
  })

  it('attribution pair matches the subject (live PTY path)', () => {
    const userAttr = attributionOfSubject(ownerSubject(ALICE))
    expect(userAttr).toEqual({
      actor: { kind: 'user', id: ALICE },
      onBehalfOf: ALICE,
    })
    const agentAttr = attributionOfSubject(agentSubject(OWNER))
    expect(agentAttr?.actor).toEqual({
      kind: 'agent',
      id: agentIdentityFromSessionId(asSessionId('sess-agent')),
    })
    expect(agentAttr?.onBehalfOf).toBe(OWNER)
  })

  it('command principal carries the admin role, which drives nobody else’s session', () => {
    const admin = controlSubjectFromCommand({
      kind: 'user',
      user: ADMIN,
      capability: { role: 'admin', scope: { kind: 'all' }, actorUser: ADMIN, onBehalfOf: ADMIN },
    })
    expect(admin.role).toBe('admin')
    expect(mayDrive(admin, ctx({ machineUse: 'granted' }))).toBe('unauthorized')
  })
})
