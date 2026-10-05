import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { expect, it, vi } from 'vitest'
import { autorun, configure, observable, runInAction } from 'mobx'
import { PoolSources, type PoolSource, type PoolSourceRows } from './source-registry'
import { SettingsSource } from './settings-source'
import { LOADING, type Loaded } from './worklist/rollup'


interface NumericSourceRows { sourceTypeProbe: { count: number } }
interface TextSourceRows { sourceTextProbe: { label: string } }
declare module './source-registry' {
  interface PoolSourceRows extends NumericSourceRows, TextSourceRows {}
}

class SourceProbe<E extends keyof NumericSourceRows | keyof TextSourceRows> implements PoolSource<E> {
  constructor(private readonly values: Pick<PoolSourceRows, E>) {}
  read<K extends E>(entity: K, _id: string): Loaded<PoolSourceRows[K]> { return this.values[entity] }
  dispose() {}
}

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

it('source teardown honors the strict observable read trap', async () => {
  configure({ enforceActions: 'always', observableRequiresReaction: true })
  const warn = vi.spyOn(console, 'warn').mockImplementation((message) => { throw new Error(String(message)) })
  try {
    const registry = new PoolSources(), owned = source()
    registry.register(['settingsWindow'], owned.value)
    expect(() => registry.dispose()).not.toThrow()
    await Promise.resolve()
    expect(owned.dispose).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    configure({ enforceActions: 'never', observableRequiresReaction: false })
    warn.mockRestore()
  }
})

it('releases a subscribed class owner once when shared by a source and a screen view', () => {
  const registry = new PoolSources(), signal = observable.box(1), observed: number[] = []
  class Owner {
    releases = 0
    private readonly stop = autorun(() => observed.push(signal.get()))
    read() { return { settingsTab: 'general' as const } }
    dispose() { this.releases++; this.stop() }
  }
  const owner = new Owner()
  registry.register(['settingsWindow'], owner)
  registry.view('subscribed screen', () => owner)
  registry.dispose(); registry.dispose()
  runInAction(() => signal.set(2))
  expect(owner.releases).toBe(1)
  expect(observed).toEqual([1])
})

it('does not create a subscribed screen view after registry disposal', () => {
  const registry = new PoolSources(), owner = { dispose: vi.fn() }, create = vi.fn(() => owner)
  expect(registry.view('known screen', create)).toBe(owner)
  registry.dispose()
  expect(registry.view('known screen', create)).toBe(owner)
  expect(() => registry.view('late screen', create)).toThrow('disposed before view creation')
  expect(create).toHaveBeenCalledTimes(1)
  expect(owner.dispose).toHaveBeenCalledTimes(1)
})

it('independent row declarations preserve a typed public reader', () => {
  const registry = new PoolSources()
  const custom = new SourceProbe<'sourceTypeProbe'>({ sourceTypeProbe: { count: 3 } })
  const independent = new SourceProbe<'sourceTextProbe'>({ sourceTextProbe: { label: 'Second source' } })
  const settings = new SettingsSource(withKeyedInputs({ getSnapshot: () => ({ machines: [], repos: [], settingsTab: 'general' }), subscribe: () => () => {} }))
  registry.register(['sourceTypeProbe'], custom)
  registry.register(['sourceTextProbe'], independent)
  registry.register(['settingsWindow', 'settingsCatalog', 'settingsMachine', 'settingsRepository'], settings)
  const value = registry.read('sourceTypeProbe', 'probe')
  const text = registry.read('sourceTextProbe', 'probe')
  expect(value && value !== LOADING ? value.count : undefined).toBe(3)
  expect(text && text !== LOADING ? text.label : undefined).toBe('Second source')
  registry.dispose()
})
