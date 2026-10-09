import { omitGone } from '@podium/client-graph/lookup'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { preferenceSource } from '@podium/client-graph/preference-source'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCollapsed } from './useCollapsed'
import { useCollapsedSet } from './useCollapsedSet'
import { usePersistedUiState } from './usePersistedUiState'

const state = vi.hoisted(() => ({
  ui: undefined as RoutedUiState | undefined,
  pool: null as MobxPool | null,
  projections: 0,
}))
vi.mock('../client/hooks', () => ({
  useUiState: () => {
    if (!state.ui) throw new Error('No UI owner in the preference fixture')
    return state.ui
  },
}))
vi.mock('../client/mobile-pool', () => ({
  useMobilePoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T): T => {
    const pool = state.pool
    // biome-ignore lint/correctness/useExhaustiveDependencies: This fixture changes the pool on explicit rerenders to model attachment and principal replacement.
    const view = useMemo(() => {
      if (!pool) return null
      state.projections++
      return createPoolProjection(pool, read)
    }, [pool, read])
    return useSyncExternalStore(
      view?.subscribe ?? (() => () => {}),
      view?.getSnapshot ?? (() => empty),
    )
  },
}))

const VALUE = 'podium.chat.stickyPrompts'
const FOLD = 'podium:sidebar:task-details-fold'
const KEYS = ['pinned', 'repo'] as const
const storageKeyFor = (key: string) => `podium:sidebar:${key}`
const parse = (raw: string | null) => raw ?? 'default'
const serialize = (value: string) => (value === 'default' ? null : value)
const pools: MobxPool[] = []
function port() {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const emit = (keys: ReadonlySet<string> = new Set()) => {
    for (const wake of [...listeners]) wake(keys)
  }
  return {
    values,
    listeners,
    emit,
    hydrate: async () => {},
    get: vi.fn((key: string) => values.get(key) ?? null),
    set: vi.fn((key: string, value: string | null) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      emit(new Set([key]))
    }),
    subscribe: (wake: (keys: ReadonlySet<string>) => void) => {
      listeners.add(wake)
      return () => {
        listeners.delete(wake)
      }
    },
  }
}
function attach(ui: RoutedUiState) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  attachPreferenceSource(pool, ui)
  pools.push(pool)
  state.pool = pool
  return pool
}
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
let ui: ReturnType<typeof port>
beforeEach(() => {
  ui = port()
  state.ui = ui
  state.pool = null
  state.projections = 0
})
afterEach(() => {
  cleanup()
  for (const pool of pools.splice(0)) pool.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mobile preferences', () => {
  beforeEach(() => {
    attach(ui)
  })

  it('parses saved values, follows late hydration and rollback, and deletes back to defaults', async () => {
    ui.values.set(VALUE, 'saved')
    const { result } = renderHook(() => usePersistedUiState(VALUE, parse, serialize))
    await flush()
    expect(result.current[0]).toBe('saved')
    act(() => result.current[1]('optimistic'))
    await flush()
    expect(ui.set).toHaveBeenLastCalledWith(VALUE, 'optimistic')
    expect(result.current[0]).toBe('optimistic')
    act(() => {
      ui.values.set(VALUE, 'authoritative')
      ui.emit(new Set([VALUE]))
    })
    await flush()
    expect(result.current[0]).toBe('authoritative')
    act(() => result.current[1]('default'))
    await flush()
    expect(ui.set).toHaveBeenLastCalledWith(VALUE, null)
    expect(result.current[0]).toBe('default')
  })

  it('keeps parsed object identity stable when neither the key nor its value changes', async () => {
    const parseObject = (raw: string | null) => ({ value: parse(raw) })
    const { result, rerender } = renderHook(() =>
      usePersistedUiState(VALUE, parseObject, (value) => value.value),
    )
    await flush()
    const initial = result.current[0]
    act(() => {
      ui.values.set('podium.shell.density', 'compact')
      ui.emit(new Set(['podium.shell.density']))
    })
    await flush()
    rerender()
    expect(result.current[0]).toBe(initial)
  })

  it('keeps single folds immediate, honours defaults and reconciles external updates', async () => {
    const { result } = renderHook(() => useCollapsed(FOLD, true))
    await flush()
    expect(result.current[0]).toBe(true)
    act(() => result.current[1]())
    expect(result.current[0]).toBe(false)
    expect(ui.set).toHaveBeenLastCalledWith(FOLD, 'false')
    await flush()
    act(() => {
      ui.values.set(FOLD, 'true')
      ui.emit(new Set([FOLD]))
    })
    await flush()
    expect(result.current[0]).toBe(true)
    act(() => ui.set(FOLD, null))
    await flush()
    expect(result.current[0]).toBe(true)
    act(() => {
      result.current[1]()
      result.current[1]()
    })
    await flush()
    expect(result.current[0]).toBe(true)
    expect(ui.values.get(FOLD)).toBe('true')
  })

  it('shows deferred folds before writing and holds them through unrelated and stale notifications', async () => {
    const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
    await flush()
    vi.useFakeTimers()
    act(() => result.current.toggle('repo'))
    expect([...result.current.collapsed]).toEqual(['repo'])
    expect(ui.set).not.toHaveBeenCalled()
    act(() => ui.emit())
    await flush()
    expect([...result.current.collapsed]).toEqual(['repo'])
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(ui.set).toHaveBeenLastCalledWith(storageKeyFor('repo'), 'true')
    expect([...result.current.collapsed]).toEqual(['repo'])
    act(() => ui.set(storageKeyFor('repo'), 'false'))
    await flush()
    expect(result.current.collapsed.size).toBe(0)
  })

  it('takes the final rapid tap and persists even after the screen unmounts', async () => {
    ui.values.set(storageKeyFor('repo'), 'false')
    const { result, unmount } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
    await flush()
    vi.useFakeTimers()
    act(() => {
      result.current.toggle('repo')
      result.current.toggle('repo')
    })
    expect(result.current.collapsed.size).toBe(0)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    // A no-op final value must still release its overlay for external changes.
    act(() => ui.set(storageKeyFor('repo'), 'true'))
    await flush()
    expect(result.current.collapsed.has('repo')).toBe(true)
    act(() => result.current.toggle('pinned'))
    unmount()
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(ui.values.get(storageKeyFor('pinned'))).toBe('true')
  })

  it('follows changing fold lists and single preference keys without retaining removed folds', async () => {
    ui.values.set(storageKeyFor('repo'), 'true')
    const { result, rerender } = renderHook(
      ({ keys, key }) => ({
        set: useCollapsedSet(keys, storageKeyFor),
        single: useCollapsed(key, false),
        value: usePersistedUiState(key, parse, serialize),
      }),
      { initialProps: { keys: [...KEYS] as string[], key: FOLD } },
    )
    await flush()
    expect([...result.current.set.collapsed]).toEqual(['repo'])
    ui.values.set(storageKeyFor('new'), 'true')
    rerender({ keys: ['new'], key: storageKeyFor('new') })
    await flush()
    expect([...result.current.set.collapsed]).toEqual(['new'])
    expect(result.current.single[0]).toBe(true)
    expect(result.current.value[0]).toBe('true')
  })
})

it('batches all demanded keys, never falls back while attaching, and reports matching output with zero legacy reads', async () => {
  ui.values.set(VALUE, 'saved')
  ui.values.set(storageKeyFor('repo'), 'true')
  let renders = 0
  const { result, rerender } = renderHook(
    () => {
      renders++
      return {
        value: usePersistedUiState(VALUE, parse, serialize),
        single: useCollapsed(FOLD, true),
        set: useCollapsedSet(KEYS, storageKeyFor),
      }
    },
    { wrapper: StrictMode },
  )
  expect(result.current.value[0]).toBe('default')
  expect(result.current.single[0]).toBe(true)
  expect(ui.get).not.toHaveBeenCalled()
  const pool = attach(ui)
  rerender()
  expect(ui.get).not.toHaveBeenCalled()
  await flush()
  expect(result.current.value[0]).toBe('saved')
  expect([...result.current.set.collapsed]).toEqual(['repo'])
  expect((preferenceSource(pool)?.counts ?? null)).toMatchObject({ batches: 1, loaded: 4 })
  expect((preferenceSource(pool)?.keys() ?? []).length).toBe(4)
  expect(ui.listeners.size).toBe(1)
  const values = () =>
    (preferenceSource(pool)?.keys() ?? []).map((key) => {
      const row = omitGone(pool.row('preference', key))
      return typeof row === 'object' && row ? row.value : row
    })
  expect(values()).toEqual(['saved', null, null, 'true'])
  const projections = state.projections
  rerender()
  expect(state.projections).toBe(projections)
  const before = renders
  act(() => ui.emit())
  await flush()
  expect(renders).toBe(before)

  const row = pool.row.bind(pool)
  vi.spyOn(pool, 'row').mockImplementation(((entity: never, key: string) => {
    const value = row(entity, key)
    return typeof value === 'object' && value ? { ...value, value: 'planted-difference' } : value
  }) as typeof pool.row)
  expect(values()).toEqual(Array(4).fill('planted-difference'))
  expect(values()).not.toEqual(['saved', null, null, 'true'])
})

it('keeps pending writes with the old principal and drops its optimism and subscriptions on owner replacement', async () => {
  const alice = ui,
    alicePool = attach(alice)
  const { result, rerender } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
  await flush()
  vi.useFakeTimers()
  act(() => result.current.toggle('repo'))
  expect(result.current.collapsed.has('repo')).toBe(true)
  const bob = port()
  state.ui = bob
  alicePool.dispose()
  attach(bob)
  rerender()
  await flush()
  expect(result.current.collapsed.size).toBe(0)
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(alice.values.get(storageKeyFor('repo'))).toBe('true')
  expect(bob.set).not.toHaveBeenCalled()
  expect(result.current.collapsed.size).toBe(0)
  expect(alice.listeners.size).toBe(0)
  expect((preferenceSource(alicePool)?.keys() ?? [])).toEqual([])
})

it('allows an authoritative replacement inside the post-write batch to win after local optimism ends', async () => {
  attach(ui)
  const { result } = renderHook(() => useCollapsedSet(KEYS, storageKeyFor))
  await flush()
  vi.useFakeTimers()
  ui.listeners.add(() => {
    if (ui.values.get(storageKeyFor('repo')) === 'true')
      ui.values.set(storageKeyFor('repo'), 'false')
  })
  act(() => result.current.toggle('repo'))
  expect(result.current.collapsed.has('repo')).toBe(true)
  await act(async () => {
    await vi.runAllTimersAsync()
  })
  expect(result.current.collapsed.size).toBe(0)
  expect(ui.values.get(storageKeyFor('repo'))).toBe('false')
})
