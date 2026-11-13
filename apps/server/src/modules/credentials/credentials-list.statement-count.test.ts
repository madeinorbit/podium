/**
 * `credentials.list` READS THE SAME NUMBER OF STATEMENTS AT 5 AND 200 CREDENTIALS
 * [server-data rule 8; credential management Task 4].
 *
 * The viewer owns `size` credentials and was given `size` more, by `size`
 * different owners, half to them and half to all members, each allowed on a
 * machine. One read each: the viewer's own, the grants to the viewer or all
 * members, those credentials, all their grants, the granters' standing, and the
 * allowed machines.
 */

import { ALL_MEMBERS_GRANTEE, asMachineId, asUserId, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { withOperation } from '../../store/executor/operation-scope'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { listCredentials } from './queries'

interface Fixture {
  store: SessionStore
  viewer: UserId
}

const MACHINE = asMachineId('machine:list-pin')

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const viewer = asUserId('user:list-viewer')
  const person = async (id: UserId) =>
    await memberFacts(store).create(
      {
        id,
        displayName: id,
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  await person(viewer)
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'pin',
    hostname: 'pin.local',
    tokenHash: 'hash-pin',
    ownerUserId: viewer,
  })
  for (let i = 0; i < size; i++) {
    const own = await store.credentials.insert({
      ownerUserId: viewer,
      label: `Mine ${i}`,
      type: 'openai.api-key',
    })
    await store.credentials.allowMachine(own.id, MACHINE, viewer)
    const owner = asUserId(`user:list-owner-${i}`)
    await person(owner)
    const theirs = await store.credentials.insert({
      ownerUserId: owner,
      label: `Theirs ${i}`,
      type: 'anthropic.api-key',
    })
    await store.credentials.allowMachine(theirs.id, MACHINE, owner)
    await store.grants.upsert({
      resourceKind: 'credential',
      resourceId: theirs.id,
      grantee: i % 2 === 0 ? viewer : ALL_MEMBERS_GRANTEE,
      verb: 'use',
      owner,
      visibility: 'secret',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: owner,
      onBehalfOf: owner,
    })
  }
  return { store, viewer }
}

const pin: StatementPin<Fixture> = {
  name: 'credentials.list',
  setup: fixture,
  target: (f) => f.store,
  run: async (f) => await withOperation(async () => await listCredentials(f.store, f.viewer)),
  check: (result, _f, size) => {
    const views = result as { access: string; allowedMachines: string[] }[]
    expect(views).toHaveLength(2 * size)
    expect(views.filter((v) => v.access === 'use')).toHaveLength(size)
    expect(views.every((v) => v.allowedMachines.length === 1)).toBe(true)
  },
  teardown: async (f) => await f.store.close(),
}

describe('credentials.list statement count', () => {
  it('is seven statements at 5 and at 200 credentials', async () => {
    await expectConstantStatements(pin, 7)
  })

  it('is armed: a read per credential on its path fails the pin', async () => {
    await expectArmed(pin, 7, (f) => {
      const credentials = f.store.credentials
      const original = credentials.allowedMachinesOf.bind(credentials)
      credentials.allowedMachinesOf = async (ids) => {
        for (const id of ids) await credentials.get(id)
        return await original(ids)
      }
      return () => {
        credentials.allowedMachinesOf = original
      }
    })
  })
})
