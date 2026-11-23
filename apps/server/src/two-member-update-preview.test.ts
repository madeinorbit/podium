/** Real member logins exercise the informational preview's machine projection. */
import { UpdateSpacePreview, type UpdateTarget } from '@podium/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MEMBERS,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => await f?.close())
afterEach(() => vi.restoreAllMocks())
const registry = () => f.handle.registry

describe('informational update previews respect machine visibility', () => {
  async function previews() {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const modules = registry().modules
    vi.spyOn(modules.updates, 'target').mockImplementation(
      (channel) =>
        ({
          version: `preview-${channel}`,
          critical: false,
          artifacts: {},
          trust: 'release',
        }) as UpdateTarget,
    )
    const check = vi.spyOn(modules.machines, 'checkUpdateSpace').mockImplementation(async (id) => ({
      status: 'low',
      checkedAt: 1,
      reason: `Cannot inspect /home/${id}/private-state`,
      volumes: [
        {
          path: `/home/${id}/private-state`,
          availableBytes: 1,
          peakBytes: 2,
          requiredBytes: 3,
          shortfallBytes: 2,
        },
      ],
    }))
    const fleet = vi
      .spyOn(modules.updates, 'fleet')
      .mockRejectedValue(new Error('Preview must not reconcile'))
    const start = vi.spyOn(modules.operations.engine, 'start')
    const dispatch = vi.spyOn(modules.machines, 'toMachine')
    return {
      alice,
      bob,
      check,
      informational() {
        expect(fleet).not.toHaveBeenCalled()
        expect(start).not.toHaveBeenCalled()
        expect(dispatch).not.toHaveBeenCalled()
      },
    }
  }

  it('hides invisible machines before probing while retaining the member’s own estimate', async () => {
    const h = await previews()
    const answer = await h.bob.updates.checkSpace.query({ scope: 'all' })
    expect(answer.machines.map((machine) => machine.machineId)).toEqual([f.machines.bob])
    expect(h.check.mock.calls.map(([id]) => id)).toEqual([f.machines.bob])
    expect(answer.machines[0]).toMatchObject({
      status: 'low',
      volumes: [
        {
          path: `/home/${f.machines.bob}/private-state`,
          availableBytes: 1,
          peakBytes: 2,
          requiredBytes: 3,
          shortfallBytes: 2,
        },
      ],
    })
    expect(JSON.stringify(answer)).not.toContain(f.machines.alice)
    expect(UpdateSpacePreview.parse(answer)).toEqual(answer)
    h.informational()
  })

  it('redacts paths and freeform reasons for an admin with SEE and MANAGE but no USE', async () => {
    const h = await previews()
    const answer = await h.alice.updates.checkSpace.query({ scope: 'all' })
    const bob = answer.machines.find((machine) => machine.machineId === f.machines.bob)
    expect(bob).toMatchObject({
      status: 'low',
      volumes: [
        { path: 'Volume 1', availableBytes: 1, peakBytes: 2, requiredBytes: 3, shortfallBytes: 2 },
      ],
    })
    expect(bob).not.toHaveProperty('reason')
    expect(JSON.stringify(bob)).not.toContain('/home/')
    expect(UpdateSpacePreview.parse(answer)).toEqual(answer)
    h.informational()
  })

  it('allows an explicit SEE grant without USE and removes the preview when SEE is revoked', async () => {
    const h = await previews()
    await h.alice.machines.share.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'see',
    })
    try {
      const shared = await h.bob.updates.checkSpace.query({ scope: 'all' })
      const alice = shared.machines.find((machine) => machine.machineId === f.machines.alice)
      expect(alice).toMatchObject({ volumes: [{ path: 'Volume 1' }] })
      expect(alice).not.toHaveProperty('reason')
      expect(h.check.mock.calls.some(([id]) => id === f.machines.alice)).toBe(true)
      h.informational()
    } finally {
      await h.alice.machines.unshare.mutate({
        id: f.machines.alice,
        grantee: MEMBERS.bob.id,
        verb: 'see',
      })
    }
    h.check.mockClear()
    const revoked = await h.bob.updates.checkSpace.query({ scope: 'all' })
    expect(revoked.machines.some((machine) => machine.machineId === f.machines.alice)).toBe(false)
    expect(h.check.mock.calls.some(([id]) => id === f.machines.alice)).toBe(false)
  })

  it('keeps an unknown preview informational without forwarding a foreign path in its reason', async () => {
    const h = await previews()
    h.check.mockResolvedValue({
      status: 'unknown',
      checkedAt: 1,
      volumes: [],
      reason: `/home/${f.machines.bob}/private-state failed`,
    })
    const answer = await h.alice.updates.checkSpace.query({ scope: 'all' })
    const bob = answer.machines.find((machine) => machine.machineId === f.machines.bob)
    expect(bob).toMatchObject({ status: 'unknown', volumes: [] })
    expect(bob).not.toHaveProperty('reason')
    h.informational()
  })

  it('uses the actual host’s operation channel even when that machine is invisible', async () => {
    const h = await previews()
    const store = registry().sessionStore
    const ids = [store.hostMachineId, f.machines.bob]
    const prior = await Promise.all(ids.map((id) => store.machines.getMachine(id)))
    try {
      // This HTTP fixture starts without an enrolled server machine. Supply
      // the actual host row before testing its channel against Bob’s visibility.
      if (!prior[0])
        await store.machines.upsertMachine({
          id: store.hostMachineId,
          name: 'preview-host',
          hostname: 'preview-host',
          tokenHash: 'preview-fixture',
          ownerUserId: MEMBERS.alice.id,
        })
      for (const id of ids) await store.machines.setUpdateChannel(id, 'dev')
      vi.spyOn(registry().modules.updates, 'fleetDefaultChannel').mockReturnValue('stable')
      const answer = await h.bob.updates.checkSpace.query()
      expect(answer.machines.map((machine) => [machine.machineId, machine.targetVersion])).toEqual([
        [f.machines.bob, 'preview-dev'],
      ])
      expect(h.check.mock.calls.map(([id]) => id)).toEqual([f.machines.bob])
      h.informational()
    } finally {
      for (const [index, id] of ids.entries())
        await store.machines.setUpdateChannel(id, prior[index]?.updateChannelOverride ?? null)
      if (!prior[0]) {
        await store.grants.removeAllForResource('machine', store.hostMachineId, true)
        await store.machines.deleteMachine(store.hostMachineId)
      }
    }
  })
})
