import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import type { MachineId } from '@podium/model/browser'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'

function fixture(scale: 1 | 4) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const metrics = Array.from(
    { length: 128 * scale },
    (_, index) =>
      ({
        machineId: `m${index}` as MachineId,
        hostname: `Host ${index}`,
        sampledAt: '2026-10-05T07:00:00Z',
      }) as HeaderRows['hostMetric'],
  )
  const repos = Array.from(
    { length: 128 * scale },
    (_, index) =>
      ({
        kind: 'repository',
        path: `/repo/${index}`,
        repoId: `repo-${index}` as NonNullable<HeaderRows['repository']['repoId']>,
        worktrees: [],
      }) as HeaderRows['repository'],
  )
  headerEntities(pool).apply([
    ...metrics.map((value, index) => ({ kind: 'hostMetric' as const, id: `m${index}`, value })),
    ...repos.map((value, index) => ({ kind: 'repository' as const, id: `r${index}`, value })),
  ])
  const measure = (name: string, action: () => void) =>
    measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
  return { pool, metrics, repos, measure }
}

it('reads only the requested or first metric at 1x/4x and releases closed panel demand', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    const selected = observable.box<MachineId | undefined>(undefined)
    let value: HeaderRows['hostMetric'] | undefined,
      paints = 0,
      stop = () => {}
    const all = vi.spyOn(headerView(f.pool), 'ids')
    try {
      // No order is installed yet: the storage iterator's first key is enough.
      const first = await f.measure('first panel metric', () => {
        stop = autorun(() => {
          value = headerView(f.pool).panelMetric(selected.get())
          paints++
        })
      })
      expect(value).toBe(f.metrics[0])
      expect(first.work.rows).toBe(1)
      const repeated = await f.measure('repeat first panel metric', () => {
        expect(headerView(f.pool).panelMetric(undefined)).toBe(f.metrics[0])
      })
      expect(repeated.work.rows).toBe(1)
      const before = paints
      const unrelated = await f.measure('other metric sample', () => {
        headerEntities(f.pool).apply([
          { kind: 'hostMetric', id: 'm2', value: { ...f.metrics[2]!, hostname: 'Other' } },
        ])
      })
      expect(paints).toBe(before)
      expect(unrelated.work.rows).toBe(0)
      const updated = { ...f.metrics[0]!, hostname: 'Changed' }
      const changed = await f.measure('first metric sample', () => {
        headerEntities(f.pool).apply([{ kind: 'hostMetric', id: 'm0', value: updated }])
      })
      expect(value).toBe(updated)
      expect(changed.work.rows).toBe(1)
      const addressed = await f.measure('choose one panel metric', () =>
        selected.set('m1' as MachineId),
      )
      expect(value).toBe(f.metrics[1])
      expect(addressed.work.rows).toBe(1)
      const missing = await f.measure('missing panel metric', () =>
        selected.set('missing' as MachineId),
      )
      expect(value).toBeUndefined()
      expect(missing.work.rows).toBe(1)
      stop()
      const closed = await f.measure('closed panel metric', () => {
        headerEntities(f.pool).apply([
          { kind: 'hostMetric', id: 'm1', value: { ...f.metrics[1]!, hostname: 'Closed' } },
        ])
      })
      expect(closed.work.rows).toBe(0)
      expect(all).not.toHaveBeenCalled()
      const control = await f.measure('whole metric ID control', () => {
        const id = headerView(f.pool).ids('hostMetric')[0]
        if (id) headerView(f.pool).row('hostMetric', id)
      })
      expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale)
      samples.push({
        scale,
        actions: { first, repeated, unrelated, changed, addressed, missing, closed },
        control,
      })
    } finally {
      stop()
      all.mockRestore()
      f.pool.dispose()
    }
  }
  console.info('[header panel metric work1x4x]', JSON.stringify(samples))
  for (const name of [
    'first',
    'repeated',
    'unrelated',
    'changed',
    'addressed',
    'missing',
    'closed',
  ] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[name].work[counter], `${name}:${counter}`).toBe(
        samples[0]!.actions[name].work[counter],
      )
  expect(samples[1]!.control.work.elements).toBeGreaterThan(samples[0]!.control.work.elements)
})

it('preserves source-order first metric, empty order, removal and explicit-target semantics', () => {
  const f = fixture(1)
  try {
    headerEntities(f.pool).order('hostMetric', ['m2', 'm1', 'm0'])
    expect(headerView(f.pool).panelMetric(undefined)).toBe(f.metrics[2])
    expect(headerView(f.pool).panelMetric('m1' as MachineId)).toBe(f.metrics[1])
    headerEntities(f.pool).apply([{ kind: 'hostMetric', id: 'm2', value: undefined }])
    // An explicitly stale order has the same absent-first answer as the old IDs reader.
    expect(headerView(f.pool).panelMetric(undefined)).toBeUndefined()
    headerEntities(f.pool).order('hostMetric', ['m1', 'm0'])
    expect(headerView(f.pool).panelMetric(undefined)).toBe(f.metrics[1])
    headerEntities(f.pool).order('hostMetric', [])
    expect(headerView(f.pool).panelMetric(undefined)).toBe(f.metrics[0])
    headerEntities(f.pool).clear()
    expect(headerView(f.pool).panelMetric(undefined)).toBeUndefined()
  } finally {
    f.pool.dispose()
  }
})

it('answers repository membership count without reading any row at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    let count = 0,
      paints = 0,
      stop = () => {}
    try {
      const first = await f.measure('repository count', () => {
        stop = autorun(() => {
          count = headerView(f.pool).repositoryCount()
          paints++
        })
      })
      expect(count).toBe(128 * scale)
      const before = paints
      const scalar = await f.measure('repository branch update', () => {
        headerEntities(f.pool).apply([
          { kind: 'repository', id: 'r0', value: { ...f.repos[0]!, branch: 'changed' } },
        ])
      })
      expect(paints).toBe(before)
      const removed = await f.measure('repository removal count', () => {
        headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0', value: undefined }])
      })
      expect(count).toBe(128 * scale - 1)
      const restored = await f.measure('repository restored count', () => {
        headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0', value: f.repos[0] }])
      })
      expect(count).toBe(128 * scale)
      stop()
      const closed = await f.measure('closed repository count', () => {
        headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0', value: undefined }])
      })
      const control = await f.measure('whole repository count control', () => {
        const rows = headerView(f.pool).ids('repository').map((id) => omitGone(f.pool.row('repository', id)))
        expect(rows.length).toBe(128 * scale - 1)
      })
      expect(control.work.rows).toBe(128 * scale - 1)
      samples.push({ scale, actions: { first, scalar, removed, restored, closed }, control })
    } finally {
      stop()
      f.pool.dispose()
    }
  }
  console.info('[header repository count work1x4x]', JSON.stringify(samples))
  for (const name of ['first', 'scalar', 'removed', 'restored', 'closed'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[name].work[counter], `${name}:${counter}`).toBe(
        samples[0]!.actions[name].work[counter],
      )
  for (const action of Object.values(samples[0]!.actions)) expect(action.work.rows).toBe(0)
  expect(samples[1]!.control.work.rows).toBeGreaterThan(samples[0]!.control.work.rows ?? 0)
})

it('shares worktree totals across window reads and ignores scan metadata at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    const scan = { ...f.repos[0]!, worktrees: [{ path: '/repo/0/a' }, { path: '/repo/0/b' }] }
    headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0', value: scan }])
    let count = 0, paints = 0
    const stop = autorun(() => { count = headerView(f.pool).worktreeCount(); paints++ })
    try {
      expect(count).toBe(2)
      const repeat = await f.measure('chrome repeats worktree total', () => {
        expect(headerView(f.pool).worktreeCount()).toBe(2)
      })
      const before = paints
      const metadata = await f.measure('scan branch changes', () => {
        headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0',
          value: { ...scan, branch: 'changed' } }])
      })
      expect(paints).toBe(before)
      expect(metadata.work.rows).toBe(1)
      headerEntities(f.pool).apply([{ kind: 'repository', id: 'r1',
        value: { ...f.repos[1]!, worktrees: [{ path: '/repo/1/a' }] } }])
      expect(count).toBe(3)
      headerEntities(f.pool).apply([{ kind: 'repository', id: 'r0', value: undefined }])
      expect(count).toBe(1)
      headerEntities(f.pool).order('repository', ['missing', 'r1'])
      expect(count).toBe(1)
      stop()
      const released = await f.measure('closed chrome worktree total', () => {
        headerEntities(f.pool).apply([{ kind: 'repository', id: 'r1', value: f.repos[1] }])
      })
      expect(released.work.rows).toBe(0)
      expect(headerView(f.pool).worktreeCount()).toBe(0)
      samples.push({ repeat, metadata, released })
    } finally { stop(); f.pool.dispose() }
  }
  for (const action of ['repeat', 'metadata', 'released'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![action].work[counter], `${action}:${counter}`).toBe(samples[0]![action].work[counter])
})
