import { createHash } from 'node:crypto'
import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
import { signWithMachine } from '@podium/runtime/machine-credential'
import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { MachinesService } from './modules/machines/service'
import { openTestStore } from './test-support/open-test-store'

const oldId = asMachineId('old-machine'), newId = asMachineId('new-machine')
const admin = asUserId('supersede-admin'), member = asUserId('supersede-member')
const token = 'old-credential'
const assignment = { server: false, agentExecution: true }
const queued = { type: 'kill' as const, sessionId: asSessionId('queued-session') }
async function fixture() {
  const store = await openTestStore(':memory:')
  for (const [id, role] of [[admin, 'admin'], [member, 'member']] as const) {
    await store.users.create({ id, role, displayName: id, createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
  }
  for (const id of [oldId, newId]) {
    await store.machines.upsertMachine({ id, name: 'same laptop', hostname: 'same.local',
      tokenHash: createHash('sha256').update(token).digest('hex'), ownerUserId: member, assignment })
    await store.grants.upsert({ resourceKind: 'machine', resourceId: id, grantee: admin, verb: 'use',
      owner: member, visibility: 'private', createdAt: new Date().toISOString(),
      actorKind: 'user', actorId: member, onBehalfOf: member })
  }
  const service = new MachinesService({ store, hostMachineId: store.hostMachineId, instanceId: 'supersede-test',
    clients: () => [], machinesForPrincipal: async () => [], sessionsChangedForMachine: () => {} })
  const close = vi.fn()
  service.registerCredentialConnection(oldId, close)
  service.toMachine(oldId, queued)
  return { store, service, close, dispose: async () => { service.dispose(); await store.close() } }
}

describe('explicit machine supersession', () => {
  it('retains identity, cancels old grants and queued control, audits, and leaves replacement authority untouched', async () => {
    const f = await fixture()
    try {
      const replacement = await f.store.machines.getMachine(newId)
      const grants = await f.store.grants.listForResource('machine', newId)
      await f.service.supersedeMachine(oldId, newId, admin)
      expect(await f.store.machines.getMachine(oldId)).toMatchObject({ supersededBy: newId, revokedAt: expect.any(String) })
      expect(await f.store.machines.getMachine(newId)).toEqual(replacement)
      expect((await f.store.grants.listForResource('machine', oldId)).filter(edge => !edge.custody)).toEqual([])
      expect(await f.store.machines.custodian(oldId)).toBe(member)
      expect(await f.store.grants.listForResource('machine', newId)).toEqual(grants)
      expect(f.close).toHaveBeenCalledOnce()
      expect(await f.store.machines.getMachineByToken(oldId, token)).toBe(false)
      expect((await f.service.listMachines()).find((row) => row.id === oldId)).toMatchObject({ online: false, supersededBy: newId, use: 'denied' })
      const send = vi.fn()
      await f.service.attach(newId, send)
      await f.service.flushQueued(oldId)
      await f.service.flushQueued(newId)
      expect(send).not.toHaveBeenCalledWith(queued)
      expect(await f.store.settingsAudit.list()).toEqual([expect.objectContaining({ command: 'machines.supersede', actorId: admin,
        detail: { machineId: oldId, replacementId: newId, grants: 'cancelled', queuedWork: 'cancelled' } })])
      await expect(f.service.attach(oldId, () => {})).rejects.toThrow(/revoked/)
      await expect(f.service.mintReplacementPairingCode(oldId, { ownerUserId: admin }, true)).rejects.toThrow(/superseded/)
      expect(await f.store.machines.enrollMachine({ id: oldId, name: 'again', hostname: 'same.local',
        tokenHash: 'new-token', ownerUserId: admin, podiumManaged: true, assignment, assignmentEvidence: { version: 1, source: 'test', requestId: 'replace' } },
        (await f.store.machines.getMachine(oldId))!.revokedAt!, createHash('sha256').update(token).digest('hex'))).toBe(false)
    } finally { await f.dispose() }
  })

  it('refuses the old keypair after supersession and fences its credential replacement', async () => {
    const f = await fixture()
    try {
      const id = asMachineId('keypair-machine')
      const keys = mintSigningKeyPair()
      const publicKey = publicKeyWire(keys)
      await f.store.machines.enrollMachine({ id, name: 'keypair', hostname: 'keypair.local', tokenHash: '',
        credentialKind: 'ed25519', publicKey, ownerUserId: member, podiumManaged: true, assignment,
        assignmentEvidence: { version: 1, source: 'test', requestId: 'keypair' } })
      const signature = signWithMachine(keys, 'challenge')
      expect(await f.store.machines.verifyMachineSignature(id, 'challenge', signature)).toBe(true)
      await f.service.supersedeMachine(id, newId, admin)
      expect(await f.store.machines.verifyMachineSignature(id, 'challenge', signature)).toBe(false)
      const retired = await f.store.machines.getMachine(id)
      expect(await f.store.machines.enrollMachine({ id, name: 'keypair', hostname: 'keypair.local', tokenHash: '',
        credentialKind: 'ed25519', publicKey: publicKeyWire(mintSigningKeyPair()), ownerUserId: member, podiumManaged: true, assignment,
        assignmentEvidence: { version: 1, source: 'test', requestId: 'replace-keypair' } }, retired!.revokedAt!, publicKey)).toBe(false)
    } finally { await f.dispose() }
  })

  it('requires admin and manage access to both IDs, rejecting self and unknown replacements without writes', async () => {
    const f = await fixture()
    try {
      await expect(f.service.supersedeMachine(oldId, newId, member)).rejects.toThrow(/admin/)
      for (const denied of [oldId, newId]) {
        await expect(f.service.supersedeMachine(oldId, newId, admin, { manage: (id) => id !== denied })).rejects.toThrow(/manage/)
      }
      await expect(f.service.supersedeMachine(oldId, oldId, admin)).rejects.toThrow(/different/)
      await expect(f.service.supersedeMachine(oldId, asMachineId('missing'), admin)).rejects.toThrow(/unknown/)
      expect((await f.store.machines.getMachine(oldId))?.revokedAt).toBeNull()
      expect((await f.store.grants.listForResource('machine', oldId)).filter(edge => edge.grantee !== member)).toHaveLength(1)
      expect(await f.store.settingsAudit.list()).toEqual([])
      expect(f.close).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('rolls back grants and retirement if audit persistence fails; queued work remains deliverable', async () => {
    const f = await fixture()
    try {
      const append = vi.spyOn(f.store.settingsAudit, 'append').mockRejectedValueOnce(new Error('audit unavailable'))
      await expect(f.service.supersedeMachine(oldId, newId, admin)).rejects.toThrow('audit unavailable')
      append.mockRestore()
      expect((await f.store.machines.getMachine(oldId))?.supersededBy).toBeNull()
      expect((await f.store.machines.getMachine(oldId))?.revokedAt).toBeNull()
      expect((await f.store.grants.listForResource('machine', oldId)).filter(edge => edge.grantee !== member)).toHaveLength(1)
      expect(f.close).not.toHaveBeenCalled()
      const send = vi.fn()
      await f.service.attach(oldId, send)
      await f.service.flushQueued(oldId)
      expect(send).toHaveBeenCalledWith(queued)
    } finally { await f.dispose() }
  })

  it('is retry-safe, refuses cycles and does not infer supersession from matching names', async () => {
    const f = await fixture()
    try {
      expect(await f.service.listMachines()).toHaveLength(2)
      const outcomes = await Promise.allSettled([
        f.service.supersedeMachine(oldId, newId, admin), f.service.supersedeMachine(newId, oldId, admin),
      ])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
      await f.service.supersedeMachine(oldId, newId, admin)
      expect(await f.store.settingsAudit.list()).toHaveLength(1)
    } finally { await f.dispose() }
  })
})
