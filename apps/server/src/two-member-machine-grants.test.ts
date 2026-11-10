/**
 * WHO ELSE MAY USE A MACHINE, AND TAKING IT AWAY AGAIN (POD-6700).
 *
 * On the two-member fixture (POD-6282): Alice (admin) holds custody of
 * `machine-alice`, Bob (member) of `machine-bob`.
 *
 * - The machine's grants (grantee, verb, when, by whom) are on the access row
 *   of a member with custody authority: the custodian and every admin. Nobody
 *   else's row carries them. The custodian's own edges are not listed.
 * - Unshare removes one grant. It is refused for the custodian's own edge. It
 *   ends the grantee's ability to start new sessions there; a session already
 *   running is not closed.
 * - Both events are audited.
 *
 * The tests run in order and build on each other.
 */

import {
  type MachineAccessWire,
  type MachineId,
  machineAccessRowId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

// biome-ignore lint/suspicious/noExplicitAny: tRPC procedures addressed by one loose handle
const trpc = async (who: 'alice' | 'bob'): Promise<any> => (await f.as(who)).trpc

/** `member`'s synced access row for `machine`, as the feed would deliver it. */
async function accessRow(member: UserId, machine: MachineId): Promise<MachineAccessWire | null> {
  const [row] = await f.handle.registry.sessionStore.sync.installedStates([
    { entity: 'machineAccess', entityId: machineAccessRowId(member, machine) },
  ])
  const payload = row?.payload
  if (payload === undefined || payload === null) return null
  return (typeof payload === 'string' ? JSON.parse(payload) : payload) as MachineAccessWire
}

const audit = async () => await f.handle.registry.sessionStore.settingsAudit.list(500)
const NO_USE =
  /unknown machine|do not have access to run agents|no longer allowed to use this machine/

describe('the grants list', () => {
  let bobOnAliceMachine: SessionId

  it('the custodian sees an empty list on her own machine; a member without authority sees none', async () => {
    await expect
      .poll(async () => (await accessRow(MEMBERS.alice.id, f.machines.alice))?.grants)
      .toEqual([])
    // Bob may see his own machine; on it he is the custodian, so he holds the list.
    await expect
      .poll(async () => (await accessRow(MEMBERS.bob.id, f.machines.bob))?.grants)
      .toEqual([])
  })

  it('Alice gives Bob use: her row lists the grant with when and by whom; his row lists nothing', async () => {
    const before = new Date().toISOString()
    await (await trpc('alice')).machines.share.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    await expect
      .poll(async () => (await accessRow(MEMBERS.alice.id, f.machines.alice))?.grants)
      .toEqual([
        {
          grantee: MEMBERS.bob.id,
          verb: 'use',
          grantedAt: expect.any(String),
          grantedBy: MEMBERS.alice.id,
        },
      ])
    const [grant] = (await accessRow(MEMBERS.alice.id, f.machines.alice))?.grants ?? []
    expect((grant?.grantedAt ?? '') >= before).toBe(true)
    // Bob now uses Alice's machine, but holds no custody authority over it.
    const bobRow = await accessRow(MEMBERS.bob.id, f.machines.alice)
    expect(bobRow?.use).toBe('granted')
    expect(bobRow).not.toHaveProperty('grants')
    expect(await audit()).toContainEqual(
      expect.objectContaining({
        command: 'machines.share',
        outcome: 'applied',
        actorId: MEMBERS.alice.id,
        onBehalfOf: MEMBERS.alice.id,
        detail: { machineId: f.machines.alice, grantee: MEMBERS.bob.id, verb: 'use' },
      }),
    )
  })

  it('an admin sees the grants of a machine she does not hold', async () => {
    await (await trpc('bob')).machines.share.mutate({
      id: f.machines.bob,
      grantee: MEMBERS.alice.id,
      verb: 'see',
    })
    const expected = [
      {
        grantee: MEMBERS.alice.id,
        verb: 'see',
        grantedAt: expect.any(String),
        grantedBy: MEMBERS.bob.id,
      },
    ]
    await expect
      .poll(async () => (await accessRow(MEMBERS.bob.id, f.machines.bob))?.grants)
      .toEqual(expected)
    await expect
      .poll(async () => (await accessRow(MEMBERS.alice.id, f.machines.bob))?.grants)
      .toEqual(expected)
  })

  it('control: with the grant, Bob starts a session on Alice’s machine', async () => {
    const created = (await (
      await trpc('bob')
    ).sessions.create.mutate({
      agentKind: 'shell',
      cwd: '/wt/bob-on-alice-machine',
      machineId: f.machines.alice,
    })) as { sessionId: SessionId }
    bobOnAliceMachine = created.sessionId
  })

  it('the custodian’s own edge cannot be removed', async () => {
    const alice = await trpc('alice')
    for (const verb of ['see', 'use', 'manage'] as const) {
      await expect(
        alice.machines.unshare.mutate({ id: f.machines.alice, grantee: MEMBERS.alice.id, verb }),
      ).rejects.toThrow(/custodian/)
    }
    expect((await accessRow(MEMBERS.alice.id, f.machines.alice))?.use).toBe('granted')
  })

  it('a member without custody authority cannot remove a grant', async () => {
    await expect(
      (await trpc('bob')).machines.unshare.mutate({
        id: f.machines.alice,
        grantee: MEMBERS.bob.id,
        verb: 'use',
      }),
    ).rejects.toThrow()
    expect((await accessRow(MEMBERS.bob.id, f.machines.alice))?.use).toBe('granted')
  })

  it('removing Bob’s use ends new sessions there, leaves his running one, and is audited', async () => {
    const store = f.handle.registry.sessionStore
    const statusBefore = (await store.sessions.getSession(bobOnAliceMachine))?.status
    expect(statusBefore).toBeDefined()
    await (await trpc('alice')).machines.unshare.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
    })
    await expect
      .poll(async () => (await accessRow(MEMBERS.alice.id, f.machines.alice))?.grants)
      .toEqual([])
    await expect(
      (await trpc('bob')).sessions.create.mutate({
        agentKind: 'shell',
        cwd: '/wt/bob-on-alice-machine-again',
        machineId: f.machines.alice,
      }),
    ).rejects.toThrow(NO_USE)
    // The session he started before is not closed by the removal.
    expect((await store.sessions.getSession(bobOnAliceMachine))?.status).toBe(statusBefore)
    expect(await audit()).toContainEqual(
      expect.objectContaining({
        command: 'machines.unshare',
        outcome: 'applied',
        actorId: MEMBERS.alice.id,
        onBehalfOf: MEMBERS.alice.id,
        detail: { machineId: f.machines.alice, grantee: MEMBERS.bob.id, verb: 'use' },
      }),
    )
  })

  it('removing an absent grant is a no-op and records nothing', async () => {
    const count = (await audit()).filter((row) => row.command === 'machines.unshare').length
    await (await trpc('alice')).machines.unshare.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
    })
    expect((await audit()).filter((row) => row.command === 'machines.unshare')).toHaveLength(count)
  })
})
