/**
 * REMOVING A SUBSCRIPTION LOGIN (credential management §8 "cleanup"; epic plan
 * Task 9, acceptance 6).
 *
 * A home Podium made goes, by the id its placement recorded, and the
 * placement is marked `removed` once the machine confirms. A login the person
 * made in a harness's own directory is theirs: removing its credential sends
 * nothing to the machine. Whether the vendor's sign-out runs first is the
 * remover's switch (`HOME_SIGN_OUT_ON_REMOVE`, off; see home-removers.test.ts).
 */

import { asMachineId, asUserId } from '@podium/model'
import { CAP_HARNESS_HOMES } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { CredentialHealth } from './health'
import { placementRemovers } from './home-removers'
import { Placements } from './placements'

const OWNER = asUserId('user:removal-owner')
const MACHINE = asMachineId('machine:removal')

async function setup() {
  const store = await openTestStore(':memory:')
  await memberFacts(store).create(
    { id: OWNER, displayName: 'o', role: 'member', createdAt: new Date().toISOString(), disabledAt: null },
    'not-a-real-hash',
  )
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'm',
    hostname: 'm.invalid',
    tokenHash: 'h',
    ownerUserId: OWNER,
  })
  const toMachine: string[] = []
  const placements = new Placements({
    store,
    transport: {
      isOnline: () => true,
      removers: placementRemovers({
        daemonSupports: (_m, cap) => cap === CAP_HARNESS_HOMES,
        rpc: {
          credentialRemove: async (harness, fingerprint) => {
            toMachine.push(`credentialRemove ${harness} ${fingerprint}`)
            return { outcome: 'removed' }
          },
          homeRemove: async (homeId, _machineId, options) => {
            toMachine.push(`homeRemove ${homeId}${options?.signOut ? ' signOut' : ''}`)
            return { ok: true, removed: true }
          },
        },
      }),
    },
  })
  const health = new CredentialHealth({ store, placements })
  return { store, health, toMachine }
}

describe('removing a subscription login (acceptance 6)', () => {
  it('a home Podium made is removed on the machine and its placement marked removed', async () => {
    const { store, health, toMachine } = await setup()
    const record = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Second Max',
      type: 'anthropic.claude-login',
      identity: { fingerprint: 'fp-FAKE-second' },
    })
    // The home a sign-in for another credential made, attached to this one.
    const homeId = 'cred_00000000-0000-4000-8000-0000000000e1:claude-code'
    await store.credentials.recordPlacement({ credentialId: record.id, machineId: MACHINE, kind: 'home', homeId })
    await health.removeEverywhere(record.id, OWNER)
    expect(toMachine).toEqual([`homeRemove ${homeId}`])
    expect(await store.credentials.listPlacements(record.id)).toEqual([
      expect.objectContaining({ kind: 'home', homeId, state: 'removed', removedAt: expect.any(String) }),
    ])
  })

  it('a login in a default home: nothing on the machine is touched', async () => {
    const { store, health, toMachine } = await setup()
    // As a found login is recorded: a row, and no placement.
    const record = await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'found@example.invalid',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'fp-FAKE-found' },
    })
    await health.removeEverywhere(record.id, OWNER)
    expect(toMachine).toEqual([])
    expect((await store.credentials.get(record.id))?.status).toBe('revoked')
  })
})
