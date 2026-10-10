import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { createHeaderPollingService, type ClientRuntime, type KeyedListChange } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { autorun, observe } from 'mobx'
import type { HeaderRows } from './header-schema'
import { attachHeaderSource } from './header-source'
import { MobxPool } from './pool'
import { HeaderSessions } from './header-sessions'

it('reads only changed header keys between 1x/4x and preserves removal and rescope', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const machines = new Map(
        Array.from({ length: 128 * scale }, (_, index) => [
          `m${index}`,
          { id: `m${index}`, name: `Machine ${index}` } as HeaderRows['machine'],
        ]),
      ),
      repos = new Map(
        Array.from({ length: 128 * scale }, (_, index) => [
          `r${index}`,
          { path: `/repo/${index}`, kind: 'repository', worktrees: [] } as HeaderRows['repository'],
        ]),
      ),
      orders = new Map(
        Array.from({ length: 128 * scale }, (_, index) => [
          `o${index}`,
          { id: `o${index}`, repoId: 'repo', humanState: 'needs_you' } as HeaderRows['shipOrder'],
        ]),
      )
    const lists = new Map<string, (change: KeyedListChange) => void>()
    let batch: (batch: ReplicaAddressedBatch) => void = () => {}
    const ids = vi.fn((name: string) => [...(name === 'machines' ? machines : repos).keys()]),
      row = vi.fn((name: string, id: string) =>
        name === 'machines' ? machines.get(id) : repos.get(id),
      ),
      replicaRows = vi.fn(() => [...orders.values()]),
      replicaRow = vi.fn((_kind: string, id: string) => orders.get(id))
    const runtime = {
      listIds: ids,
      listRow: row,
      onList(name: string, changed: (change: KeyedListChange) => void) {
        lists.set(name, changed)
        return () => {
          lists.delete(name)
        }
      },
      readLocal: (key: string) =>
        ({ view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0 })[key as 'view'],
      onLocals: () => () => {},
      hostMetrics: { getSnapshot: () => [], subscribe: () => () => {} },
      hub: { connectionHealth: () => ({ status: 'ok' }), onConnectionHealth: () => () => {} },
      replica: {
        rows: replicaRows,
        row: replicaRow,
        subscribeAddressedBatch(next: typeof batch) {
          batch = next
          return () => {
            batch = () => {}
          }
        },
      },
      headerInputs: { read: () => undefined, onInput: () => () => {}, retain: () => () => {} },
      access: {
        trpc: {
          quota: { summary: { query: async () => [] } },
          settings: { get: { query: async () => ({}) } },
        },
      },
    } as unknown as ClientRuntime
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const stop = attachHeaderSource(pool, runtime)
    const measure = (name: string, action: () => void) =>
      measureWork(
        async () => {
          insideReader(name, action)
          await Promise.resolve()
        },
        { pool },
      )
    try {
      // A whole-scope installation is ingest, outside the scalar update guard.
      await Promise.resolve()
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale,
      })
      ids.mockClear()
      row.mockClear()
      replicaRows.mockClear()
      replicaRow.mockClear()
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
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale - 1,
      })
      replicaRow.mockClear()
      const unrelated = await measure('unrelated replica header update', () =>
        batch({ type: 'update', rows: [{ kind: 'issueProjections', id: 'unrelated' }] }),
      )
      expect(replicaRow).not.toHaveBeenCalled()
      expect(replicaRows).not.toHaveBeenCalled()
      const removed = await measure('remove one shipping order', () => {
        orders.delete('o0')
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o0' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'o0']])
      expect(replicaRows).not.toHaveBeenCalled()
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale - 1,
        decisionCount: 128 * scale - 1,
      })
      replicaRow.mockClear()
      const added = await measure('add one shipping order', () => {
        orders.set('added', { ...orders.get('o1')!, id: 'added' } as HeaderRows['shipOrder'])
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'added' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'added']])
      expect(replicaRows).not.toHaveBeenCalled()
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale,
      })
      // Explicit catalog order publications and replica replacements retain
      // their semantics, and must remove prior keyed deltas as well.
      machines.delete('m0')
      lists.get('machines')!({ ids: new Set(['m0']), order: true })
      expect(headerEntities(pool).get('machine', 'm0')).toBeUndefined()
      expect(headerEntities(pool).orders.get('machine')).toEqual([...machines.keys()])
      orders.clear()
      batch({ type: 'replace', reason: 'rescope' })
      expect(headerEntities(pool).tables.shipOrder.size).toBe(0)
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({ unfinishedCount: 0, decisionCount: 0 })
      const control = await measure('whole machine catalog control', () => {
        new Set(runtime.listIds('machines'))
      })
      expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale - 1)
      stop()
      row.mockClear()
      replicaRow.mockClear()
      replicaRows.mockClear()
      const closed = await measure('header source detached', () => {
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o1' }] })
      })
      expect(row).not.toHaveBeenCalled()
      expect(replicaRow).not.toHaveBeenCalled()
      expect(replicaRows).not.toHaveBeenCalled()
      samples.push({
        scale,
        machine: machine.work,
        repository: repository.work,
        shipping: shipping.work,
        unrelated: unrelated.work,
        removed: removed.work,
        added: added.work,
        closed: closed.work,
        control: control.work,
      })
    } finally {
      stop()
      pool.dispose()
    }
  }
  console.info('[header source work1x4x]', JSON.stringify(samples))
  for (const name of [
    'machine',
    'repository',
    'shipping',
    'unrelated',
    'removed',
    'added',
    'closed',
  ] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![name][counter], `${name}:${counter}`).toBe(samples[0]![name][counter])
  expect(samples[1]!.control.elements).toBeGreaterThan(samples[0]!.control.elements)
})

function pollingFixture() {
  const quota = vi.fn(async (): Promise<HeaderRows['quota'][]> => [])
  const lifecycle = vi.fn(async () => ({}) as HeaderRows['lifecycle'])
  const reading: HeaderRows['history'] = {
    sampledAt: '2026-10-05T00:00:00Z',
    buckets: Array.from({ length: 24 }, () => ({ start: '2026-10-05T00:00:00Z', count: 0 })),
    bucketMs: 60_000,
    peak: 0,
  }
  const history = vi.fn(async () => reading)
  const runtime = {
    listIds: () => [],
    listRow: () => undefined,
    onList: () => () => {},
    readLocal: () => undefined,
    onLocals: () => () => {},
    hostMetrics: { getSnapshot: () => [], subscribe: () => () => {} },
    hub: { connectionHealth: () => ({ status: 'ok' }), onConnectionHealth: () => () => {} },
    replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
    access: {
      trpc: {
        quota: { summary: { query: quota } },
        settings: { get: { query: lifecycle } },
        sessions: { concurrencyHistory: { query: history } },
      },
    },
  } as unknown as ClientRuntime
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const reportError = vi.fn()
  const polling = createHeaderPollingService({ api: runtime.access.trpc, replica: runtime.replica, reportError })
  polling.inputs.retain()
  Object.assign(runtime, { headerInputs: polling.inputs })
  return {
    pool, quota, history, lifecycle, reading, polling, reportError, runtime,
    start: () => {
      const detach = attachHeaderSource(pool, runtime)
      polling.start()
      return () => { detach(); polling.destroy() }
    },
  }
}

it('releases header sessions with the attached history source when the last header reader leaves', async () => {
  vi.useFakeTimers()
  const f = pollingFixture(),
    dispose = vi.spyOn(HeaderSessions.prototype, 'dispose'),
    count = vi.spyOn(headerView(f.pool), 'workingCount')
  const stamp = new Date(0).toISOString()
  const row = { sessionId: 'seat', agentKind: 'codex', cwd: '/header', status: 'live',
    lastActiveAt: stamp, agentState: { phase: 'idle', since: stamp } }
  f.pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'seat', value: row as never }] })
  const off = f.start()
  let stop = () => {}
  try {
    await Promise.resolve()
    expect(count).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    stop = autorun(() => { headerView(f.pool).workingCount() })
    const initialHistory = f.history.mock.calls.length
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat', value: {
      ...row, agentState: { phase: 'working', since: stamp },
    } as never }] })
    expect(headerView(f.pool).workingCount()).toBe(1)
    expect(f.history).toHaveBeenCalledTimes(initialHistory)
    await Promise.resolve()
    stop()
    expect(dispose).toHaveBeenCalledTimes(1)
    const afterClose = f.history.mock.calls.length
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat', value: row as never }] })
    expect(f.history).toHaveBeenCalledTimes(afterClose)
    expect(dispose).toHaveBeenCalledTimes(1)
    stop = autorun(() => { expect(headerView(f.pool).workingCount()).toBe(0) })
    stop()
    expect(dispose).toHaveBeenCalledTimes(2)
  } finally {
    stop(); off(); f.pool.dispose()
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('consumes cached keyed samples without starting timers or touching the network', async () => {
  vi.useFakeTimers()
  const f = pollingFixture()
  f.polling.start()
  await Promise.resolve()
  Object.defineProperty(f.runtime, 'access', { get() { throw new Error('pool reached transport') } })
  const timer = vi.spyOn(globalThis, 'setInterval')
  const detach = attachHeaderSource(f.pool, f.runtime)
  try {
    expect(headerEntities(f.pool).received.history).toBe(f.reading)
    expect(headerEntities(f.pool).received.quotas).toEqual([])
    expect(timer).not.toHaveBeenCalled()
    expect(f.quota).toHaveBeenCalledTimes(1)
    detach()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.quota).toHaveBeenCalledTimes(2)
    expect(headerEntities(f.pool).received.quotas).toEqual([])
  } finally {
    detach()
    f.polling.destroy()
    f.pool.dispose()
  }
})

it('counts quota failures, logs once, keeps the last reading, and recovers on the next poll', async () => {
  vi.useFakeTimers()
  const f = pollingFixture()
  const before = { machineId: 'before' } as HeaderRows['quota']
  const after = { machineId: 'after' } as HeaderRows['quota']
  const error = new Error('quota unavailable')
  f.quota
    .mockResolvedValueOnce([before])
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockResolvedValue([after])
  const stop = f.start()
  try {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(headerEntities(f.pool).received.quotas).toEqual([before])
    expect(headerEntities(f.pool).get('quota', 'before')).toBe(before)
    expect(f.polling.diagnostics.counts.quota).toBe(2)
    expect(f.reportError).toHaveBeenCalledTimes(1)
    expect(f.reportError).toHaveBeenCalledWith('quota', error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(headerEntities(f.pool).received.quotas).toEqual([after])
    expect(headerEntities(f.pool).get('quota', 'before')).toBeUndefined()
    expect(headerEntities(f.pool).get('quota', 'after')).toBe(after)
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('removes partially applied quota rows when a later poll replaces them', async () => {
  vi.useFakeTimers()
  const f = pollingFixture()
  const rows = ['a', 'b'].map((machineId) => ({ machineId }) as HeaderRows['quota'])
  const after = { machineId: 'c' } as HeaderRows['quota']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  f.quota.mockResolvedValueOnce([]).mockResolvedValueOnce(rows).mockResolvedValue([after])
  const stop = f.start()
  let fail = true
  const off = observe(headerEntities(f.pool).tables.quota, (change) => {
    if (change.name === 'b' && fail) {
      fail = false
      throw new Error('header apply failure')
    }
  })
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.pool.diagnostics.counts['header:quota']).toBe(1)
    expect([...headerEntities(f.pool).tables.quota.keys()]).toEqual(['a', 'b'])
    expect(headerEntities(f.pool).received.quotas).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect([...headerEntities(f.pool).tables.quota.keys()]).toEqual(['c'])
    expect(headerEntities(f.pool).orders.get('quota')).toEqual(['c'])
    expect(headerEntities(f.pool).received.quotas).toEqual([after])
  } finally {
    off()
    stop()
    f.pool.dispose()
  }
})

it('counts and retries history and lifecycle failures independently', async () => {
  vi.useFakeTimers()
  const f = pollingFixture()
  const historyError = new Error('history unavailable')
  const lifecycleError = new Error('settings unavailable')
  f.history
    .mockRejectedValueOnce(historyError)
    .mockRejectedValueOnce(historyError)
    .mockResolvedValue(f.reading)
  f.lifecycle.mockRejectedValueOnce(lifecycleError)
  const stop = f.start()
  try {
    await Promise.resolve()
    expect(f.polling.diagnostics.counts).toEqual({ history: 1, lifecycle: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(headerEntities(f.pool).received.lifecycle).toEqual({})
    expect(f.lifecycle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(headerEntities(f.pool).received.history).toBe(f.reading)
    expect(f.polling.diagnostics.counts).toEqual({ history: 2, lifecycle: 1 })
    expect(f.lifecycle).toHaveBeenCalledTimes(2)
    expect(f.reportError.mock.calls).toEqual([
      ['lifecycle', lifecycleError],
      ['history', historyError],
    ])
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('ignores late polling failures after detaching the principal', async () => {
  vi.useFakeTimers()
  const f = pollingFixture()
  const rejects: ((cause: unknown) => void)[] = []
  const pending = <T>() =>
    new Promise<T>((_resolve, reject) => {
      rejects.push(reject)
    })
  f.quota.mockReturnValue(pending())
  f.lifecycle.mockReturnValue(pending())
  f.history.mockReturnValue(pending())
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const stop = f.start()
  stop()
  try {
    for (const reject of rejects) reject(new Error('late failure'))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(f.pool.diagnostics.errors).toBe(0)
    expect(f.polling.diagnostics.errors).toBe(0)
    expect(f.reportError).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(f.quota).toHaveBeenCalledTimes(1)
    expect(f.lifecycle).toHaveBeenCalledTimes(1)
    expect(f.history).toHaveBeenCalledTimes(1)
  } finally {
    f.pool.dispose()
  }
})
