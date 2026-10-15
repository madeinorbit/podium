/**
 * Old/new parity for machine reads (POD-6155 step 3).
 *
 * OLD: the world index's machine map (`WorldIndex.reader.machine`) and
 * MachinesService's record and name caches (`machineRecords`, `machineName`),
 * patched in place by every committed machine write. NEW: the machines
 * repository's prepared queries (`getMachine`, `getMachines`, `listMachines`).
 * Compared after every write, over the benchmark corpus's machines (POD-6146:
 * cell h1a1, seed 4443) plus edge cases: renamed, removed, revoked, superseded
 * and granted machines, inventory set and cleared, assignment and channel
 * changes, and a rolled-back rename.
 */

import { fileURLToPath } from 'node:url'
import { asMachineId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { ownershipSnapshotFromMachines } from '../../machine-access'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { WorldIndex } from '../world-index'
import { type MachinesDeps, MachinesService } from './service'

const stores: SessionStore[] = []
const services: MachinesService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  for (const store of stores.splice(0)) await store.close()
})

const owner = asUserId('user:machine-owner')
const colleague = asUserId('user:machine-colleague')

async function corpusMachines(): Promise<{ id: string; name: string; hostname: string }[]> {
  const module = fileURLToPath(new URL('../../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{ machines: { id: string; name: string; hostname: string }[] }>
  }
  return (await exportCorpus('h1a1', 4443)).machines
}

async function setup() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const machines = [
    ...(await corpusMachines()),
    // Edge-case machines beside the corpus fleet.
    { id: 'edge-renamed', name: 'Before', hostname: 'renamed.local' },
    { id: 'edge-removed', name: 'Gone soon', hostname: 'removed.local' },
    { id: 'edge-revoked', name: 'Revoked', hostname: 'revoked.local' },
    { id: 'edge-replacement', name: 'Replacement', hostname: 'replacement.local' },
    { id: 'edge-granted', name: 'Granted', hostname: 'granted.local' },
  ]
  for (const machine of machines) {
    await store.machines.upsertMachine({ ...machine, tokenHash: `token-${machine.id}`, ownerUserId: owner })
  }
  const index = await WorldIndex.load(store)
  const service = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    worldIndex: index.reader,
    clients: () => [],
    machinesForPrincipal: async () => [],
  } as MachinesDeps)
  services.push(service)
  return { store, index, service, ids: [...machines.map((machine) => machine.id), 'never-enrolled'] }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function expectParity({ store, index, service, ids }: Fixture) {
  // NEW: the repository's queries.
  const listed = await store.machines.listMachines()
  const many = await store.machines.getMachines(ids)
  // OLD: the service's record cache, in its own order, against the listing.
  expect(await service['machineRecords']()).toEqual(listed)
  for (const id of ids) {
    const one = await store.machines.getMachine(id)
    expect(many.get(id), `${id} many`).toEqual(one)
    expect(listed.find((row) => row.id === id), `${id} listed`).toEqual(one)
    // OLD: the world index's map and the service's name cache.
    expect(index.reader.machine(id), `${id} index`).toEqual(one)
    expect(await service.machineName(id), `${id} name`).toBe(one?.name ?? id)
  }
}

describe('machine reads: old copies and new queries give the same answers', () => {
  it('over the benchmark corpus and edge cases, after every write', async () => {
    const fixture = await setup()
    const { store, service } = fixture
    expect(fixture.ids.length).toBeGreaterThan(6)
    await expectParity(fixture)
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
      await expectParity(fixture)
    }
    await expect(store.transact(async () => {
      await store.machines.renameMachine('edge-renamed', 'rolled back')
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    await expectParity(fixture)

    // The granted machine: ownership facts from the old cached rows match the
    // rows and edges in the tables.
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
})
