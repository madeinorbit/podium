/**
 * ONE MACHINE'S UPDATE WAKES ONLY THAT MACHINE'S ROW (POD-5644, POD-6644).
 *
 * The machine panel, HostMemoryView and the phone's Pulse read one model per
 * machine: the fleet list is the ids, and each row observes its own model.
 * A rename (a record change) and an online change (a LiveStore condition) of
 * one machine must wake that row alone, never the list or another row.
 */
import { autorun } from 'mobx'
import { beforeAll, expect, it } from 'vitest'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { liveFixture, seedFixtureMachines } from './live-fixture'
import { here } from './lookup'
import { loadSyncedModels } from './models'
import { MobxPool } from './pool'

beforeAll(() => loadSyncedModels())

it.each([1, 4] as const)('wakes one row per machine change at %sx', (scale) => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const machines = Array.from({ length: 8 * scale }, (_, at) => ({
    id: `m${at}`,
    name: `Machine ${at}`,
    hostname: `m${at}`,
    online: true,
    lastSeenAt: '2026-11-09T00:00:00Z',
  }))
  const records = seedFixtureMachines(pool, machines as never)
  headerEntities(pool).apply(records as never)
  headerEntities(pool).order('machine', machines.map((machine) => machine.id))
  let listRuns = 0
  const rowRuns = new Map<string, number>()
  const stops = [
    autorun(() => {
      headerView(pool).machines().map((machine) => machine.id)
      listRuns++
    }),
    ...machines.map((machine) =>
      autorun(() => {
        const model = here(pool.model('machine', machine.id)) as
          | { name: string; online: boolean }
          | undefined
        void model?.name
        void model?.online
        rowRuns.set(machine.id, (rowRuns.get(machine.id) ?? 0) + 1)
      }),
    ),
  ]
  try {
    const baseline = new Map(rowRuns)
    const list = listRuns
    const woken = () =>
      [...rowRuns].filter(([id, runs]) => runs !== baseline.get(id)).map(([id]) => id)

    // A rename: the machine record changes.
    headerEntities(pool).apply([
      { kind: 'machine', id: 'm1', value: { ...records[1]!.value, name: 'Renamed' } },
    ] as never)
    expect(woken()).toEqual(['m1'])
    expect(listRuns).toBe(list)

    // Going offline: the live condition changes.
    for (const [id, runs] of rowRuns) baseline.set(id, runs)
    liveFixture(pool).online('m2', false)
    expect(woken()).toEqual(['m2'])
    expect(listRuns).toBe(list)
    expect((here(pool.model('machine', 'm2')) as { online: boolean } | undefined)?.online).toBe(false)
  } finally {
    for (const stop of stops) stop()
    pool.dispose()
  }
})
