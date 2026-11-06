/** Compose native client registration with real authenticated member authority. */
import { asMachineId, type UserId } from '@podium/model'
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
    ).rejects.toThrow(/requires an admin account/)
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

  describe('automatic retained client custody', () => {
    async function retained(suffix: string, owner: UserId) {
      const machineId = asMachineId(`retained-custody-${suffix}`)
      const publicKey = publicKeyWire(mintSigningKeyPair())
      const frame = {
        type: 'pair' as const,
        machineId,
        publicKey,
        hostname: suffix,
        assignment: { server: false, agentExecution: false },
      }
      expect(
        await store().machines.enrollMachine({
          id: machineId,
          name: suffix,
          hostname: suffix,
          tokenHash: '',
          credentialKind: 'ed25519',
          publicKey,
          ownerUserId: owner,
          podiumManaged: false,
          assignment: frame.assignment,
          assignmentEvidence: { version: 1, source: 'supervisor-enrollment', requestId: machineId },
        }),
      ).toBe(true)
      await machines().revokeMachine(machineId)
      return { machineId, publicKey, frame }
    }

    it.each([
      'foreign',
      'unowned',
    ] as const)('refuses automatic recovery of %s retained custody and leaves explicit replacement available', async (custody) => {
      const r = await retained(`mint-${custody}`, MEMBERS.bob.id)
      if (custody === 'unowned') await store().grants.removeAllForResource('machine', r.machineId)
      const owner = custody === 'foreign' ? MEMBERS.bob.id : null
      const before = await store().machines.getMachine(r.machineId)
      const grants = await store().grants.listForResource('machine', r.machineId)
      const alice = (await f.as('alice')).trpc
      await expect(
        alice.machines.pairingCode.mutate({
          clientRegistration: { machineId: r.machineId, publicKey: r.publicKey },
          copyAgentCredentials: false,
        }),
      ).rejects.toThrow(/current custodian/)
      expect(await store().machines.getMachine(r.machineId)).toEqual(before)
      expect(await store().grants.listForResource('machine', r.machineId)).toEqual(grants)
      expect(await store().machines.custodian(r.machineId)).toBe(owner)

      const explicit = await alice.machines.pairingCode.mutate({
        replaceMachineId: r.machineId,
        copyAgentCredentials: false,
      })
      expect(
        await machines().authenticateDaemon({ ...r.frame, code: explicit.code }),
      ).toMatchObject({ ok: true })
      expect(await store().machines.custodian(r.machineId)).toBe(MEMBERS.alice.id)
    })

    it('recovers the current custodian’s retained identity with client-only roles', async () => {
      const r = await retained('own', MEMBERS.alice.id)
      const before = await store().machines.getMachine(r.machineId)
      if (!before) throw new Error('retained fixture row is missing')
      const alice = (await f.as('alice')).trpc
      const reply = await alice.machines.pairingCode.mutate({
        clientRegistration: { machineId: r.machineId, publicKey: r.publicKey },
        copyAgentCredentials: false,
      })
      expect(
        await machines().authenticateDaemon(
          { ...r.frame, code: reply.code, assignment: { server: true, agentExecution: true } },
          { source: 'supervisor' },
        ),
      ).toMatchObject({ ok: true, enrolledPublicKey: r.publicKey })
      expect(await store().machines.custodian(r.machineId)).toBe(MEMBERS.alice.id)
      expect(await store().machines.getMachine(r.machineId)).toMatchObject({
        revokedAt: null,
        createdAt: before.createdAt,
        podiumManaged: false,
        serviceAssignment: { server: false, agentExecution: false },
      })
    })

    it.each([
      'foreign',
      'unowned',
    ] as const)('refuses redemption when retained custody becomes %s after mint', async (custody) => {
      const r = await retained(`redeem-${custody}`, MEMBERS.alice.id)
      const alice = (await f.as('alice')).trpc
      const reply = await alice.machines.pairingCode.mutate({
        clientRegistration: { machineId: r.machineId, publicKey: r.publicKey },
        copyAgentCredentials: false,
      })
      // Model the durable custody release/change while the one-use code is outstanding.
      await store().grants.removeAllForResource('machine', r.machineId)
      if (custody === 'foreign')
        await store().grants.upsert({
          resourceKind: 'machine',
          resourceId: r.machineId,
          grantee: MEMBERS.bob.id,
          verb: 'manage',
          custody: true,
          owner: MEMBERS.bob.id,
          visibility: 'owned-compute',
          createdAt: new Date().toISOString(),
          actorKind: 'user',
          actorId: MEMBERS.bob.id,
          onBehalfOf: MEMBERS.bob.id,
        })
      const before = await store().machines.getMachine(r.machineId)
      const grants = await store().grants.listForResource('machine', r.machineId)
      expect(await machines().authenticateDaemon({ ...r.frame, code: reply.code })).toMatchObject({
        ok: false,
      })
      expect(await store().machines.getMachine(r.machineId)).toEqual(before)
      expect(await store().grants.listForResource('machine', r.machineId)).toEqual(grants)
      expect(await store().machines.custodian(r.machineId)).toBe(
        custody === 'foreign' ? MEMBERS.bob.id : null,
      )
    })
  })
})
