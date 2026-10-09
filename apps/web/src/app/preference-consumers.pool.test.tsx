import { omitGone } from '@podium/client-graph/lookup'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { preferenceSource } from '@podium/client-graph/preference-source'
import { EXISTING_PODIUM_CLIENT_DRAFT_KEY, type RoutedUiState } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseSettingsText,
  serializeSettingsText,
  useSettingsDraft,
  useSettingsDraftSeed,
  useSettingsPersistedUiState,
} from '@/features/settings/readers'
import { DensityProvider, SHELL_DENSITY_KEY, useDensity } from './density'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ports = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  ui: null as RoutedUiState | null,
}))

vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => ({ get access() { return ({ uiState: ports.ui }) } }),
  useRuntimeSelector: () => {
    throw new Error('Preference consumers must use the pool')
  },
}))

vi.mock('@/app/store-worklist-pool', async () => {
  const { useMemo, useSyncExternalStore } = await import('react')
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  const subscribe = () => () => {}
  return {
    useWorklistPool: () => ports.pool,
    useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, empty: T): T {
      const pool = ports.pool
      const projection = useMemo(
        () => (pool ? createPoolProjection(pool, read) : null),
        [pool, read],
      )
      return useSyncExternalStore(
        projection?.subscribe ?? subscribe,
        () => projection?.getSnapshot() ?? empty,
      )
    },
  }
})

describe('pool-only preference consumers', () => {
  let pool: MobxPool
  let root: Root
  let container: HTMLDivElement
  let ui: RoutedUiState
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const publish = (key: string, value: string | null) => {
    if (value === null) values.delete(key)
    else values.set(key, value)
    for (const wake of listeners) wake(new Set([key]))
  }
  const paint = (node: ReactNode) => act(() => root.render(node))
  const settle = () =>
    act(async () => {
      await Promise.resolve()
    })

  beforeEach(() => {
    values.clear()
    listeners.clear()
    ui = {
      get: vi.fn((key: string) => values.get(key) ?? null),
      set: vi.fn(publish),
      subscribe: (wake: (keys: ReadonlySet<string>) => void) => {
        listeners.add(wake)
        return () => {
          listeners.delete(wake)
        }
      },
    } as RoutedUiState
    pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 }, undefined, {
      load: () => undefined,
      schedule: () => () => {},
    })
    attachPreferenceSource(pool, ui)
    ports.pool = pool
    ports.ui = ui
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    history.replaceState(null, '', '/?mobxSettings=0&mobxPreferences=0')
  })

  afterEach(() => {
    act(() => root.unmount())
    pool.dispose()
    container.remove()
    delete document.documentElement.dataset.density
    history.replaceState(null, '', '/')
    ports.pool = null
    ports.ui = null
  })

  it('hydrates draft, persisted value and form seed together, retaining functional setters and later arrivals', async () => {
    const key = EXISTING_PODIUM_CLIENT_DRAFT_KEY
    values.set(key, 'saved draft')
    function Draft() {
      const [draft, setDraft] = useSettingsDraft(key, parseSettingsText, serializeSettingsText)
      const [persisted] = useSettingsPersistedUiState(key, parseSettingsText, serializeSettingsText)
      const seed = useSettingsDraftSeed(key, parseSettingsText)
      return (
        <>
          <output data-value="draft">{draft}</output>
          <output data-value="persisted">{persisted}</output>
          <output data-value="seed">{seed.loading ? 'loading' : seed.value}</output>
          <button
            type="button"
            onClick={() => {
              setDraft((previous) => previous + '!')
              setDraft((previous) => previous + '!')
            }}
          >
            Edit
          </button>
        </>
      )
    }
    paint(<Draft />)
    expect(container.querySelector('[data-value="draft"]')?.textContent).toBe('')
    expect(container.querySelector('[data-value="seed"]')?.textContent).toBe('loading')
    expect(ui.get).not.toHaveBeenCalled()
    await settle()
    expect([...container.querySelectorAll('output')].map((row) => row.textContent)).toEqual([
      'saved draft',
      'saved draft',
      'saved draft',
    ])
    expect(ui.get).toHaveBeenCalledTimes(1)
    act(() => container.querySelector('button')?.click())
    expect(ui.set).toHaveBeenNthCalledWith(1, key, 'saved draft!')
    expect(ui.set).toHaveBeenNthCalledWith(2, key, 'saved draft!!')
    // Before the deferred source batch: controlled form props are current.
    expect([...container.querySelectorAll('output')].map((row) => row.textContent)).toEqual([
      'saved draft!!',
      'saved draft!!',
      'saved draft!!',
    ])
    await settle()
    expect([...container.querySelectorAll('output')].map((row) => row.textContent)).toEqual([
      'saved draft!!',
      'saved draft!!',
      'saved draft!!',
    ])
    act(() => publish(key, 'arrived draft'))
    await settle()
    expect([...container.querySelectorAll('output')].map((row) => row.textContent)).toEqual([
      'arrived draft',
      'arrived draft',
      'arrived draft',
    ])
  })

  it('leaves a form without a saved key ready without issuing a preference question', async () => {
    function Unseeded() {
      const seed = useSettingsDraftSeed(null, parseSettingsText)
      return <output>{seed.loading ? 'loading' : 'ready:' + seed.value}</output>
    }
    paint(<Unseeded />)
    await settle()
    expect(container.textContent).toBe('ready:')
    expect(ui.get).not.toHaveBeenCalled()
    expect((preferenceSource(pool)?.counts ?? null)?.batches).toBe(0)
  })

  function Density() {
    const { density, setDensity } = useDensity()
    return (
      <button type="button" onClick={() => setDensity('balanced')}>
        {density}
      </button>
    )
  }

  const density = (enabled: boolean) => (
    <DensityProvider densityEnabled={enabled}>
      <Density />
    </DensityProvider>
  )

  it('keeps compact dormant while disabled, then adopts saved and replicated density with the existing writer', async () => {
    values.set(SHELL_DENSITY_KEY, 'compact')
    paint(density(false))
    await settle()
    expect(container.textContent).toBe('balanced')
    expect(document.documentElement.dataset.density).toBe('balanced')
    expect(ui.set).not.toHaveBeenCalled()
    paint(density(true))
    expect(container.textContent).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
    act(() => container.querySelector('button')?.click())
    expect(ui.set).toHaveBeenCalledExactlyOnceWith(SHELL_DENSITY_KEY, 'balanced')
    await settle()
    expect(container.textContent).toBe('balanced')
    act(() => publish(SHELL_DENSITY_KEY, 'compact'))
    await settle()
    expect(container.textContent).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('paints balanced before the pool arrives and batches the declared density load', async () => {
    values.set(SHELL_DENSITY_KEY, 'compact')
    ports.pool = null
    paint(density(true))
    expect(container.textContent).toBe('balanced')
    expect(ui.get).not.toHaveBeenCalled()
    ports.pool = pool
    paint(density(true))
    expect(omitGone(pool.row('preference', SHELL_DENSITY_KEY))).toBe(LOADING)
    expect(container.textContent).toBe('balanced')
    await settle()
    expect(container.textContent).toBe('compact')
    expect(ui.get).toHaveBeenCalledExactlyOnceWith(SHELL_DENSITY_KEY)
    expect((preferenceSource(pool)?.counts ?? null)?.batches).toBe(1)
  })
})
