import type { ClientRuntime, KeyedListChange } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { attachHeaderSource } from './header-source'
import { MobxPool } from './pool'

it('reads only changed header keys between 1x/4x and preserves removal and rescope', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const machines = new Map(Array.from({ length: 128 * scale }, (_, index) =>
      [`m${index}`, { id: `m${index}`, name: `Machine ${index}` } as HeaderRows['machine']])),
      repos = new Map(Array.from({ length: 128 * scale }, (_, index) =>
        [`r${index}`, { path: `/repo/${index}`, worktrees: [] } as HeaderRows['repository']])),
      orders = new Map(Array.from({ length: 128 * scale }, (_, index) =>
        [`o${index}`, { id: `o${index}`, repoId: 'repo', humanState: 'needs_you' } as HeaderRows['shipOrder']]))
    const lists = new Map<string, (change: KeyedListChange) => void>()
    let batch: (batch: ReplicaAddressedBatch) => void = () => {}
    const ids = vi.fn((name: string) => [...(name === 'machines' ? machines : repos).keys()]),
      row = vi.fn((name: string, id: string) => name === 'machines' ? machines.get(id) : repos.get(id)),
      replicaRows = vi.fn(() => [...orders.values()]),
      replicaRow = vi.fn((_kind: string, id: string) => orders.get(id))
    const runtime = {
      listIds: ids, listRow: row,
      onList(name: string, changed: (change: KeyedListChange) => void) {
        lists.set(name, changed)
        return () => { lists.delete(name) }
      },
      readLocal: (key: string) => ({ view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0 })[key as 'view'],
      onLocals: () => () => {},
      hostMetrics: { getSnapshot: () => [], subscribe: () => () => {} },
      hub: { connectionHealth: () => ({ status: 'ok' }), onConnectionHealth: () => () => {} },
      replica: {
        rows: replicaRows, row: replicaRow,
        subscribeAddressedBatch(next: typeof batch) { batch = next; return () => { batch = () => {} } },
      },
      access: { trpc: {
        quota: { summary: { query: async () => [] } },
        settings: { get: { query: async () => ({}) } },
      } },
    } as unknown as ClientRuntime
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const stop = attachHeaderSource(pool, runtime)
    const measure = (name: string, action: () => void) =>
      measureWork(async () => {
        insideReader(name, action)
        await Promise.resolve()
      }, { pool })
    try {
      // A whole-scope installation is ingest, outside the scalar update guard.
      await Promise.resolve()
      expect(pool.header.shippingCounts('repo')).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale })
      ids.mockClear(); row.mockClear(); replicaRows.mockClear(); replicaRow.mockClear()
      const machine = await measure('one header machine', () => {
        machines.set('m0', { ...machines.get('m0')!, name: 'Renamed' })
        lists.get('machines')!({ ids: new Set(['m0']), order: false })
      })
      expect(row.mock.calls).toEqual([['machines', 'm0']])
      expect(ids).not.toHaveBeenCalled()
      row.mockClear()
      const repository = await measure('one header repository', () => {
        repos.set('r0', { ...repos.get('r0')!, branch: 'changed' })
        lists.get('repos')!({ ids: new Set(['r0']), order: false })
      })
      expect(row.mock.calls).toEqual([['repos', 'r0']])
      expect(ids).not.toHaveBeenCalled()
      const shipping = await measure('one header shipping order', () => {
        orders.set('o0', { ...orders.get('o0')!, humanState: 'waiting' })
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o0' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'o0']])
      expect(replicaRows).not.toHaveBeenCalled()
      expect(pool.header.shippingCounts('repo')).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale - 1 })
      replicaRow.mockClear()
      const unrelated = await measure('unrelated replica header update', () =>
        batch({ type: 'update', rows: [{ kind: 'issues', id: 'unrelated' }] }))
      expect(replicaRow).not.toHaveBeenCalled()
      expect(replicaRows).not.toHaveBeenCalled()
      const removed = await measure('remove one shipping order', () => {
        orders.delete('o0')
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o0' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'o0']])
      expect(replicaRows).not.toHaveBeenCalled()
      expect(pool.header.shippingCounts('repo')).toEqual({ unfinishedCount: 128 * scale - 1, decisionCount: 128 * scale - 1 })
      replicaRow.mockClear()
      const added = await measure('add one shipping order', () => {
        orders.set('added', { ...orders.get('o1')!, id: 'added' } as HeaderRows['shipOrder'])
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'added' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'added']])
      expect(replicaRows).not.toHaveBeenCalled()
      expect(pool.header.shippingCounts('repo')).toEqual({ unfinishedCount: 128 * scale, decisionCount: 128 * scale })
      // Explicit catalog order publications and replica replacements retain
      // their semantics, and must remove prior keyed deltas as well.
      machines.delete('m0')
      lists.get('machines')!({ ids: new Set(['m0']), order: true })
      expect(pool.header.get('machine', 'm0')).toBeUndefined()
      expect(pool.header.orders.get('machine')).toEqual([...machines.keys()])
      orders.clear()
      batch({ type: 'replace', reason: 'rescope' })
      expect(pool.header.tables.shipOrder.size).toBe(0)
      expect(pool.header.shippingCounts('repo')).toEqual({ unfinishedCount: 0, decisionCount: 0 })
      const control = await measure('whole machine catalog control', () => { new Set(runtime.listIds('machines')) })
      expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale - 1)
      stop()
      row.mockClear(); replicaRow.mockClear(); replicaRows.mockClear()
      const closed = await measure('header source detached', () => {
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o1' }] })
      })
      expect(row).not.toHaveBeenCalled()
      expect(replicaRow).not.toHaveBeenCalled()
      expect(replicaRows).not.toHaveBeenCalled()
      samples.push({ scale, machine: machine.work, repository: repository.work, shipping: shipping.work, unrelated: unrelated.work, removed: removed.work, added: added.work, closed: closed.work, control: control.work })
    } finally { stop(); pool.dispose() }
  }
  console.info('[header source work1x4x]', JSON.stringify(samples))
  for (const name of ['machine', 'repository', 'shipping', 'unrelated', 'removed', 'added', 'closed'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![name][counter], `${name}:${counter}`).toBe(samples[0]![name][counter])
  expect(samples[1]!.control.elements).toBeGreaterThan(samples[0]!.control.elements)
})
