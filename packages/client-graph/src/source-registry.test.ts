import { expect, it, vi } from 'vitest'
import { autorun, observable, runInAction } from 'mobx'
import { PoolSources, type PoolSource } from './source-registry'
import { LOADING } from './worklist/rollup'

function source() {
  const rows = observable.map([['window', { settingsTab: 'general' as const }]], { deep: false })
  const dispose = vi.fn()
  const value: PoolSource<'settingsWindow'> = { read: (_entity, id) => rows.get(id), dispose }
  return { value, rows, dispose }
}

it('source registration wakes a pending one-reader projection and follows addressed updates', () => {
  const registry = new PoolSources(), owned = source(), values: unknown[] = []
  const stop = autorun(() => values.push(registry.read('settingsWindow', 'window')))
  try {
    expect(values).toEqual([LOADING])
    registry.register(['settingsWindow'], owned.value)
    expect(values.at(-1)).toEqual({ settingsTab: 'general' })
    runInAction(() => owned.rows.set('window', { settingsTab: 'general' }))
    expect(values).toHaveLength(3)
    expect(registry.read('settingsWindow', 'absent')).toBeUndefined()
  } finally { stop(); registry.dispose() }
})

it('conflicting registrations are atomic and every source and view disposes once', () => {
  const registry = new PoolSources(), owned = source(), conflict = source()
  registry.register(['settingsWindow'], owned.value)
  const mixed: PoolSource<'settingsWindow' | 'settingsCatalog'> = { ...conflict.value, read: () => ({ machines: [], repositories: [] }) as never }
  expect(() => registry.register(['settingsCatalog', 'settingsWindow'], mixed)).toThrow('conflicts')
  expect(conflict.dispose).toHaveBeenCalledTimes(1)
  expect(registry.read('settingsCatalog', 'catalog')).toBe(LOADING)
  expect(registry.read('settingsWindow', 'window')).toEqual({ settingsTab: 'general' })
  const view = { dispose: vi.fn() }
  expect(registry.view('test', () => view)).toBe(view)
  expect(registry.view('test', () => ({ dispose: vi.fn() }))).toBe(view)
  registry.dispose(); registry.dispose()
  expect(owned.dispose).toHaveBeenCalledTimes(1)
  expect(view.dispose).toHaveBeenCalledTimes(1)
  expect(registry.read('settingsWindow', 'window')).toBe(LOADING)
  const late = source()
  expect(() => registry.register(['settingsWindow'], late.value)).toThrow('conflicts')
  expect(late.dispose).toHaveBeenCalledTimes(1)
})
