/**
 * Machine reads answer from the machines table (POD-6155 step 3).
 *
 * Before the world index's machine map and MachinesService's record and name
 * caches were deleted, this test compared them with the repository's prepared
 * queries over the benchmark corpus's machines (POD-6146: cell h1a1, seed 4443)
 * and these edge cases, at the commit that adds this file. What stays is the
 * edge-case part, as a regression test: the service's reads follow every
 * committed write (renamed, removed, revoked, superseded and granted machines,
 * inventory set and cleared, assignment and channel changes) and ignore a
 * rolled-back one; and machine names for a set of machines cost one statement
 * however many machines there are.
 */

import { asMachineId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { ownershipSnapshotFromMachines } from '../../machine-access'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { type MachinesDeps, MachinesService } from './service'

const stores: SessionStore[] = []
const services: MachinesService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const store of stores.splice(0)) await store.close()
})

const owner = asUserId('user:machine-owner')
const colleague = asUserId('user:machine-colleague')

async function setup(machines: { id: string; name: string; hostname: string }[]) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  for (const machine of machines) {
    await store.machines.upsertMachine({ ...machine, tokenHash: `token-${machine.id}`, ownerUserId: owner })
  }
  const service = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    clients: () => [],
    machinesForPrincipal: async () => [],
  } as MachinesDeps)
  services.push(service)
  return { store, service, ids: [...machines.map((machine) => machine.id), 'never-enrolled'] }
}

async function expectReads({ store, service, ids }: Awaited<ReturnType<typeof setup>>) {
  const listed = await store.machines.listMachines()
  const many = await store.machines.getMachines(ids)
  const names = await service.machineNames(ids)
  expect(await service['machineRecords']()).toEqual(listed)
  for (const id of ids) {
    const one = await store.machines.getMachine(id)
    expect(many.get(id), `${id} many`).toEqual(one)
    expect(listed.find((row) => row.id === id), `${id} listed`).toEqual(one)
    expect(await service.machineName(id), `${id} name`).toBe(one?.name ?? id)
    expect(names.get(id), `${id} names`).toBe(one?.name ?? id)
  }
}

describe('machine reads follow the machines table', () => {
  it('after every write, and not after a rolled-back one', async () => {
    const fixture = await setup([
      { id: 'edge-renamed', name: 'Before', hostname: 'renamed.local' },
      { id: 'edge-removed', name: 'Gone soon', hostname: 'removed.local' },
      { id: 'edge-revoked', name: 'Revoked', hostname: 'revoked.local' },
      { id: 'edge-replacement', name: 'Replacement', hostname: 'replacement.local' },
      { id: 'edge-granted', name: 'Granted', hostname: 'granted.local' },
    ])
    const { store, service } = fixture
    await expectReads(fixture)
    const writes = [
      () => store.machines.renameMachine('edge-renamed', 'After'),
      () => store.machines.setMachineInventory('edge-renamed', JSON.stringify({ os: 'linux', arch: 'x64', podiumVersion: '1', agents: [], tools: [] })),
      () => store.machines.setMachineInventory('edge-renamed', '{"invalid":true}'),
      () => store.machines.setServiceAssignment('edge-renamed', { server: false, agentExecution: true }),
      () => store.machines.setUpdateChannel('edge-renamed', 'edge'),
      () => store.machines.setUpdateChannel('edge-renamed', null),
      () => store.machines.touchMachine('edge-renamed', 'renamed-again.local'),
      () => store.machines.deleteMachine(asMachineId('edge-removed')),
      () => store.machines.revokeMachine(asMachineId('edge-revoked')),
      () => store.machines.supersedeMachine(asMachineId('edge-revoked'), asMachineId('edge-replacement')),
      () => store.grants.upsert({
        resourceKind: 'machine', resourceId: 'edge-granted', grantee: colleague, verb: 'use',
        owner, visibility: 'personal', createdAt: '2026-10-15T00:00:00Z',
        actorKind: 'user', actorId: owner, onBehalfOf: owner,
      }),
      () => store.machines.setMachineOwner('edge-granted', colleague),
    ]
    for (const write of writes) {
      await write()
      await expectReads(fixture)
    }
    expect(await service.machineName('edge-renamed')).toBe('After')
    expect(await service.machineName('edge-removed')).toBe('edge-removed')
    expect((await service.serviceAssignment(asMachineId('edge-renamed'))).agentExecution).toBe(true)
    await expect(store.transact(async () => {
      await store.machines.renameMachine('edge-renamed', 'rolled back')
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    await expectReads(fixture)
    expect(await service.machineName('edge-renamed')).toBe('After')

    // The granted machine: ownership facts come from the rows and edges in the tables.
    const ownership = await ownershipSnapshotFromMachines(service)
    const granted = ownership.rowFor(asMachineId('edge-granted'))
    expect(granted?.owner).toBe(colleague)
    expect(granted?.grants.map((edge) => [edge.subject, edge.verb]).sort()).toEqual(
      (await store.grants.listForResource('machine', 'edge-granted')).map((edge) => [edge.grantee, edge.verb]).sort(),
    )
    expect((await service.ownershipRows()).map((row) => [row.id, row.name, row.revokedAt])).toEqual(
      (await store.machines.listMachines()).map((row) => [row.id, row.name, row.revokedAt]),
    )
  })

  it('names a set of machines in one statement, however many there are', async () => {
    await expectConstantStatements(
      {
        name: 'machineNames',
        setup: async (size) =>
          await setup(Array.from({ length: size }, (_, i) => ({ id: `m-${i}`, name: `Machine ${i}`, hostname: `m-${i}.local` }))),
        target: (f) => f.store,
        run: async (f) => await f.service.machineNames(f.ids.map(asMachineId)),
        check: (names, f) => {
          const map = names as Map<string, string>
          expect(map.size).toBe(f.ids.length)
          expect(map.get('m-0')).toBe('Machine 0')
          expect(map.get('never-enrolled')).toBe('never-enrolled')
        },
      },
      1,
    )
  })
})
