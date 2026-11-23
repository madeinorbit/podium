// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { LazySurfaceRegistry } from './lazy-surface'
import { prefetchAfterFirstPaint } from './prefetch-after-first-paint'

afterEach(() => vi.unstubAllGlobals())

it('imports the closure of lazy declarations after idle, leaving no unloaded surface', async () => {
  const registry = new LazySurfaceRegistry()
  const leaf = vi.fn(async () => 'leaf')
  const nested = vi.fn(async () => {
    registry.register(leaf)
    return 'nested'
  })
  const root = vi.fn(async () => {
    registry.register(nested)
    return 'root'
  })
  registry.register(root)
  const idle: { run?: () => void; warmed?: Promise<void> } = {}
  vi.stubGlobal('requestIdleCallback', (run: () => void) => {
    idle.run = run
    return 1
  })
  prefetchAfterFirstPaint(() => {
    idle.warmed = registry.warm()
    return idle.warmed
  })
  expect(root).not.toHaveBeenCalled()
  expect(registry.snapshot()).toEqual({ registered: 1, loaded: 0, unloaded: 1 })
  idle.run?.()
  await idle.warmed
  expect(root).toHaveBeenCalledOnce()
  expect(nested).toHaveBeenCalledOnce()
  expect(leaf).toHaveBeenCalledOnce()
  expect(registry.snapshot()).toEqual({ registered: 3, loaded: 3, unloaded: 0 })
})

it('shares the resolved module between warming and rendering', async () => {
  const registry = new LazySurfaceRegistry()
  const module = { Screen: () => null }
  const load = vi.fn(async () => module)
  const read = registry.register(load)
  await registry.warm()
  expect(await read()).toBe(module)
  expect(load).toHaveBeenCalledOnce()
})

it('bounds a failed warmup and allows a later request to retry', async () => {
  const registry = new LazySurfaceRegistry()
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ready')
  const read = registry.register(load)
  await registry.warm()
  expect(registry.snapshot().unloaded).toBe(1)
  expect(load).toHaveBeenCalledOnce()
  expect(await read()).toBe('ready')
  expect(registry.snapshot().unloaded).toBe(0)
})
