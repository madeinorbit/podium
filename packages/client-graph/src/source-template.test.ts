import { observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { defineSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

it('coalesces a wake burst and publishes the final owner value in one drain', async () => {
  let owner = 1
  const value = observable.box<Loaded<{ value: number }>>(LOADING, { deep: false })
  const read = vi.fn(() => value.get())
  const refresh = vi.fn(() => runInAction(() => value.set({ value: owner })))
  const source = defineSource({ readById: read, refresh, release: () => {} })
  expect(source.read()).toBe(LOADING)
  source.schedule()
  owner = 2
  source.schedule()
  owner = 3
  source.schedule()
  expect(refresh).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(source.read()).toEqual({ value: 3 })
  source.dispose()
})

it('cancels a queued owner read and releases exactly once after disposal', async () => {
  const read = vi.fn((id: string) => ({ id })), refresh = vi.fn(), release = vi.fn()
  const source = defineSource({ readById: read, refresh, release })
  expect(source.read('a')).toEqual({ id: 'a' })
  source.schedule()
  source.dispose()
  source.dispose()
  source.schedule()
  expect(source.read('b')).toBe(LOADING)
  await Promise.resolve()
  expect(read.mock.calls.map(([id]) => id)).toEqual(['a'])
  expect(refresh).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
})

it('preserves synchronous adapters and their disposed read value', async () => {
  const read = vi.fn((id: string) => ({ id })), release = vi.fn()
  const source = defineSource({ readById: read, release, disposedValue: undefined })
  source.schedule()
  await Promise.resolve()
  expect(source.read('a')).toEqual({ id: 'a' })
  source.dispose()
  expect(source.read('b')).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})
