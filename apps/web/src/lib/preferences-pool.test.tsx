import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createRoutedUiState, type RoutedUiState } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { checkPreferences } from '@podium/client-graph/diagnostics/preference-check'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asUserId } from '@podium/model'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { createSidebarFixture } from '../../test/sidebar-fixture'
import { usePersistedUiState } from './use-persisted-ui-state'

const FOLD = 'podium:sidebar:collapsed',
  STICKY = 'podium.chat.stickyPrompts'
const parse = (raw: string | null) => raw ?? 'absent'
const serialize = (value: string) => (value === 'absent' ? null : value)
const ownedPools: MobxPool[] = []
function poolFor(ui: RoutedUiState) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.attachPreferences(ui)
  ownedPools.push(pool)
  return pool
}
function port() {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const wake of [...listeners]) wake()
  }
  return {
    values,
    listeners,
    emit,
    hydrate: async () => {},
    get: vi.fn((key: string) => values.get(key) ?? null),
    set: (key: string, value: string | null) => {
      value === null ? values.delete(key) : values.set(key, value)
      emit()
    },
    clear: (key: string) => {
      values.delete(key)
      emit()
    },
    subscribe: (wake: () => void) => {
      listeners.add(wake)
      return () => {
        listeners.delete(wake)
      }
    },
  }
}
afterEach(() => {
  cleanup()
  for (const pool of ownedPools.splice(0)) pool.dispose()
  storeStats.enable(false)
  vi.restoreAllMocks()
})

it('declares routed keys before batched loads and follows late, optimistic, rollback and rescope values', async () => {
  const local = port(),
    replicated = port()
  const ui = createRoutedUiState({ local, replicated })
  const pool = poolFor(ui)
  const projection = createPoolProjection(pool, (p) => [
    p.row('preference', FOLD),
    p.row('preference', STICKY),
  ])
  const wake = vi.fn(),
    stop = projection.subscribe(wake)
  try {
    expect(projection.getSnapshot()).toEqual([LOADING, LOADING])
    expect(local.get).not.toHaveBeenCalled()
    expect(replicated.get).not.toHaveBeenCalled()
    expect(() => pool.row('preference', 'unclassified.key')).toThrow('Unclassified')
    await Promise.resolve()
    expect(pool.preferenceCounts()?.batches).toBe(1)
    expect(checkPreferences(pool, ui)).toMatchObject({ differences: 0, pending: 0, positions: 2 })
    // Each step exercises the same declared per-user key through the existing
    // optimistic writer or a later authoritative replacement/eviction.
    for (const change of [
      () => replicated.set('sidebar.collapsed', 'true'),
      () => ui.set(FOLD, 'false'),
      () => replicated.set('sidebar.collapsed', 'true'),
      () => replicated.clear('sidebar.collapsed'),
      () => ui.set(STICKY, 'false'),
      () => ui.set(STICKY, null),
    ]) {
      change()
      await Promise.resolve()
      expect(checkPreferences(pool, ui)).toMatchObject({ differences: 0, pending: 0, positions: 2 })
      expect(
        projection.getSnapshot().map((row) => (typeof row === 'object' ? row?.value : row)),
      ).toEqual([ui.get(FOLD), ui.get(STICKY)])
    }
    expect(wake).toHaveBeenCalled()
    const original = pool.row.bind(pool)
    vi.spyOn(pool, 'row').mockImplementation(((entity: never, id: string) => {
      const row = original(entity, id)
      return typeof row === 'object' && row
        ? { ...row, value: 'planted-comparison-difference' }
        : row
    }) as typeof pool.row)
    expect(checkPreferences(pool, ui)).toMatchObject({
      differences: 2,
      pending: 0,
      first: { index: 0, field: 'value' },
    })
  } finally {
    stop()
  }
})

it('releases the source and cancels queued reads on disposal', async () => {
  const ui = port(),
    pool = poolFor(ui)
  expect(pool.row('preference', STICKY)).toBe(LOADING)
  expect(ui.listeners.size).toBe(1)
  pool.dispose()
  ui.emit()
  await Promise.resolve()
  expect(ui.get).not.toHaveBeenCalled()
  expect(ui.listeners.size).toBe(0)
  expect(pool.preferenceKeys()).toEqual([])
  expect(pool.row('preference', STICKY)).toBe(LOADING)
})

it('uses one offline runtime pool and no legacy preference reads across StrictMode and principal rebuilds', async () => {
  const errors = vi.spyOn(console, 'error')
  const fixture = createSidebarFixture(0, Date.now(), true)
  const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
  const owners: ClientRuntime[] = []
  let owner!: ClientRuntime,
    pool: MobxPool | null = null
  const failures: string[] = []
  function Probe() {
    owner = useStoreHandle() as ClientRuntime
    pool = useWorklistPool()
    const [value, set] = usePersistedUiState(STICKY, parse, serialize)
    return (
      <button type="button" onClick={() => set('false')}>
        {value}
      </button>
    )
  }
  const tree = (principal: string | null) => (
    <StrictMode>
      <StoreProvider
        principal={principal ? asClientPrincipal(asUserId(principal)) : null}
        config={config}
        api={fixture.api}
        networkEnabled={false}
        createReplicaFn={() => fixture.newReplica()}
        onFatalError={(error) => failures.push(error)}
        attachRuntime={(runtime) => {
          owners.push(runtime)
          return attachWorklistPool(runtime, (error) => failures.push(error.message))
        }}
      >
        <Probe />
      </StoreProvider>
    </StrictMode>
  )
  storeStats.enable()
  storeStats.reset()
  const view = render(tree('alice'))
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(pool).not.toBeNull()
  })
  await act(async () => {})
  expect(new Set(owners).size).toBe(1)
  expect(view.container.textContent).toBe('absent')
  const oldOwner = owner,
    oldPool = pool!
  await act(async () => view.container.querySelector('button')!.click())
  expect(view.container.textContent).toBe('false')
  expect(owner.ui.get(STICKY)).toBe('false')
  expect(checkPreferences(pool!, owner.ui)).toMatchObject({ differences: 0, pending: 0 })
  expect(
    storeStats
      .snapshot()
      .runtimes.every(
        (row) => row.selectorRuns === 0 && Object.values(row.slices).every((n) => n === 0),
      ),
  ).toBe(true)
  view.rerender(tree('bob'))
  expect(view.container.textContent).toBe('absent')
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(pool).not.toBeNull()
  })
  expect(owner).not.toBe(oldOwner)
  expect(pool).not.toBe(oldPool)
  expect(oldPool.preferenceKeys()).toEqual([])
  await act(async () => oldOwner.ui.set(STICKY, 'old-person'))
  expect(view.container.textContent).toBe('absent')
  view.rerender(tree(null))
  expect(view.container.textContent).toBe('')
  expect(pool!.preferenceKeys()).toEqual([])
  expect(failures).toEqual([])
  expect(
    errors.mock.calls.some((args) => String(args[0]).includes('Cannot update a component')),
  ).toBe(false)
  errors.mockRestore()
})
