import { describe, expect, it } from 'vitest'
import {
  type AsyncKeyValueStorage,
  createAsyncStorageReplicaStorage,
} from '../replica/async-storage'

const backing = (changes: Partial<AsyncKeyValueStorage>): AsyncKeyValueStorage => ({
  getAllKeys: async () => [],
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
  ...changes,
})

describe('durable settings bridge fence', () => {
  it('refuses a failed hydration even when subsequent marker writes succeed', async () => {
    const bridge = await createAsyncStorageReplicaStorage(
      backing({
        getAllKeys: async () => {
          throw new Error('unreadable')
        },
      }),
    )
    bridge.storage.setItem('podium.replica.namespace', 'marker')
    await expect(bridge.flushDurable()).rejects.toThrow('Small-settings storage is unavailable')
  })
  it('refuses a failed marker write while preserving best-effort flush for side caches', async () => {
    const bridge = await createAsyncStorageReplicaStorage(
      backing({
        setItem: async () => {
          throw new Error('disk full')
        },
      }),
    )
    bridge.storage.setItem('podium.replica.namespace', 'marker')
    await expect(bridge.flush()).resolves.toBeUndefined()
    await expect(bridge.flushDurable()).rejects.toMatchObject({ cause: new Error('disk full') })
  })
  it('does not certify erasure when the native remove failed', async () => {
    const bridge = await createAsyncStorageReplicaStorage(
      backing({
        removeItem: async () => {
          throw new Error('denied')
        },
      }),
    )
    bridge.storage.removeItem('podium.replica.namespace')
    await expect(bridge.flushDurable()).rejects.toThrow('Small-settings storage is unavailable')
  })
})
