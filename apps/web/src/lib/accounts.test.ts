import { IDBFactory } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { principalKeyPrefix } from '@podium/client-core/replica'
import { webAccountEraser, webAccounts } from './accounts'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import { actorUser, asMutationId, asUserId } from '@podium/model'
import { KERNEL_SIDE_CACHE_PREFIX, KERNEL_REPLICA_DB } from './kernelReplica'

const ALICE = JSON.stringify(['installation-a', 'alice'])
const BOB = JSON.stringify(['installation-a', 'bob'])
afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('calls the mounted kernel’s erase method when a web account is removed', async () => {
  const accounts = webAccounts('https://a.example')
  await accounts.recordPrincipal(ALICE)
  const erasePrincipalData = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const owner = webAccountEraser.register(ALICE, { erasePrincipalData, dispose })
  await accounts.remove()
  expect(erasePrincipalData).toHaveBeenCalledOnce()
  expect((await accounts.profiles.loadServerProfiles()).profiles).toEqual([])
  expect(await accounts.profiles.loadPendingProfileCleanups()).toEqual([])
  await owner.dispose()
})

it('erases only the removed namespace from IndexedDB and browser storage when no app is mounted', async () => {
  const factory = new IDBFactory() as unknown as IdbFactoryLike
  vi.stubGlobal('indexedDB', factory)
  const seeded = await IndexedDbSyncStore.open({
    factory,
    databaseName: KERNEL_REPLICA_DB,
    onDegraded: () => {},
  })
  for (const principal of [ALICE, BOB]) {
    seeded
      .viewFor(principal)
      .cache.installSnapshot(
        [
          {
            entity: 'issueProjection',
            entityId: 'i',
            value: { title: principal },
            provenance: { seq: 1 },
          },
        ],
        { feedId: 'feed', epoch: 'e', seq: 1 },
        [],
      )
    const mutationId = asMutationId('queued')
    const userId = asUserId(principal === ALICE ? 'alice' : 'bob')
    await seeded.viewFor(principal).outbox.apply({
      put: [
        {
          mutationId,
          command: { name: 'issues.rename', version: 1, delivery: 'offline-eligible' },
          input: { id: 'i', title: 'queued' },
          partitionKey: 'issue:i',
          attribution: { actor: actorUser(userId), onBehalfOf: userId },
          state: 'queued',
          queuedAt: 1,
          attempts: 0,
        },
      ],
      expect: [{ mutationId, expect: 'absent' }],
    })
  }
  await seeded.settled()
  seeded.close()
  const accounts = webAccounts('https://a.example')
  await accounts.recordPrincipal(ALICE)
  const aliceKey = principalKeyPrefix(KERNEL_SIDE_CACHE_PREFIX, ALICE) + '.ui-state'
  const bobKey = principalKeyPrefix(KERNEL_SIDE_CACHE_PREFIX, BOB) + '.ui-state'
  localStorage.setItem(aliceKey, 'alice-data')
  localStorage.setItem(bobKey, 'bob-data')
  await accounts.remove()
  expect(localStorage.getItem(aliceKey)).toBeNull()
  expect(localStorage.getItem(bobKey)).toBe('bob-data')
  const reopened = await IndexedDbSyncStore.open({
    factory,
    databaseName: KERNEL_REPLICA_DB,
    onDegraded: () => {},
  })
  try {
    expect(reopened.viewFor(ALICE).cache.readEntities()).toEqual([])
    expect(reopened.viewFor(ALICE).cache.readCursor()).toBeNull()
    expect(await reopened.viewFor(ALICE).outbox.read()).toEqual([])
    expect(reopened.viewFor(BOB).cache.readEntities()).toHaveLength(1)
    expect(reopened.viewFor(BOB).cache.readCursor()).toMatchObject({ seq: 1 })
    expect(await reopened.viewFor(BOB).outbox.read()).toHaveLength(1)
  } finally {
    reopened.close()
  }
})

it('retains an erasure tombstone across a failed web cleanup and retries before a new account opens', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const accounts = webAccounts('https://a.example')
  await accounts.recordPrincipal(ALICE)
  const erasePrincipalData = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk unavailable'))
    .mockResolvedValue(undefined)
  const owner = webAccountEraser.register(ALICE, { erasePrincipalData, dispose: async () => {} })
  await expect(accounts.remove()).rejects.toThrow('disk unavailable')
  expect(await accounts.profiles.loadPendingProfileCleanups()).toMatchObject([{ principal: ALICE }])
  expect((await accounts.profiles.loadServerProfiles()).profiles).toEqual([])
  await accounts.recordPrincipal(BOB)
  expect(erasePrincipalData).toHaveBeenCalledTimes(2)
  expect(await accounts.profiles.loadPendingProfileCleanups()).toEqual([])
  expect((await accounts.profiles.loadServerProfiles()).profiles[0]?.memberId).toBe('bob')
  await owner.dispose()
})
