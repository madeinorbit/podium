import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AsyncKeyValueStorage, createAsyncStorageReplicaStorage } from './async-storage'

function backingStorage(overrides: Partial<AsyncKeyValueStorage> = {}): AsyncKeyValueStorage {
  return {
    getAllKeys: async () => [],
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    ...overrides,
  }
}

afterEach(() => vi.useRealTimers())

describe('AsyncStorage replica bridge', () => {
  it('debounces a hot key and persists only its latest pending value', async () => {
    vi.useFakeTimers()
    const setItem = vi.fn(async () => {})
    const bridge = await createAsyncStorageReplicaStorage(backingStorage({ setItem }), [], {
      coalesce: (key) => key === 'hot',
      settleMs: 250,
    })

    bridge.storage.setItem('hot', 'one')
    bridge.storage.setItem('hot', 'two')
    bridge.storage.setItem('hot', 'three')
    expect(bridge.storage.getItem('hot')).toBe('three')
    expect(setItem).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(249)
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await bridge.flush()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith('hot', 'three')
  })

  it('keeps one pending value per hot key while the backing store is slow', async () => {
    vi.useFakeTimers()
    let releaseFirst: (() => void) | undefined
    const calls: [string, string][] = []
    const setItem = vi.fn(async (key: string, value: string) => {
      calls.push([key, value])
      if (calls.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve))
    })
    const bridge = await createAsyncStorageReplicaStorage(backingStorage({ setItem }), [], {
      coalesce: () => true,
      settleMs: 10,
    })

    bridge.storage.setItem('hot', '0')
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 1; i <= 100; i += 1) bridge.storage.setItem('hot', String(i))
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toEqual([['hot', '0']])

    const flushed = bridge.flush()
    releaseFirst?.()
    await flushed
    expect(calls).toEqual([
      ['hot', '0'],
      ['hot', '100'],
    ])
  })

  it('uses ordered keys as fences around coalesced side-cache writes', async () => {
    const calls: [string, string][] = []
    const bridge = await createAsyncStorageReplicaStorage(
      backingStorage({
        setItem: async (key, value) => {
          calls.push([key, value])
        },
      }),
      [],
      { coalesce: (key) => key === 'transcript', settleMs: 10_000 },
    )

    bridge.storage.setItem('transcript', 'old')
    bridge.storage.setItem('transcript', 'latest')
    bridge.storage.setItem('cursor', '7')
    await bridge.flush()

    expect(calls).toEqual([
      ['transcript', 'latest'],
      ['cursor', '7'],
    ])
  })

  it('flush forces pending work and backing failures do not poison later writes', async () => {
    const calls: string[] = []
    const bridge = await createAsyncStorageReplicaStorage(
      backingStorage({
        setItem: async (key) => {
          calls.push(key)
          if (key === 'hot') throw new Error('denied')
        },
      }),
      [],
      { coalesce: (key) => key === 'hot', settleMs: 10_000 },
    )

    bridge.storage.setItem('hot', 'latest')
    bridge.storage.setItem('ordered', 'after')
    await expect(bridge.flush()).resolves.toBeUndefined()
    expect(calls).toEqual(['hot', 'ordered'])
  })
})

it('hydrates the same filtered side cache through one native batch or the scalar fallback', async () => {
  const persisted = new Map<string, string | null>([
    ['podium.a', 'first'],
    ['podium.b', ''],
    ['podium.removed', null],
    ['unrelated', 'private'],
  ])
  const getItem = vi.fn(async (key: string) => persisted.get(key) ?? null)
  const base = backingStorage({ getAllKeys: async () => [...persisted.keys()], getItem })
  const scalar = await createAsyncStorageReplicaStorage(base, ['podium.'])
  expect(getItem).toHaveBeenCalledTimes(3)
  getItem.mockClear()
  const multiGet = vi.fn(async (keys: readonly string[]) =>
    keys.map((key) => [key, persisted.get(key) ?? null] as const),
  )
  const batch = await createAsyncStorageReplicaStorage({ ...base, multiGet }, ['podium.'])
  expect(multiGet).toHaveBeenCalledExactlyOnceWith(['podium.a', 'podium.b', 'podium.removed'])
  expect(getItem).not.toHaveBeenCalled()
  expect(batch.keys()).toEqual(scalar.keys())
  for (const key of persisted.keys())
    expect(batch.storage.getItem(key)).toBe(scalar.storage.getItem(key))
  expect(batch.storage.getItem('unrelated')).toBeNull()
})

it('keeps a failed native batch behind the existing durable boot fence', async () => {
  const error = new Error('native read failed')
  const bridge = await createAsyncStorageReplicaStorage(
    backingStorage({
      getAllKeys: async () => ['podium.a'],
      multiGet: async () => {
        throw error
      },
    }),
    ['podium.'],
  )
  expect(bridge.keys()).toEqual([])
  await expect(bridge.flushDurable()).rejects.toMatchObject({
    message: 'Small-settings storage is unavailable',
    cause: error,
  })
})

it('does not send an empty native batch', async () => {
  const multiGet = vi.fn(async () => [])
  await createAsyncStorageReplicaStorage(backingStorage({ multiGet }))
  expect(multiGet).not.toHaveBeenCalled()
})
