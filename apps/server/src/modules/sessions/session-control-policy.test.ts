/**
 * POD-1081 session control policy — pure decisions.
 *
 * Product rules: docs/design/session-control-identity.md
 */

import {
  agentIdentityFromSessionId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
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
const ADMIN = asUserId(FIRST_ADMIN_USER_ID)

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
  contextFromOwnership(
    {
      owner: partial.owner ?? OWNER,
      grants: partial.watchGrantees ?? [],
    },
    partial.machineUse,
    partial.driveGrantees,
  )

describe('session control policy — watch / drive', () => {
  it('owner may watch and drive when machine use is granted', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(ownerSubject(), c)).toBe(true)
    expect(mayDrive(ownerSubject(), c)).toBe(true)
  })

  it('session share without machine use cannot attach (no back door to execution)', () => {
    const shared = ctx({
      machineUse: 'denied',
      watchGrantees: [ALICE],
      driveGrantees: [ALICE],
    })
    // Alice is on the grant list but the machine refuses use.
    expect(mayWatch(ownerSubject(ALICE), shared)).toBe('unauthorized')
    expect(mayDrive(ownerSubject(ALICE), shared)).toBe('unauthorized')
  })

  it('read-only grantee may watch but not drive', () => {
    const c = ctx({
      machineUse: 'granted',
      watchGrantees: [ALICE],
      driveGrantees: [], // write/manage not granted
    })
    expect(mayWatch(ownerSubject(ALICE), c)).toBe(true)
    expect(mayDrive(ownerSubject(ALICE), c)).toBe('unauthorized')
  })

  it('write grantee may take control', () => {
    const c = ctx({
      machineUse: 'granted',
      watchGrantees: [BOB],
      driveGrantees: [BOB],
    })
    expect(mayDrive(ownerSubject(BOB), c)).toBe(true)
  })

  it('stranger with neither grant nor ownership is refused', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(ownerSubject(ALICE), c)).toBe('unauthorized')
    expect(mayDrive(ownerSubject(ALICE), c)).toBe('unauthorized')
  })

  it('instance admin is break-glass drive (policy §3)', () => {
    const c = ctx({ machineUse: 'granted' })
    expect(mayDrive(adminSubject(), c)).toBe(true)
  })

  it('agent rights are the human ceiling — revoke human, agent loses drive at next apply', () => {
    const before = ctx({
      machineUse: 'granted',
      watchGrantees: [OWNER],
      driveGrantees: [OWNER],
    })
    expect(mayDrive(agentSubject(OWNER), before)).toBe(true)

    // Human lost the session share and machine use. No reaper: next apply re-checks.
    const after = ctx({
      owner: ALICE, // session re-owned / human no longer owner
      machineUse: 'denied',
      watchGrantees: [],
      driveGrantees: [],
    })
    expect(mayDrive(agentSubject(OWNER), after)).toBe('unauthorized')
    expect(controllerStillAuthorized(agentSubject(OWNER), after)).toBe(false)
  })

  it('absent machine use refuses like denied — attach fails closed', () => {
    const c = ctx({ machineUse: 'absent', watchGrantees: [ALICE], driveGrantees: [ALICE] })
    expect(mayWatch(ownerSubject(ALICE), c)).toBe('unauthorized')
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

  it('command principal projects role from capability.role for admin break-glass', () => {
    const admin = controlSubjectFromCommand({
      kind: 'user',
      user: ADMIN,
      capability: { role: 'admin', scope: { kind: 'all' }, actorUser: ADMIN, onBehalfOf: ADMIN },
    })
    expect(admin.role).toBe('admin')
    expect(mayDrive(admin, ctx({ machineUse: 'granted' }))).toBe(true)
  })
})
