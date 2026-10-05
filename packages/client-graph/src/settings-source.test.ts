import type { KeyedListChange } from '@podium/client-core/engine'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { SettingsSource, type SettingsOwner } from './settings-source'
import { LOADING } from './worklist/rollup'

it('reads only changed settings keys and no list membership on scalar updates at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const machines = new Map(Array.from({ length: 128 * scale }, (_, n) => [`m${n}`, { id: `m${n}`, name: `Machine ${n}` }]))
    const repos = new Map(Array.from({ length: 128 * scale }, (_, n) => [`r${n}`, { path: `/repo/${n}`, worktrees: [] }]))
    const lists = new Map<string, (change: KeyedListChange) => void>()
    let local!: (changed: ReadonlySet<string>) => void
    let tab = 'sessions'
    const ids = vi.fn((name: string) => [...(name === 'machines' ? machines : repos).keys()]),
      row = vi.fn((name: string, id: string) => name === 'machines' ? machines.get(id) : repos.get(id))
    const source = new SettingsSource({
      listIds: ids, listRow: row, readLocal: () => tab,
      onList: (name: string, changed: (change: KeyedListChange) => void) => { lists.set(name, changed); return () => { lists.delete(name) } },
      onLocals: (_keys: readonly string[], changed: typeof local) => { local = changed; return () => {} },
    } as unknown as SettingsOwner)
    let stop = () => {}, stopCatalog = () => {}, stopWindow = () => {}, paints = 0, catalogValue: unknown
    const read = () => source.read('settingsMachine', 'm0')
    const measure = (name: string, action: () => void) => measureWork(async () => {
      insideReader(name, action)
      await Promise.resolve()
    })
    try {
      // Explicitly requested rows install together, outside the update guard.
      stop = autorun(() => { read(); paints++ })
      stopCatalog = autorun(() => { catalogValue = source.read('settingsCatalog', 'catalog') })
      stopWindow = autorun(() => { source.read('settingsWindow', 'window') })
      await Promise.resolve()
      const catalog = catalogValue
      ids.mockClear(); row.mockClear(); paints = 0
      const changed = await measure('settings changed machine', () => {
        machines.set('m0', { id: 'm0', name: 'Renamed' })
        lists.get('machines')!({ ids: new Set(['m0']), order: false })
      })
      expect(row.mock.calls).toEqual([['machines', 'm0']])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(1)
      expect(read()).toMatchObject({ name: 'Renamed' })
      expect(catalogValue).toBe(catalog)
      row.mockClear(); paints = 0
      const unrelated = await measure('settings unrelated machine', () => {
        machines.set('m1', { id: 'm1', name: 'Other renamed' })
        lists.get('machines')!({ ids: new Set(['m1']), order: false })
      })
      expect(row.mock.calls).toEqual([])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(0)
      row.mockClear()
      const window = await measure('settings tab changed', () => { tab = 'updates'; local(new Set(['settingsTab'])) })
      expect(row).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled()
      expect(source.read('settingsWindow', 'window')).toEqual({ settingsTab: 'updates' })
      expect(paints).toBe(0)
      stop(); row.mockClear()
      const closed = await measure('settings subscriber closed', () => {
        machines.set('m0', { id: 'm0', name: 'After close' })
        lists.get('machines')!({ ids: new Set(['m0']), order: false })
      })
      expect(row.mock.calls).toEqual([])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(0)
      // Membership changes still publish the complete ordered catalog and
      // keyed removal; they are distinct from a single-row scalar update.
      machines.delete('m0')
      lists.get('machines')!({ ids: new Set(['m0']), order: true })
      await Promise.resolve()
      expect(read()).toBeUndefined()
      const next = source.read('settingsCatalog', 'catalog')
      expect(next).not.toBe(LOADING)
      expect(next).toMatchObject({ machines: [...machines.keys()] })
      return Object.fromEntries(Object.entries({ changed, unrelated, window, closed }).map(([name, value]) => [name, value.work]))
    } finally { stop(); stopCatalog(); stopWindow(); source.dispose(); await Promise.resolve(); vi.restoreAllMocks() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('settings source work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
    expect(second[action]?.[counter]).toBe(first[action]?.[counter])
})
