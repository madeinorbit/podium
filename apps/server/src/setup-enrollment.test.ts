import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId } from '@podium/model'
import { prepareSetupEnrollment, confirmSetupEnrollment } from '@podium/runtime/setup-enrollment'
import { loadSupervisorState } from '@podium/runtime/machine-supervisor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { completePreauthorizedSetup, enrollSetupMachine, readSetupEnrollment } from './setup-enrollment'
import { openTestStore } from './test-support/open-test-store'
import type { SessionStore } from './store'

const actor = asUserId('setup-admin')
const stores: SessionStore[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function fixture(preauthorized = false, createActor = true) {
  const dir = mkdtempSync(join(tmpdir(), 'podium-setup-enrollment-'))
  dirs.push(dir)
  const store = await openTestStore(':memory:')
  stores.push(store)
  if (createActor) await store.users.create({ id: actor, displayName: 'Setup admin', role: 'admin',
    createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
  return { store, dir, request: prepareSetupEnrollment(true, preauthorized, dir) }
}

describe('setup enrollment transaction', () => {
  it('replays the same confirmation after commit but before parent credential confirmation', async () => {
    const { store, dir, request } = await fixture()
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
    const first = await enrollSetupMachine(store, 'installation-a', request, actor)
    expect(loadSupervisorState(dir).enrolledPublicKey).toBeUndefined()
    const retry = prepareSetupEnrollment(true, false, dir)
    expect(retry).toEqual(request)
    expect(await enrollSetupMachine(store, 'installation-a', retry, actor)).toEqual(first)
    confirmSetupEnrollment(retry.requestId, first.publicKey, dir)
    expect(loadSupervisorState(dir).enrolledPublicKey).toBe(first.publicKey)
    expect(await store.machines.custodian(request.machineId)).toBe(actor)
  })

  it('rolls back the row and receipt together and retries with the original key', async () => {
    const { store, request } = await fixture()
    const failure = vi.spyOn(store.settingsAudit, 'append').mockRejectedValueOnce(new Error('interrupted'))
    await expect(enrollSetupMachine(store, 'installation-a', request, actor)).rejects.toThrow('interrupted')
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
    expect(await readSetupEnrollment(store, 'installation-a', request)).toBeUndefined()
    failure.mockRestore()
    expect((await enrollSetupMachine(store, 'installation-a', request, actor)).publicKey).toBe(request.publicKey)
  })

  it('rejects a reused request with different values and a different installation collision', async () => {
    const { store, request } = await fixture()
    await enrollSetupMachine(store, 'installation-a', request, actor)
    await expect(enrollSetupMachine(store, 'installation-a', { ...request, agentExecution: false }, actor)).rejects.toThrow('different values')
    await expect(enrollSetupMachine(store, 'installation-b', request, actor)).rejects.toThrow('already enrolled')
  })

  it('does not provision an uncommitted web setup request at boot', async () => {
    const { store, request } = await fixture()
    expect(await completePreauthorizedSetup(store, 'installation-a', request)).toBeUndefined()
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
  })

  it('binds the sole setup member and activates its password in the enrollment transaction', async () => {
    const { store, request } = await fixture(true, false)
    const member = (await store.users.loadWorldUsers())[0]!
    const receipt = await completePreauthorizedSetup(store, 'installation-a', request, 'setup-password-hash')
    expect(receipt?.actor).toBe(member.id)
    expect((await store.users.credentialFor(asUserId(member.id)))?.passwordHash).toBe('setup-password-hash')
  })

  it('moves server assignment only in the explicit transfer transition and preserves agent execution', async () => {
    const { store, request } = await fixture()
    await enrollSetupMachine(store, 'installation-a', request, actor)
    const target = asMachineId('transfer-target')
    await store.machines.enrollMachine({ id: target, name: 'target', hostname: 'target',
      tokenHash: 'legacy-hash', ownerUserId: actor, podiumManaged: true,
      assignment: { server: false, agentExecution: true },
      assignmentEvidence: { version: 1, source: 'setup', requestId: 'target-setup' } })
    await store.machines.transferServerAssignment(request.machineId, target, 'transfer-1')
    await store.machines.transferServerAssignment(request.machineId, target, 'transfer-1')
    expect((await store.machines.getMachine(asMachineId(request.machineId)))?.serviceAssignment)
      .toEqual({ server: false, agentExecution: true })
    expect((await store.machines.getMachine(target))?.serviceAssignment)
      .toEqual({ server: true, agentExecution: true })
    expect(await store.machines.custodian(target)).toBe(actor)
  })

  it('records ambiguous first-boot membership as unowned and never re-infers it', async () => {
    const { store, request } = await fixture(true)
    await store.users.create({ id: asUserId('another-admin'), displayName: 'Other', role: 'admin',
      createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
    const first = await completePreauthorizedSetup(store, 'installation-a', request)
    expect(first?.actor).toBeNull()
    expect(await completePreauthorizedSetup(store, 'installation-a', request)).toEqual(first)
  })
})
