/**
 * CROSS-MACHINE HANDOFF FAILS CLOSED, AND THE REFUSAL SAYS WHICH KIND
 * (POD-1079, discharging POD-643's requirement; ADR 9 D6 M1/M5).
 *
 * The three arms are asserted TOGETHER in the same fixture, because the property
 * is that they are DIFFERENT from each other: a suite that checked each in
 * isolation would pass against an implementation that returned one constant.
 * Every case here is a machine the principal genuinely cannot use, produced by
 * the ownership index rather than by a stubbed gate.
 */

import type { MachineId } from '@podium/model'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { CommandPrincipal } from '../../../command-principal'
import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../../machine-access'
import { machineUseGateFor } from './access'
import { HandoffRefusalError, handoffRefusalOf, refusalForMachineAccess } from './refusal'

const COLLEAGUE: UserId = asUserId('colleague')

const user = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'admin', scope: { kind: 'all' } },
})

/**
 * Three machines, one principal:
 *  - `mine`      — owned by the caller (the arm that proves the gate says YES);
 *  - `theirs`    — owned by somebody else, invisible to the caller;
 *  - `shared`    — visible via a `see` grant, but no `use`.
 * `never-paired` has no row at all.
 */
const ownership: MachineOwnershipIndex = {
  rowFor: (machineId): MachineOwnershipRow | undefined => {
    const rows: Record<string, MachineOwnershipRow> = {
      mine: { machine: 'mine' as MachineId, owner: FIRST_ADMIN_USER_ID, grants: [] },
      theirs: {
        machine: 'theirs' as MachineId,
        owner: COLLEAGUE,
        grants: [],
        name: 'their-laptop',
      },
      shared: {
        machine: 'shared' as MachineId,
        owner: COLLEAGUE,
        grants: [{ subject: FIRST_ADMIN_USER_ID, verb: 'see' }],
        name: 'shared-box',
      },
    }
    return rows[machineId]
  },
}

const gate = machineUseGateFor({ principal: user(FIRST_ADMIN_USER_ID), ownership })

const refusalFor = (machineId: string): { reason: unknown; message: string } => {
  try {
    gate(machineId)
    return { reason: 'NOT REFUSED', message: '' }
  } catch (error) {
    return { reason: handoffRefusalOf(error), message: (error as Error).message }
  }
}

describe('the handoff `use` gate classifies its refusals', () => {
  it('says YES for a machine the caller owns — so a refusal below is not the fixture', () => {
    expect(() => gate('mine')).not.toThrow()
  })

  it('a machine the caller may SEE but not USE is `unauthorized`', () => {
    expect(refusalFor('shared').reason).toBe('unauthorized')
  })

  it("a colleague's invisible machine and an id that never existed refuse IDENTICALLY", () => {
    const invisible = refusalFor('theirs')
    const nonexistent = refusalFor('never-paired')

    // Same arm AND same words. Either one differing would make the refusal an
    // existence oracle over somebody else's fleet (readiness §3.1.2).
    expect(invisible.reason).toBe('unknown-target')
    expect(nonexistent.reason).toBe('unknown-target')
    // The id the CALLER supplied is echoed back — it is the caller's own input,
    // and quoting it discloses nothing. Everything else must be identical, so the
    // comparison is made with that one variable substituted out.
    expect(invisible.message.replace('theirs', '<id>')).toBe(
      nonexistent.message.replace('never-paired', '<id>'),
    )
    // …and not because both are empty:
    expect(invisible.message).toContain('unknown machine')
    // The name of a machine the caller cannot see is never quoted back.
    expect(invisible.message).not.toContain('their-laptop')
  })

  it('the three arms are three different answers, in one fixture', () => {
    const arms = new Set([
      refusalFor('shared').reason,
      refusalFor('theirs').reason,
      // `unreachable` is the coordinator's arm — the machine is usable and its
      // daemon is not attached. Constructed here rather than driven through the
      // whole choreography, because the property under test is that the
      // vocabulary has three inhabited arms and this one is reachable.
      new HandoffRefusalError('target machine is offline', 'unreachable').refusal,
    ])
    expect([...arms].sort()).toEqual(['unauthorized', 'unknown-target', 'unreachable'])
  })

  it('the mapping never turns `absent` into `unauthorized`', () => {
    expect(refusalForMachineAccess('absent')).toBe('unknown-target')
    expect(refusalForMachineAccess('unauthorized')).toBe('unauthorized')
  })

  it('an ordinary Error carries no refusal — the reader cannot invent one', () => {
    expect(handoffRefusalOf(new Error('session has no resume reference'))).toBeUndefined()
    expect(handoffRefusalOf(undefined)).toBeUndefined()
  })

  it('NOTHING RETARGETS: the gate refuses the machine it was asked about', () => {
    // The failure M5 exists to prevent is a refusal answered by silently running
    // the session somewhere the principal MAY use. The gate returns void or
    // throws; there is no channel through which a substitute machine could come
    // back, and this asserts that shape rather than a behaviour.
    expect(refusalFor('theirs').reason).toBe('unknown-target')
    expect(() => gate('mine')).not.toThrow()
    expect(gate('mine')).toBeUndefined()
  })

  it('a session id is not a machine id — the gate refuses what it does not know', () => {
    expect(refusalFor(asSessionId('sess-1'))).toMatchObject({ reason: 'unknown-target' })
  })
})
