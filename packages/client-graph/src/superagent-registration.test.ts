import { expect, it, vi } from 'vitest'
import { PoolSources, type PoolSource } from './source-registry'
import { SUPERAGENT_ENTITIES, SUPERAGENT_SOURCE_KEY, type SuperagentRows } from './superagent'

function source(): PoolSource<keyof SuperagentRows> {
  return { read: () => undefined, dispose: vi.fn() }
}

it('reuses one pending factory and one source for the same declared key', async () => {
  const registry = new PoolSources(), value = source(), create = vi.fn(async () => value)
  const first = registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, create)
  const second = registry.ensure(SUPERAGENT_SOURCE_KEY, [...SUPERAGENT_ENTITIES].reverse(), create)
  expect(second).toBe(first)
  expect(await first).toBe(value)
  expect(await registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, create)).toBe(value)
  expect(create).toHaveBeenCalledTimes(1)
  registry.dispose()
  expect(value.dispose).toHaveBeenCalledTimes(1)
})
it('rejects a different key while the same entities are reserved or installed', async () => {
  const registry = new PoolSources(), value = source(), other = vi.fn(source)
  const first = registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => value)
  expect(() => registry.ensure('other-owner', SUPERAGENT_ENTITIES, other)).toThrow(/owner/)
  const direct = source()
  expect(() => registry.register(SUPERAGENT_ENTITIES, direct)).toThrow(/owner/)
  expect(direct.dispose).toHaveBeenCalledTimes(1)
  await first
  expect(() => registry.ensure('other-owner', SUPERAGENT_ENTITIES, other)).toThrow(/owner/)
  expect(other).not.toHaveBeenCalled()
  registry.dispose()
})
it('rejects a changed or duplicate entity declaration for an existing key', async () => {
  const registry = new PoolSources(), value = source()
  await registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => value)
  expect(() => registry.ensure(SUPERAGENT_SOURCE_KEY, ['superThread'], source)).toThrow(/declaration/)
  expect(() => registry.ensure('duplicate', ['superThread', 'superThread'], source)).toThrow(/owner/)
  registry.dispose()
})
it('disposes a late factory result and refuses to reuse a disposed registry', async () => {
  const registry = new PoolSources(), value = source()
  let resolve!: (result: typeof value) => void
  const pending = registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES,
    () => new Promise<typeof value>(done => { resolve = done }))
  await Promise.resolve()
  registry.dispose(); resolve(value)
  await expect(pending).rejects.toThrow(/owner/)
  expect(value.dispose).toHaveBeenCalledTimes(1)
  expect(() => registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, source)).toThrow(/owner/)
})
it('releases a failed factory reservation so the owner can retry', async () => {
  const registry = new PoolSources(), value = source()
  await expect(registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => { throw new Error('fixture failure') })).rejects.toThrow('fixture failure')
  expect(await registry.ensure(SUPERAGENT_SOURCE_KEY, SUPERAGENT_ENTITIES, () => value)).toBe(value)
  registry.dispose()
})
