import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { preferenceSource } from '@podium/client-graph/preference-source'
import { createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createRoutedUiState, FIRST_TASK_ACTIVATION_DRAFT_KEY, type ReplicatedUiStatePort } from '@podium/client-core/ui-state'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { checkPreferences } from '../../../tests/worklist/diagnostics/preference-check'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const flush = async () => {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
}

function fixture() {
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  const data = new Map<string, unknown>(),
    listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const replicated: ReplicatedUiStatePort = {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value)
      for (const wake of listeners) wake(new Set([key]))
    },
    clear: (key) => {
      data.delete(key)
      for (const wake of listeners) wake(new Set([key]))
    },
    hydrate: async () => {},
    subscribe: (wake) => {
      listeners.add(wake)
      return () => {
        listeners.delete(wake)
      }
    },
  }
  const ui = createRoutedUiState({ local: side.uiState(), replicated })
  const get = vi.spyOn(ui, 'get')
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  attachPreferenceSource(pool, ui)
  return { ui, get, pool, replicated }
}

it('re-reads only the changed key in the owner batch, routes both homes, and drops unobserved keys', async () => {
  const f = fixture()
  const keys = [
    'podium:sidebar:project-fold:a',
    'podium:sidebar:project-fold:b',
    'podium:sidebar:width',
  ]
  const seen: Record<string, unknown> = {},
    runs: Record<string, number> = {}
  const stops = keys.map((key) =>
    autorun(() => {
      runs[key] = (runs[key] ?? 0) + 1
      const row = f.pool.row('preference', key)
      seen[key] = row && row !== LOADING ? row.value : row
    }),
  )
  try {
    expect(Object.values(seen)).toEqual([LOADING, LOADING, LOADING])
    await flush()
    expect(checkPreferences(f.pool, f.ui, keys)).toMatchObject({ differences: 0, pending: 0 })
    for (const key of keys) {
      f.get.mockClear()
      for (const field of keys) runs[field] = 0
      f.ui.set(key, '1')
      await flush()
      expect(seen[key]).toBe('1')
      expect(f.get.mock.calls).toEqual([[key]])
      expect(runs).toEqual(Object.fromEntries(keys.map((field) => [field, field === key ? 1 : 0])))
    }
    // A replicated clear/rollback identifies the canonical key and reaches
    // the same legacy-spelled reader without scanning other routed keys.
    f.get.mockClear()
    f.replicated.clear('sidebar.section.project-fold:a')
    await flush()
    expect(seen[keys[0]!]).toBeNull()
    expect(f.get.mock.calls).toEqual([[keys[0]]])
    // A burst reads the final owner value once, after the existing batch ends.
    f.get.mockClear()
    f.ui.set(keys[0]!, 'first')
    f.ui.set(keys[0]!, 'final')
    await flush()
    expect(seen[keys[0]!]).toBe('final')
    expect(f.get.mock.calls).toEqual([[keys[0]]])
    stops[1]!()
    expect((preferenceSource(f.pool)?.keys() ?? [])).not.toContain(keys[1])
    f.get.mockClear()
    f.ui.set(keys[1]!, '2')
    await flush()
    expect(f.get).not.toHaveBeenCalled()
  } finally {
    for (const stop of stops) stop()
    f.pool.dispose()
  }
})

it('preserves exact preference values and rejects a planted stale value in the parity check', async () => {
  const f = fixture(),
    key = 'podium:sidebar:project-fold:parity'
  const stop = autorun(() => f.pool.row('preference', key))
  try {
    await flush()
    f.ui.set(key, '1')
    await flush()
    expect(checkPreferences(f.pool, f.ui, [key])).toMatchObject({ differences: 0, pending: 0 })
    const get = f.get.mockImplementation(() => 'planted-stale-value')
    expect(checkPreferences(f.pool, f.ui, [key]).differences).toBe(1)
    get.mockRestore()
    expect(checkPreferences(f.pool, f.ui, [key]).differences).toBe(0)
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('publishes an addressed local draft before input-end while keeping other preference batches', async () => {
  const f = fixture()
  const draftKey = FIRST_TASK_ACTIVATION_DRAFT_KEY
  const otherKey = 'podium:sidebar:project-fold:other'
  let draft: unknown, other: unknown
  const stopDraft = autorun(() => {
    const row = f.pool.row('preference', draftKey)
    draft = row && row !== LOADING ? row.value : row
  })
  const stopOther = autorun(() => {
    const row = f.pool.row('preference', otherKey)
    other = row && row !== LOADING ? row.value : row
  })
  try {
    expect(draft).toBe(LOADING)
    expect(other).toBe(LOADING)
    await flush()
    f.get.mockClear()
    f.ui.set(otherKey, 'first')
    f.ui.set(otherKey, 'final')
    f.ui.set(draftKey, 'abcdeZfghijklmnopqrst')
    preferenceSource(f.pool)!.refreshKey(draftKey)
    // Deliberately before any await: this is the controlled-input boundary.
    expect(draft).toBe('abcdeZfghijklmnopqrst')
    expect(other).toBeNull()
    expect(f.get.mock.calls).toEqual([[draftKey]])
    await flush()
    expect(other).toBe('final')
    expect(f.get.mock.calls).toEqual([[draftKey], [otherKey]])
    f.get.mockClear()
    f.ui.set(draftKey, null)
    preferenceSource(f.pool)!.refreshKey(draftKey)
    expect(draft).toBeNull()
    await flush()
    expect(f.get.mock.calls).toEqual([[draftKey]])
    stopDraft()
    f.get.mockClear()
    preferenceSource(f.pool)!.refreshKey(draftKey)
    preferenceSource(f.pool)!.refreshKey('unobserved-key')
    expect(f.get).not.toHaveBeenCalled()
  } finally {
    stopDraft()
    stopOther()
    f.pool.dispose()
  }
})
