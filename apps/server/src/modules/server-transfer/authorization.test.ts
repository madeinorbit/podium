import { asMachineId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { MachinesService } from '../machines/service'
import { serverMoveAuthorization } from './authorization'

const targetMachineId = asMachineId('target-1')
const admin = asUserId('user:admin')

function machines(owner = admin): MachinesService {
  return {
    ownershipRows: () => [{ id: targetMachineId, ownerUserId: owner }],
    grantsForMachine: () => [],
  } as unknown as MachinesService
}

describe('server move durable reauthorization', () => {
  it.each([
    'prepare',
    'stage',
    'validate',
    'fence',
    'commit',
  ] as const)('rechecks the live admin and manage grant at %s', async (phase) => {
    const authorization = serverMoveAuthorization({
      authorizedBy: admin,
      targetMachineId,
      machines: machines(),
      roleOf: async (userId) => (userId === admin ? 'admin' : undefined),
    })

    await expect(authorization.reauthorize(phase)).resolves.toBeUndefined()
  })

  it.each([
    ['missing actor', 'user:missing', undefined],
    ['demoted actor', admin, 'member'],
    ['session actor', 'session:agent-1', 'admin'],
    ['system actor', 'system:boot-reconcile', 'admin'],
  ] as const)('refuses a %s at every privileged boundary', async (_name, authorizedBy, role) => {
    const authorization = serverMoveAuthorization({
      authorizedBy,
      targetMachineId,
      machines: machines(),
      roleOf: async () => role,
    })

    for (const phase of ['prepare', 'stage', 'validate', 'fence', 'commit'] as const) {
      await expect(authorization.reauthorize(phase)).rejects.toMatchObject({
        code: 'reauthorization-denied',
      })
    }
  })

  it('refuses an admin whose target manage grant was revoked', async () => {
    const authorization = serverMoveAuthorization({
      authorizedBy: admin,
      targetMachineId,
      machines: machines(asUserId('user:other')),
      roleOf: async () => 'admin',
    })

    await expect(authorization.reauthorize('commit')).rejects.toMatchObject({
      code: 'reauthorization-denied',
    })
  })
})
