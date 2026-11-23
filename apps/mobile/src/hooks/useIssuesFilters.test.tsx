/**
 * THE PHONE READS THE FILTERS THE WEB SAVES (POD-6297, after POD-6294).
 *
 * Assigned to and Show agent tasks are one member's own filters, on the
 * replicated `podium.issues.filters` row. A choice made in the web's Filter
 * menu is the phone's too, and the old Display row's Show agent tasks is read
 * only until the first save moves it.
 */

import {
  ISSUES_DISPLAY_KEY,
  ISSUES_FILTERS_KEY,
  type RoutedUiState,
} from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIssuesFilters } from './useIssuesFilters'

const state = vi.hoisted(() => ({
  ui: undefined as RoutedUiState | undefined,
  pool: null as MobxPool | null,
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
    const view = useMemo(() => (pool ? createPoolProjection(pool, read) : null), [pool, read])
    return useSyncExternalStore(
      view?.subscribe ?? (() => () => {}),
      view?.getSnapshot ?? (() => empty),
    )
  },
}))

function port() {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const emit = (keys: ReadonlySet<string> = new Set()) => {
    for (const wake of [...listeners]) wake(keys)
  }
  return {
    values,
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
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

let ui: ReturnType<typeof port>
let pool: MobxPool
beforeEach(() => {
  ui = port()
  state.ui = ui as unknown as RoutedUiState
  pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  attachPreferenceSource(pool, state.ui)
  state.pool = pool
})
afterEach(() => {
  cleanup()
  pool.dispose()
})

describe('the phone Tasks filters (POD-6297)', () => {
  it('defaults to your own tasks with agent tasks hidden', async () => {
    const { result } = renderHook(() => useIssuesFilters())
    await flush()
    expect(result.current[0]).toMatchObject({ assignedTo: 'me', showAgentTasks: false })
  })

  it("follows the row the web's Filter menu writes, not the Display row", async () => {
    ui.values.set(
      ISSUES_DISPLAY_KEY,
      JSON.stringify({ ordering: 'priority', showAgentTasks: false }),
    )
    ui.values.set(ISSUES_FILTERS_KEY, JSON.stringify({ assignedTo: 'all', showAgentTasks: true }))
    const { result } = renderHook(() => useIssuesFilters())
    await flush()
    expect(result.current[0]).toMatchObject({ assignedTo: 'all', showAgentTasks: true })
    // A later web change arrives on the same row.
    act(() => {
      ui.values.set(
        ISSUES_FILTERS_KEY,
        JSON.stringify({ assignedTo: 'bob', showAgentTasks: false }),
      )
      ui.emit(new Set([ISSUES_FILTERS_KEY]))
    })
    await flush()
    expect(result.current[0]).toMatchObject({ assignedTo: 'bob', showAgentTasks: false })
  })

  it("reads the old Display row's agent tasks once, and the first save moves it", async () => {
    ui.values.set(
      ISSUES_DISPLAY_KEY,
      JSON.stringify({ ordering: 'priority', showAgentTasks: true }),
    )
    const { result } = renderHook(() => useIssuesFilters())
    await flush()
    expect(result.current[0]).toMatchObject({ assignedTo: 'me', showAgentTasks: true })
    act(() => result.current[1]({ assignedTo: 'all', showAgentTasks: true }))
    await flush()
    expect(ui.set).toHaveBeenCalledWith(
      ISSUES_FILTERS_KEY,
      JSON.stringify({ assignedTo: 'all', showAgentTasks: true }),
    )
    expect(ui.set).not.toHaveBeenCalledWith(ISSUES_DISPLAY_KEY, expect.anything())
    expect(result.current[0]).toMatchObject({ assignedTo: 'all', showAgentTasks: true })
  })
})
