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
