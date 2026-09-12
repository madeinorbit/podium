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

  it('instance admin is REFUSED watch and drive on a session it does not own (D7)', () => {
    // REVERSAL of the pre-D7 "break-glass" policy §3. The execution charter
    // accepted D7 on 12 September 2026: admins cannot view or drive another
    // member's session. Watch is asserted next to drive because D7 names both
    // verbs and mayWatch is the check that attaches the PTY.
    const c = ctx({ machineUse: 'granted' })
    expect(mayWatch(adminSubject(), c)).toBe('unauthorized')
    expect(mayDrive(adminSubject(), c)).toBe('unauthorized')
  })

  it('and the SAME admin watches and drives the session it DOES own', () => {
    // THE ALLOW ARM, and the only thing that makes the refusal above a statement
    // about OWNERSHIP. One fact differs between the two cases: who owns the row.
    // Without it, the refusal would read identically if the policy had simply
    // blacklisted admins, which is not what D7 says.
    const c = ctx({ machineUse: 'granted', owner: ADMIN })
    expect(mayWatch(adminSubject(), c)).toBe(true)
    expect(mayDrive(adminSubject(), c)).toBe(true)
  })

  it('an admin on a foreign session is admitted by a GRANT, at the grant\'s verb', () => {
    // The grade confers nothing; the grant confers exactly what it confers. A
    // watch-only grant must not drive, or the removed short circuit would have
    // grown back as "any grant is enough for an admin".
    const watchOnly = ctx({ machineUse: 'granted', watchGrantees: [ADMIN], driveGrantees: [] })
    expect(mayWatch(adminSubject(), watchOnly)).toBe(true)
    expect(mayDrive(adminSubject(), watchOnly)).toBe('unauthorized')
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

  it('command principal projects role from capability.role, which no longer drives', () => {
    const admin = controlSubjectFromCommand({
      kind: 'user',
      user: ADMIN,
      capability: { role: 'admin', scope: { kind: 'all' }, actorUser: ADMIN, onBehalfOf: ADMIN },
    })
    expect(admin.role).toBe('admin')
    // The PROJECTION still records the grade — role is a fact about the
    // principal and other code reads it. What D7 changed is that the grade no
    // longer answers the ownership question on someone else's session.
    expect(mayDrive(admin, ctx({ machineUse: 'granted' }))).toBe('unauthorized')
  })
})
