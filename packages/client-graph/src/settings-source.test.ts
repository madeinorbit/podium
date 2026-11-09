import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { fixtureUi } from '@podium/client-core/test-support/ui'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { type SettingsOwner, SettingsSource } from './settings-source'
import { LOADING } from './worklist/rollup'

it('reads only changed settings keys and no list membership on scalar updates at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const machines = new Map(
      Array.from({ length: 128 * scale }, (_, n) => [
        `m${n}`,
        { id: `m${n}`, name: `Machine ${n}` },
      ]),
    )
    // Machine records and checkout records, followed through the replica's
    // addressed batches (POD-6644).
    const checkouts = Array.from({ length: 128 * scale }, (_, n) => ({
      machineId: 'm0',
      path: `/repo/${n}`,
      root: `/repo/${n}`,
      kind: 'repository',
    }))
    const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
    const ui = fixtureUi()
    ui.patch({ settingsTab: 'sessions' })
    const ids = vi.fn((kind: string) =>
        kind === 'machines' ? [...machines.values()] : kind === 'checkouts' ? checkouts : [],
      ),
      row = vi.fn((kind: string, id: string) =>
        kind === 'machines' ? machines.get(id) : undefined,
      )
    const emit = (id: string) => {
      for (const listener of [...listeners])
        listener({ type: 'update', rows: [{ kind: 'machines', id }] })
    }
    const source = new SettingsSource({
      ui,
      replica: {
        rows: ids,
        row,
        subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    } as unknown as SettingsOwner)
    let stop = () => {},
      stopCatalog = () => {},
      stopWindow = () => {},
      paints = 0,
      catalogValue: unknown
    const read = () => source.read('settingsMachine', 'm0')
    const measure = (name: string, action: () => void) =>
      measureWork(async () => {
        insideReader(name, action)
        await Promise.resolve()
      })
    try {
      // Explicitly requested rows install together, outside the update guard.
      stop = autorun(() => {
        read()
        paints++
      })
      stopCatalog = autorun(() => {
        catalogValue = source.read('settingsCatalog', 'catalog')
      })
      stopWindow = autorun(() => {
        const window = source.read('settingsWindow', 'window')
        if (window && window !== LOADING) window.settingsTab
      })
      await Promise.resolve()
      const catalog = catalogValue
      ids.mockClear()
      row.mockClear()
      paints = 0
      const changed = await measure('settings changed machine', () => {
        machines.set('m0', { id: 'm0', name: 'Renamed' })
        emit('m0')
      })
      // One read to see the catalog did not move, one for the observed row.
      expect(row.mock.calls).toEqual([
        ['machines', 'm0'],
        ['machines', 'm0'],
      ])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(1)
      expect(read()).toMatchObject({ name: 'Renamed' })
      expect(catalogValue).toBe(catalog)
      row.mockClear()
      paints = 0
      const unrelated = await measure('settings unrelated machine', () => {
        machines.set('m1', { id: 'm1', name: 'Other renamed' })
        emit('m1')
      })
      // The observed catalog checks that m1 did not appear or leave.
      expect(row.mock.calls).toEqual([['machines', 'm1']])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(0)
      row.mockClear()
      const window = await measure('settings tab changed', () => {
        ui.patch({ settingsTab: 'updates' })
      })
      expect(row).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled()
      expect(source.read('settingsWindow', 'window')).toBe(ui)
      expect(ui.settingsTab).toBe('updates')
      expect(paints).toBe(0)
      stop()
      row.mockClear()
      const closed = await measure('settings subscriber closed', () => {
        machines.set('m0', { id: 'm0', name: 'After close' })
        emit('m0')
      })
      expect(row.mock.calls).toEqual([['machines', 'm0']])
      expect(ids).not.toHaveBeenCalled()
      expect(paints).toBe(0)
      // Membership changes still publish the complete ordered catalog and
      // keyed removal; they are distinct from a single-row scalar update.
      machines.delete('m0')
      emit('m0')
      await Promise.resolve()
      expect(read()).toBeUndefined()
      const next = source.read('settingsCatalog', 'catalog')
      expect(next).not.toBe(LOADING)
      expect(next).toMatchObject({ machines: [...machines.keys()] })
      return Object.fromEntries(
        Object.entries({ changed, unrelated, window, closed }).map(([name, value]) => [
          name,
          value.work,
        ]),
      )
    } finally {
      stop()
      stopCatalog()
      stopWindow()
      source.dispose()
      await Promise.resolve()
      vi.restoreAllMocks()
    }
  }
  const first = await measured(1),
    second = await measured(4)
  console.info('settings source work1x4x', JSON.stringify({ first, second }))
  for (const action of Object.keys(first))
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action]?.[counter]).toBe(first[action]?.[counter])
})
