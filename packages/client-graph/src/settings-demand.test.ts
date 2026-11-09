import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { fixtureUi } from '@podium/client-core/test-support/ui'
import { asMachineId, type CheckoutWire, checkoutRepositoryId, checkoutRowId } from '@podium/model'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import type { SettingsRows } from './settings-schema'
import { type SettingsOwner, SettingsSource } from './settings-source'
import { LOADING } from './worklist/rollup'

/** A repository's settings id: its machine and root path. */
const repoId = (n: number) => checkoutRepositoryId({ machineId: 'm0', path: `/repo/${n}` })

function fixture(scale: 1 | 4) {
  // Machines are `machine` records, repositories `checkout` records (POD-6644),
  // read from the replica and followed through its addressed batches.
  const machines = new Map(
      Array.from({ length: 128 * scale }, (_, n) => [
        `m${n}`,
        {
          id: `m${n}`,
          name: `Machine ${n}`,
          loggedOutHarnesses: [],
        } as unknown as SettingsRows['settingsMachine'],
      ]),
    ),
    repos = new Map(
      Array.from({ length: 128 * scale }, (_, n) => [
        checkoutRowId(asMachineId('m0'), `/repo/${n}`),
        {
          machineId: 'm0',
          path: `/repo/${n}`,
          root: `/repo/${n}`,
          kind: 'repository',
        } as CheckoutWire,
      ]),
    )
  const lists = new Set<(batch: ReplicaAddressedBatch) => void>(),
    locals = new Set<() => void>()
  const ui = fixtureUi()
  ui.patch({ settingsTab: 'sessions' })
  const checkoutRows: readonly CheckoutWire[] = [...repos.values()]
  const ids = vi.fn((kind: string) =>
      kind === 'machines' ? [...machines.values()] : kind === 'checkouts' ? checkoutRows : [],
    ),
    row = vi.fn((kind: string, id: string) => (kind === 'machines' ? machines.get(id) : undefined)),
    local = vi.spyOn(ui, 'settingsTab', 'get'),
    off = vi.fn()
  const owner = {
    ui,
    readLocal: local,
    onLocals(_keys: readonly string[], changed: () => void) {
      locals.add(changed)
      return () => {
        locals.delete(changed)
        off('settingsTab')
      }
    },
    replica: {
      rows: ids,
      row,
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        lists.add(listener)
        return () => {
          lists.delete(listener)
          off('batch')
        }
      },
    },
  } as unknown as SettingsOwner
  const source = new SettingsSource(owner)
  function clear() {
    ids.mockClear()
    row.mockClear()
    local.mockClear()
  }
  /** A machine (`machines`) or a repository (`repos`) changed on the server. */
  function emit(name: 'machines' | 'repos', id: string) {
    const kind = name === 'machines' ? ('machines' as const) : ('checkouts' as const)
    for (const listener of [...lists]) listener({ type: 'update', rows: [{ kind, id }] })
  }
  async function measure(name: string, action: () => void) {
    clear()
    const result = await measureWork(async () => {
      insideReader(name, () => runInAction(action))
      await Promise.resolve()
    })
    return {
      work: result.work,
      ids: ids.mock.calls.length,
      rows: row.mock.calls.length,
      locals: local.mock.calls.length,
    }
  }
  return {
    source,
    owner,
    machines,
    repos,
    lists,
    locals,
    ids,
    row,
    local,
    off,
    emit,
    measure,
    clear,
    tab(next: string) {
      runInAction(() => {
        ui.settingsTab = next
      })
    },
  }
}

type Step = Awaited<ReturnType<ReturnType<typeof fixture>['measure']>>
/**
 * Every action's work is the same at 1x and 4x. The one exception is a named
 * repository's first read: repositories are derived from the checkout records
 * (POD-6644) in one pass over them, memoized by the replica's answer, so that
 * read grows with the checkouts (tens per machine), and still reads the list
 * once and no row.
 */
function flat(first: Record<string, Step>, second: typeof first) {
  for (const name of Object.keys(first)) {
    for (const counter of ['ids', 'rows', 'locals'] as const)
      expect(second[name]?.[counter], `${name}:${counter}`).toBe(first[name]?.[counter])
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const) {
      if (name === 'repository' && (counter === 'elements' || counter === 'visits')) continue
      expect(second[name]?.work[counter], `${name}:${counter}`).toBe(first[name]?.work[counter])
    }
  }
}

it('answers imperative settings questions directly without subscribing or warming catalogs at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    try {
      const machine = await f.measure('imperative named machine', () => {
        expect(f.source.read('settingsMachine', 'm0')).toMatchObject({ name: 'Machine 0' })
      })
      expect(machine).toMatchObject({ ids: 0, rows: 1, locals: 0 })
      const repository = await f.measure('imperative named repository', () => {
        expect(f.source.read('settingsRepository', repoId(0))).toMatchObject({ path: '/repo/0' })
      })
      // Repositories are derived from the checkout records: one list read.
      expect(repository).toMatchObject({ ids: 1, rows: 0, locals: 0 })
      const window = await f.measure('imperative settings tab', () => {
        expect(f.source.read('settingsWindow', 'window')).toBe(f.owner.ui)
        expect(f.owner.ui.settingsTab).toBe('sessions')
      })
      expect(window).toMatchObject({ ids: 0, rows: 0, locals: 1 })
      expect(f.lists.size).toBe(0)
      expect(f.locals.size).toBe(0)
      const idle = await f.measure('after imperative questions', () => {
        f.emit('machines', 'm0')
        f.emit('repos', 'r0')
        f.tab('updates')
      })
      expect(idle).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      samples.push({ scale, actions: { machine, repository, window, idle } })
    } finally {
      f.source.dispose()
      await Promise.resolve()
    }
  }
  console.info('[settings imperative first demand work1x4x]', JSON.stringify(samples))
  flat(samples[0]!.actions, samples[1]!.actions)
})

it('loads only the settings window from first demand and does no work while closed at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    let value: unknown,
      stop = () => {}
    try {
      expect(f.lists.size).toBe(0)
      expect(f.locals.size).toBe(0)
      const closedBefore = await f.measure('settings initially closed', () => {
        f.emit('machines', 'm0')
        f.tab('sessions')
      })
      expect(closedBefore).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      const first = await f.measure('first settings tab', () => {
        stop = autorun(() => {
          const window = f.source.read('settingsWindow', 'window')
          value = window && window !== LOADING ? { settingsTab: window.settingsTab } : window
        })
      })
      expect(value).toEqual({ settingsTab: 'sessions' })
      expect(first).toMatchObject({ ids: 0, rows: 0, locals: 1 })
      expect(f.lists.size).toBe(0)
      const repeat = await f.measure('repeat settings tab', () => {
        const current = autorun(() => {
          const window = f.source.read('settingsWindow', 'window')
          if (window && window !== LOADING) window.settingsTab
        })
        current()
      })
      expect(repeat).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      const changed = await f.measure('settings tab changed', () => f.tab('updates'))
      expect(value).toEqual({ settingsTab: 'updates' })
      expect(changed).toMatchObject({ ids: 0, rows: 0, locals: 1 })
      const unrelated = await f.measure('machine while tab visible', () => f.emit('machines', 'm1'))
      expect(unrelated).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      stop()
      expect(f.locals.size).toBe(0)
      const closed = await f.measure('settings tab closed', () => {
        f.tab('accounts')
        f.emit('repos', 'r0')
      })
      expect(closed).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      samples.push({ scale, actions: { closedBefore, first, repeat, changed, unrelated, closed } })
    } finally {
      stop()
      f.source.dispose()
      await Promise.resolve()
    }
  }
  console.info('[settings window first demand work1x4x]', JSON.stringify(samples))
  flat(samples[0]!.actions, samples[1]!.actions)
})

it('loads one declared machine or repository and follows only observed keys at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    let value: unknown,
      paints = 0,
      stop = () => {},
      repoStop = () => {}
    try {
      const first = await f.measure('first named settings machine', () => {
        stop = autorun(() => {
          value = f.source.read('settingsMachine', 'm0')
          paints++
        })
      })
      expect(value).toMatchObject({ name: 'Machine 0' })
      expect(first).toMatchObject({ ids: 0, rows: 1, locals: 0 })
      expect(f.row.mock.calls).toEqual([['machines', 'm0']])
      expect(f.lists.size).toBe(1)
      const repeat = await f.measure('repeat named settings machine', () => {
        const current = autorun(() => f.source.read('settingsMachine', 'm0'))
        current()
      })
      expect(repeat).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      const changed = await f.measure('observed settings machine changed', () => {
        f.machines.set('m0', { ...f.machines.get('m0')!, name: 'Renamed' })
        f.emit('machines', 'm0')
      })
      expect(changed).toMatchObject({ ids: 0, rows: 1, locals: 0 })
      expect(value).toMatchObject({ name: 'Renamed' })
      const beforeUnrelated = paints
      const unrelated = await f.measure('unobserved settings machine changed', () =>
        f.emit('machines', 'm1'),
      )
      expect(unrelated).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      expect(paints).toBe(beforeUnrelated)
      const removed = await f.measure('observed machine removed', () => {
        f.machines.delete('m0')
        f.emit('machines', 'm0')
      })
      expect(value).toBeUndefined()
      expect(removed).toMatchObject({ ids: 0, rows: 1, locals: 0 })
      const added = await f.measure('observed machine returned', () => {
        f.machines.set('m0', { id: 'm0', name: 'Returned' } as SettingsRows['settingsMachine'])
        f.emit('machines', 'm0')
      })
      expect(value).toMatchObject({ name: 'Returned' })
      expect(added).toMatchObject({ ids: 0, rows: 1, locals: 0 })
      stop()
      expect(f.lists.size).toBe(0)
      const closed = await f.measure('settings machine closed', () => f.emit('machines', 'm0'))
      expect(closed).toMatchObject({ ids: 0, rows: 0, locals: 0 })
      const repository = await f.measure('first named settings repository', () => {
        repoStop = autorun(() => {
          value = f.source.read('settingsRepository', repoId(0))
        })
      })
      expect(value).toMatchObject({ path: '/repo/0' })
      expect(repository).toMatchObject({ ids: 1, rows: 0, locals: 0 })
      expect(f.ids.mock.calls).toEqual([['checkouts']])
      expect(f.lists.size).toBe(1)
      repoStop()
      const control = await f.measure('whole settings bootstrap control', () => {
        for (const machine of f.owner.replica.rows('machines'))
          f.owner.replica.row!('machines', machine.id)
      })
      expect(control.rows).toBe(128 * scale)
      expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale)
      samples.push({
        scale,
        actions: { first, repeat, changed, unrelated, removed, added, closed, repository },
        control,
      })
    } finally {
      stop()
      repoStop()
      f.source.dispose()
      await Promise.resolve()
    }
  }
  console.info('[settings named first demand work1x4x]', JSON.stringify(samples))
  flat(samples[0]!.actions, samples[1]!.actions)
  expect(samples[1]!.control.rows).toBe(4 * samples[0]!.control.rows)
})

it('loads catalog ids separately from payloads and releases shared channels after the last reader', async () => {
  const f = fixture(1)
  let catalog: unknown,
    machine: unknown,
    catalogPaints = 0
  const stopCatalog = autorun(() => {
    catalog = f.source.read('settingsCatalog', 'catalog')
    catalogPaints++
  })
  await Promise.resolve()
  const repositories = () => [...f.repos.values()].map((repo) => checkoutRepositoryId(repo))
  expect(catalog).toEqual({ machines: [...f.machines.keys()], repositories: repositories() })
  expect(f.ids).toHaveBeenCalledTimes(2)
  expect(f.row).not.toHaveBeenCalled()
  const stopMachine = autorun(() => {
    machine = f.source.read('settingsMachine', 'm0')
  })
  try {
    await Promise.resolve()
    expect(machine).toMatchObject({ name: 'Machine 0' })
    const before = catalog,
      beforePaints = catalogPaints
    f.clear()
    f.machines.set('m0', { ...f.machines.get('m0')!, name: 'Renamed' })
    f.emit('machines', 'm0')
    await Promise.resolve()
    expect(machine).toMatchObject({ name: 'Renamed' })
    expect(catalog).toBe(before)
    expect(catalogPaints).toBe(beforePaints)
    expect(f.ids).not.toHaveBeenCalled()
    // One read to see the catalog did not move, one for the observed row.
    expect(f.row.mock.calls).toEqual([
      ['machines', 'm0'],
      ['machines', 'm0'],
    ])
    f.clear()
    f.machines.delete('m1')
    f.emit('machines', 'm1')
    await Promise.resolve()
    expect(catalog).toEqual({ machines: [...f.machines.keys()], repositories: repositories() })
    expect(f.row.mock.calls).toEqual([['machines', 'm1']])
    expect(f.ids).toHaveBeenCalledTimes(2)
    stopCatalog()
    expect(f.lists.size).toBe(1)
    f.clear()
    f.emit('machines', 'm2')
    await Promise.resolve()
    expect(f.ids).not.toHaveBeenCalled()
    expect(f.row).not.toHaveBeenCalled()
    stopMachine()
    expect(f.lists.size).toBe(0)
    expect(f.off.mock.calls).toEqual([['batch'], ['batch']])
    f.source.dispose()
    await Promise.resolve()
    expect(f.off).toHaveBeenCalledTimes(2)
  } finally {
    stopCatalog()
    stopMachine()
    f.source.dispose()
    await Promise.resolve()
  }
})

it('cancels undrained demand when closed and detaches disposal channels exactly once', async () => {
  const f = fixture(1)
  const stops = [
    autorun(() => f.source.read('settingsMachine', 'm0')),
    autorun(() => f.source.read('settingsCatalog', 'catalog')),
    autorun(() => f.source.read('settingsWindow', 'window')),
  ]
  for (const stop of stops) stop()
  await Promise.resolve()
  expect(f.ids).not.toHaveBeenCalled()
  expect(f.row).not.toHaveBeenCalled()
  expect(f.local).not.toHaveBeenCalled()
  expect(f.lists.size).toBe(0)
  expect(f.locals.size).toBe(0)
  expect(f.off).toHaveBeenCalledTimes(2)
  const stop = autorun(() => f.source.read('settingsMachine', 'm0'))
  f.source.dispose()
  f.source.dispose()
  await Promise.resolve()
  expect(f.source.read('settingsMachine', 'm0')).toBe(LOADING)
  expect(f.row).not.toHaveBeenCalled()
  expect(f.off).toHaveBeenCalledTimes(3)
  expect(f.lists.size).toBe(0)
  stop()
})
