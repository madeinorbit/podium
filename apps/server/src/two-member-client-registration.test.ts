/** Compose native client registration with real authenticated member authority. */
import { asMachineId } from '@podium/model'
import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
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
afterAll(async () => await f?.close())
const store = () => f.handle.registry.sessionStore
const machines = () => f.handle.registry.modules.machines

describe('client registration member authority', () => {
  it('refuses an ordinary member without enrolling or changing machine custody', async () => {
    const bob = (await f.as('bob')).trpc
    const id = asMachineId('client-member-refused')
    await expect(
      bob.machines.pairingCode.mutate({
        clientRegistration: { machineId: id, publicKey: publicKeyWire(mintSigningKeyPair()) },
        copyAgentCredentials: false,
      }),
    ).rejects.toThrow(/administrator/)
    expect(await store().machines.getMachine(id)).toBeUndefined()
    expect(await store().machines.custodian(f.machines.bob)).toBe(MEMBERS.bob.id)
  })

  it('enrolls for the current administrator rather than the earliest administrator, with client-only roles', async () => {
    await store().users.setRole(MEMBERS.bob.id, 'admin', MEMBERS.alice.id)
    try {
      const bob = (await f.as('bob')).trpc
      const id = asMachineId('client-current-admin')
      const publicKey = publicKeyWire(mintSigningKeyPair())
      const reply = await bob.machines.pairingCode.mutate({
        clientRegistration: { machineId: id, publicKey },
        podiumManaged: true,
        copyAgentCredentials: false,
      })
      expect(reply.joinCommand).toBeNull()
      expect(
        await machines().authenticateDaemon(
          {
            type: 'pair',
            code: reply.code,
            machineId: id,
            publicKey,
            hostname: 'current-admin-client',
            assignment: { server: true, agentExecution: true },
          },
          { source: 'supervisor' },
        ),
      ).toMatchObject({ ok: true, enrolledPublicKey: publicKey })
      expect(await store().machines.custodian(id)).toBe(MEMBERS.bob.id)
      expect(await store().machines.getMachine(id)).toMatchObject({
        podiumManaged: true,
        serviceAssignment: { server: false, agentExecution: false },
      })
      expect(await store().machines.custodian(f.machines.alice)).toBe(MEMBERS.alice.id)
    } finally {
      await store().users.setRole(MEMBERS.bob.id, 'member', MEMBERS.alice.id)
    }
  })

  it('does not replace another member’s active machine through automatic registration', async () => {
    const alice = (await f.as('alice')).trpc
    const before = await store().machines.credentialIncarnation(f.machines.bob)
    await expect(
      alice.machines.pairingCode.mutate({
        clientRegistration: {
          machineId: f.machines.bob,
          publicKey: publicKeyWire(mintSigningKeyPair()),
        },
        copyAgentCredentials: false,
      }),
    ).rejects.toThrow(/already registered/)
    expect(await store().machines.credentialIncarnation(f.machines.bob)).toBe(before)
    expect(await store().machines.custodian(f.machines.bob)).toBe(MEMBERS.bob.id)
  })
})
