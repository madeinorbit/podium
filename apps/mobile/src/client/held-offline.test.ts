/**
 * POD-7176 — whose data the phone holds when the server gave no answer. The
 * markers are written by the producer itself (`preparePrincipalNamespace`, what
 * a replica opening writes), into the storage the phone web reads them from.
 */
import type { ServerProfile } from '@podium/client-core/accounts'
import {
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  replicaNamespaceKey,
} from '@podium/client-core/replica'
import { afterEach, describe, expect, it } from 'vitest'
import { heldOfflineStatus } from './held-offline'

const ALICE = replicaNamespaceKey({ syncBoundaryId: 'installation-a', memberId: 'mem_alice' })
const BOB = replicaNamespaceKey({ syncBoundaryId: 'installation-a', memberId: 'mem_bob' })

function openReplicaFor(principal: string): void {
  preparePrincipalNamespace({
    storage: window.localStorage,
    enumerateKeys: () => Object.keys(window.localStorage),
    basePrefix: REPLICA_KEY_PREFIX,
    principal,
  })
}

const verifiedProfile: ServerProfile = {
  id: 'saved-server',
  name: 'Saved server',
  httpOrigin: 'https://podium.example',
  instanceId: 'instance-a',
  mode: 'protected',
  transport: 'trusted-https',
  userId: 'mem_alice',
  memberId: 'mem_alice',
  syncBoundaryId: 'installation-a',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

afterEach(() => window.localStorage.clear())

describe('heldOfflineStatus', () => {
  it('web: names the one member whose replica this browser holds', async () => {
    openReplicaFor(ALICE)
    await expect(heldOfflineStatus(undefined, { platform: 'web' })).resolves.toMatchObject({
      authed: true,
      syncBoundaryId: 'installation-a',
      memberId: 'mem_alice',
      userId: 'mem_alice',
    })
  })

  it('web: nothing held, or two members held, opens nothing', async () => {
    await expect(heldOfflineStatus(undefined, { platform: 'web' })).resolves.toBeUndefined()
    openReplicaFor(ALICE)
    openReplicaFor(BOB)
    await expect(heldOfflineStatus(undefined, { platform: 'web' })).resolves.toBeUndefined()
  })

  it('native: only a profile a verified connection completed may open offline', async () => {
    openReplicaFor(BOB) // markers never name the member on native: the profile does
    await expect(heldOfflineStatus(verifiedProfile, { platform: 'ios' })).resolves.toMatchObject({
      memberId: 'mem_alice',
    })
    await expect(
      heldOfflineStatus({ ...verifiedProfile, instanceId: undefined }, { platform: 'ios' }),
    ).resolves.toBeUndefined()
    await expect(
      heldOfflineStatus({ ...verifiedProfile, signedOut: true }, { platform: 'android' }),
    ).resolves.toBeUndefined()
  })
})
