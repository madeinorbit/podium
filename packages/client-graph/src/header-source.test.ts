import { fixtureRoot } from '@podium/client-core/test-support/command-hooks'
import type { AgentConcurrencyHistoryResult } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asMachineId, type CheckoutWire, checkoutRowId } from '@podium/model'
import { autorun, observe } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { headerEntities } from './header-entities'
import { headerRequests } from './header-requests'
import type { HeaderRows } from './header-schema'
import { HeaderSessions } from './header-sessions'
import { attachHeaderSource } from './header-source'
import { headerView } from './header-views'
import { seedInstancePreferences } from './instance-preferences-fixture'
import { MobxPool } from './pool'

it('reads only changed header keys between 1x/4x and preserves removal and rescope', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    // Repositories come from checkout records (POD-6644); machines are feed
    // records the row source installs, not this source's.
    let checkouts: CheckoutWire[] = Array.from({ length: 128 * scale }, (_, index) => ({
      machineId: asMachineId('m0'),
      path: `/repo/${index}`,
      root: `/repo/${index}`,
      kind: 'repository' as const,
    }))
    const orders = new Map(
      Array.from({ length: 128 * scale }, (_, index) => [
        `o${index}`,
        { id: `o${index}`, repoId: 'repo', humanState: 'needs_you' } as HeaderRows['shipOrder'],
      ]),
    )
    let batch: (batch: ReplicaAddressedBatch) => void = () => {}
    const replicaRows = vi.fn((kind: string) =>
        kind === 'checkouts' ? checkouts : [...orders.values()],
      ),
      replicaRow = vi.fn((_kind: string, id: string) => orders.get(id))
    const runtime = {
      readLocal: (key: string) =>
        ({ view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0 })[key as 'view'],
      onLocals: () => () => {},
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
      access: {
        trpc: {
          quota: { summary: { query: async () => [] } },
          settings: { get: { query: async () => ({}) } },
        },
      },
    } as unknown as ClientRuntime
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const stop = attachHeaderSource(pool, fixtureRoot(runtime))
    const repositoryWrites = vi.fn()
    const stopWrites = observe(headerEntities(pool).tables.repository, (change) =>
      repositoryWrites(change.name),
    )
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
      expect(headerEntities(pool).tables.repository.size).toBe(128 * scale)
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale,
      })
      replicaRows.mockClear()
      replicaRow.mockClear()
      repositoryWrites.mockClear()
      const repository = await measure('one header repository', () => {
        checkouts = checkouts.map((row, index) =>
          index === 0 ? { ...row, branch: 'changed' } : row,
        )
        batch({
          type: 'update',
          rows: [{ kind: 'checkouts', id: checkoutRowId(asMachineId('m0'), '/repo/0') }],
        })
      })
      // One checkout moved: one repository row is written, the rest are kept.
      expect(repositoryWrites.mock.calls).toEqual([[JSON.stringify(['m0', '/repo/0'])]])
      expect(
        headerEntities(pool).get('repository', JSON.stringify(['m0', '/repo/0'])),
      ).toMatchObject({ branch: 'changed' })
      const shipping = await measure('one header shipping order', () => {
        orders.set('o0', { ...orders.get('o0')!, humanState: 'waiting' })
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o0' }] })
      })
      expect(replicaRow.mock.calls).toEqual([['shipOrders', 'o0']])
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale - 1,
      })
      replicaRow.mockClear()
      replicaRows.mockClear()
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
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 128 * scale,
        decisionCount: 128 * scale,
      })
      // A removed checkout leaves the header, and a replacement re-reads everything.
      checkouts = checkouts.slice(1)
      batch({
        type: 'update',
        rows: [{ kind: 'checkouts', id: checkoutRowId(asMachineId('m0'), '/repo/0') }],
      })
      expect(
        headerEntities(pool).get('repository', JSON.stringify(['m0', '/repo/0'])),
      ).toBeUndefined()
      orders.clear()
      batch({ type: 'replace', reason: 'rescope' })
      expect(headerEntities(pool).tables.shipOrder.size).toBe(0)
      expect(headerEntities(pool).shippingCounts('repo')).toEqual({
        unfinishedCount: 0,
        decisionCount: 0,
      })
      stop()
      replicaRow.mockClear()
      replicaRows.mockClear()
      const closed = await measure('header source detached', () => {
        batch({ type: 'update', rows: [{ kind: 'shipOrders', id: 'o1' }] })
      })
      expect(replicaRow).not.toHaveBeenCalled()
      expect(replicaRows).not.toHaveBeenCalled()
      samples.push({
        scale,
        repository: repository.work,
        shipping: shipping.work,
        unrelated: unrelated.work,
        removed: removed.work,
        added: added.work,
        closed: closed.work,
      })
    } finally {
      stopWrites()
      stop()
      pool.dispose()
    }
  }
  console.info('[header source work1x4x]', JSON.stringify(samples))
  for (const name of ['shipping', 'unrelated', 'removed', 'added', 'closed'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]![name][counter], `${name}:${counter}`).toBe(samples[0]![name][counter])
  // A checkout change derives the repositories again (one pass), but writes one row.
  expect(samples[1]!.repository.rows).toBe(samples[0]!.repository.rows)
})

function requestsFixture() {
  const reading: AgentConcurrencyHistoryResult = {
    sampledAt: '2026-10-05T00:00:00Z',
    buckets: Array.from({ length: 24 }, () => ({ start: '2026-10-05T00:00:00Z', count: 0 })),
    bucketMs: 60_000,
    peak: 0,
  }
  const history = vi.fn(async () => reading)
  const runtime = {
    readLocal: () => undefined,
    onLocals: () => () => {},
    replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
    access: {
      trpc: {
        sessions: { concurrencyHistory: { query: history } },
      },
    },
  } as unknown as ClientRuntime
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  return {
    pool,
    history,
    reading,
    runtime,
    start: () => {
      const detach = attachHeaderSource(pool, fixtureRoot(runtime))
      const release = headerRequests(pool)!.retain()
      return () => {
        release()
        detach()
      }
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('releases header sessions with the attached history source when the last header reader leaves', async () => {
  vi.useFakeTimers()
  const f = requestsFixture(),
    dispose = vi.spyOn(HeaderSessions.prototype, 'dispose')
  const stamp = new Date(0).toISOString()
  const row = {
    sessionId: 'seat',
    agentKind: 'codex',
    cwd: '/header',
    status: 'live',
    lastActiveAt: stamp,
    agentState: { phase: 'idle', since: stamp },
  }
  f.pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'seat', value: row as never }] })
  const off = f.start()
  let stop = () => {}
  try {
    await Promise.resolve()
    stop = autorun(() => {
      headerView(f.pool).workingCount()
    })
    stop()
    // The request owner holds its own working-count reaction while retained.
    off()
    expect(dispose).toHaveBeenCalled()
  } finally {
    stop()
    off()
    f.pool.dispose()
  }
})

/** POD-5798: quota is pushed; only the history is a request. The lifecycle
 *  settings are the synced instance settings record (POD-6677). */
it('asks for history on retain, on a working-count change and every 5 minutes; lifecycle is the record', async () => {
  vi.useFakeTimers()
  const f = requestsFixture()
  const stamp = new Date(0).toISOString()
  const row = {
    sessionId: 'seat',
    agentKind: 'codex',
    cwd: '/header',
    status: 'live',
    lastActiveAt: stamp,
    agentState: { phase: 'idle', since: stamp },
  }
  f.pool.apply({ type: 'replace', rows: [{ kind: 'session', id: 'seat', value: row as never }] })
  const stop = f.start()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(f.history).toHaveBeenCalledTimes(1)
    expect(headerView(f.pool).history()?.bucketMs).toBe(60_000)
    // No record yet: no lifecycle. The record's arrival is the answer.
    expect(headerView(f.pool).lifecycle()).toBeNull()
    seedInstancePreferences(f.pool, { hibernation: { enabled: false } })
    expect(headerView(f.pool).lifecycle()?.hibernation.enabled).toBe(false)
    expect(headerView(f.pool).lifecycle()?.worktreeGc).toEqual({ mode: 'propose', afterDays: 14 })
    f.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'seat',
          value: {
            ...row,
            agentState: { phase: 'working', since: new Date(Date.now()).toISOString() },
          } as never,
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.history).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(f.history.mock.calls.length).toBeGreaterThanOrEqual(3)
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('keeps the last good history through a failure and asks nothing after release', async () => {
  vi.useFakeTimers()
  const f = requestsFixture()
  f.history.mockResolvedValueOnce(f.reading).mockRejectedValueOnce(new Error('history unavailable'))
  const stop = f.start()
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(headerView(f.pool).history()?.bucketMs).toBe(60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(headerView(f.pool).history()?.bucketMs).toBe(60_000)
    stop()
    const asked = f.history.mock.calls.length
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(f.history).toHaveBeenCalledTimes(asked)
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('drops an answer that arrives after the header released it', async () => {
  vi.useFakeTimers()
  const f = requestsFixture()
  let resolve: (value: AgentConcurrencyHistoryResult) => void = () => {}
  f.history.mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const stop = f.start()
  stop()
  resolve(f.reading)
  await vi.advanceTimersByTimeAsync(0)
  expect(headerView(f.pool).history()).toBeNull()
  f.pool.dispose()
})
