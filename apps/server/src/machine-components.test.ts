import { asMachineId, firstAdminMemberId, structuralRejection } from '@podium/model'
import type { MachineServiceAssignment } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { systemPrincipal } from './command-principal'
import { machineVerbsFor, ownershipSnapshotFromMachines } from './machine-access'
import { MachinesService } from './modules/machines/service'
import { openTestStore } from './test-support/open-test-store'
import type { SqlDatabase } from '@podium/runtime/sqlite'

const combinations: MachineServiceAssignment[] = [
  { server: false, agentExecution: false }, { server: true, agentExecution: false },
  { server: false, agentExecution: true }, { server: true, agentExecution: true },
]
const id = asMachineId('component-machine')
async function fixture(assignment: MachineServiceAssignment) {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({ id, name: 'machine', hostname: 'host', tokenHash: 'hash',
    ownerUserId: firstAdminMemberId(), assignment,
    assignmentEvidence: { version: 1, source: 'test-enrollment', requestId: 'enroll-1' } })
  const service = new MachinesService({ store, hostMachineId: store.hostMachineId, instanceId: 'test',
    clients: () => [], machinesForPrincipal: async () => [], sessionsChangedForMachine: () => {} })
  return { store, service }
}

describe('desired assignment and observed availability', () => {
  for (const assignment of combinations) {
    it(`round trips ${JSON.stringify(assignment)} and gates detached/attached execution`, async () => {
      const { store, service } = await fixture(assignment)
      try {
        expect((await store.machines.getMachine(id))?.serviceAssignment).toEqual(assignment)
        expect((await store.machines.getMachine(id))?.assignmentEvidence).toEqual({ version: 1, source: 'test-enrollment', requestId: 'enroll-1' })
        const verbs = async () => machineVerbsFor(systemPrincipal('component-test'), id,
          await ownershipSnapshotFromMachines(service))
        expect((await verbs()).has('use')).toBe(false)
        await expect(service.defaultMachine()).rejects.toThrow('no assigned and available daemon')
        const transport = vi.fn()
        await service.attach(id, transport)
        expect((await store.machines.getMachine(id))?.serviceAssignment).toEqual(assignment)
        expect((await store.machines.getMachine(id))?.availability?.daemon).toBe(true)
        expect((await verbs()).has('use')).toBe(assignment.agentExecution)
        expect(structuralRejection((await service.listMachines())[0]!)).toBe(assignment.agentExecution ? undefined : 'no-daemon')
        if (assignment.agentExecution) {
          expect(await service.defaultMachine()).toBe(id)
          expect(await service.resolveMachineForAgent(undefined, '/repo', 'codex')).toBe(id)
        }
        else await expect(service.defaultMachine()).rejects.toThrow('no assigned and available daemon')
        expect(service.detach(id, transport)).toBe(true)
        expect((await verbs()).has('use')).toBe(false)
        await vi.waitFor(async () => expect((await store.machines.getMachine(id))?.availability?.daemon).toBe(false))
        expect((await store.machines.getMachine(id))?.serviceAssignment).toEqual(assignment)
      } finally { service.dispose(); await store.close() }
    })
  }

  for (const assignment of [combinations[0]!, combinations[1]!]) {
    it(`supervisor enrollment preserves ${JSON.stringify(assignment)} without offering a task target`, async () => {
      const store = await openTestStore(':memory:')
      const service = new MachinesService({ store, hostMachineId: store.hostMachineId, instanceId: 'test',
        pairing: { mint: () => 'valid', redeem: () => ({ ownerUserId: firstAdminMemberId() }) },
        clients: () => [], machinesForPrincipal: async () => [], sessionsChangedForMachine: () => {} })
      try {
        expect((await service.authenticateDaemon({ type: 'pair', code: 'valid', machineId: id,
          hostname: 'host', assignment }, { source: 'supervisor' })).ok).toBe(true)
        const send = vi.fn()
        await service.attachSupervisor(id, send, {}, [])
        expect((await store.machines.getMachine(id))?.serviceAssignment).toEqual(assignment)
        expect((await service.listMachines())[0]?.availability).toMatchObject({ daemon: false, supervisor: true })
        const principal = { kind: 'user' as const, user: firstAdminMemberId(),
          capability: { role: 'admin' as const, scope: { kind: 'all' as const } } }
        const verbs = machineVerbsFor(principal, id, await ownershipSnapshotFromMachines(service))
        expect(verbs.has('manage')).toBe(true)
        expect(verbs.has('use')).toBe(false)
        await expect(service.resolveMachineForAgent(undefined, '/repo', 'codex')).rejects.toThrow()
        await service.detachSupervisor(id, send)
        expect((await store.machines.getMachine(id))?.availability?.supervisor).toBe(false)
      } finally { service.dispose(); await store.close() }
    })
  }

  it('assignment removal is immediate and does not invent a detach; add restores use', async () => {
    const { store, service } = await fixture(combinations[2]!)
    try {
      await service.attach(id, () => {})
      await service.changeAssignment(id, combinations[0]!, 'remove-1')
      expect((await store.machines.getMachine(id))?.availability?.daemon).toBe(true)
      await expect(service.defaultMachine()).rejects.toThrow()
      await service.changeAssignment(id, combinations[2]!, 'add-1')
      expect(await service.defaultMachine()).toBe(id)
      await expect(service.changeAssignment(id, combinations[3]!, 'server-add')).rejects.toThrow('server transfer')
    } finally { service.dispose(); await store.close() }
  })

  it('a new service cannot use persisted observations from the old run', async () => {
    const { store, service } = await fixture(combinations[2]!)
    await service.attach(id, () => {})
    service.dispose()
    const fresh = new MachinesService({ store, hostMachineId: store.hostMachineId, instanceId: 'test',
      clients: () => [], machinesForPrincipal: async () => [], sessionsChangedForMachine: () => {} })
    try {
      expect((await store.machines.getMachine(id))?.availability?.daemon).toBe(true)
      expect((await fresh.listMachines())[0]?.availability?.daemon).toBe(false)
      await expect(fresh.defaultMachine()).rejects.toThrow()
    } finally { fresh.dispose(); await store.close() }
  })

  it('ignores a superseded socket close, then records the current detach', async () => {
    const { store, service } = await fixture(combinations[2]!)
    try {
      const old = vi.fn(), current = vi.fn()
      await service.attach(id, old)
      await service.attach(id, current)
      expect(service.detach(id, old)).toBe(false)
      expect(await service.defaultMachine()).toBe(id)
      expect(service.detach(id, current)).toBe(true)
      await vi.waitFor(async () => expect((await store.machines.getMachine(id))?.availability?.daemon).toBe(false))
    } finally { service.dispose(); await store.close() }
  })

  it('server transfer preserves source and target daemon policy and retries', async () => {
    const { store, service } = await fixture(combinations[1]!)
    const target = asMachineId('target-machine')
    try {
      await store.machines.upsertMachine({ id: target, name: 'target', hostname: 'target', tokenHash: 'hash',
        ownerUserId: firstAdminMemberId(), assignment: combinations[2]! })
      for (let retry = 0; retry < 2; retry++) await store.machines.transferServerAssignment(id, target, 'transfer-1')
      expect((await store.machines.getMachine(id))?.serviceAssignment).toEqual(combinations[0])
      expect((await store.machines.getMachine(target))?.serviceAssignment).toEqual(combinations[3])
    } finally { service.dispose(); await store.close() }
  })

  it('malformed assignment and observation fail closed', async () => {
    const { store, service } = await fixture(combinations[2]!)
    try {
      // @ts-expect-error private database: corrupt persisted input deliberately
      const db: SqlDatabase = store.db
      db.prepare('UPDATE machines SET service_assignment_json = ?, availability_json = ? WHERE id = ?').run('{broken', '{broken', id)
      const row = await store.machines.getMachine(id)
      expect(row?.serviceAssignment).toEqual(combinations[0])
      expect(row?.availability).toBeNull()
      expect(structuralRejection({ id, online: true })).toBe('no-daemon')
    } finally { service.dispose(); await store.close() }
  })
})
