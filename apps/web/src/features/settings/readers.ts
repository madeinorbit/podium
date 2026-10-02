import { recordSliceDerivation } from '@podium/client-core/perf'
import { shallowEqual } from '@podium/client-core/store'
import { createRepositoryUsageSelector, resolveDefaultAgent } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph'
import type { SettingsRows } from '@podium/client-graph/settings-schema'
import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useStoreSelector, type Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { settingsDataLayer } from './data-layer'
import { useSettingsClient } from './stable-access'

const EMPTY_CATALOG: Pick<Store, 'machines' | 'repos'> = { machines: [], repos: [] }
const EMPTY_SETUP = { usage: new Map<string, number>() as ReadonlyMap<string, number>, defaultAgent: 'claude-code', pending: 0 }
const loaded = <T,>(row: T | symbol | undefined): row is T => typeof row === 'object' && row !== null

function readCatalog(pool: MobxPool): Pick<Store, 'machines' | 'repos'> {
  const catalog = pool.row('settingsCatalog', 'catalog')
  if (!loaded(catalog)) return EMPTY_CATALOG
  return {
    machines: catalog.machines.flatMap((id) => { const row = pool.row('settingsMachine', id); return loaded(row) ? [row] : [] }),
    repos: catalog.repositories.flatMap((id) => { const row = pool.row('settingsRepository', id); return loaded(row) ? [row] : [] }),
  }
}

export function useSettingsCatalog(): Pick<Store, 'machines' | 'repos'> {
  if (settingsDataLayer() === 'pool') return useWorklistPoolProjection(readCatalog, EMPTY_CATALOG)
  const { owner } = useSettingsClient()
  return useStoreSelector((state) => {
    recordSliceDerivation(owner, 'settings.catalog')
    return { machines: state.machines ?? [], repos: state.repos ?? [] }
  }, shallowEqual)
}

const readTab = (pool: MobxPool) => {
  const row = pool.row('settingsWindow', 'window')
  return loaded(row) ? row.settingsTab : 'sessions'
}
export function useSettingsTab(): SettingsRows['settingsWindow']['settingsTab'] {
  if (settingsDataLayer() === 'pool') return useWorklistPoolProjection(readTab, 'sessions')
  const { owner } = useSettingsClient()
  return useStoreSelector((state) => { recordSliceDerivation(owner, 'settings.tab'); return state.settingsTab })
}

export function useSettingsSessionPresent(id: string | null): boolean {
  if (settingsDataLayer() === 'pool') {
    const read = useCallback((pool: MobxPool) => id !== null && pool.settingsViews.sessionPresent(id) === true, [id])
    return useWorklistPoolProjection(read, false)
  }
  const { owner } = useSettingsClient()
  return useStoreSelector((state) => {
    recordSliceDerivation(owner, 'settings.sessionPresence')
    return id !== null && state.sessions.some((session) => session.sessionId === id)
  })
}

const readSetup = (pool: MobxPool) => pool.settingsViews.setup()
export function useSettingsSetupSummary() {
  if (settingsDataLayer() === 'pool') return useWorklistPoolProjection(readSetup, EMPTY_SETUP)
  const { owner } = useSettingsClient()
  const sessions = useStoreSelector((state) => { recordSliceDerivation(owner, 'settings.setup'); return state.sessions })
  const select = useMemo(createRepositoryUsageSelector, [])
  return { usage: select(sessions), defaultAgent: resolveDefaultAgent(undefined, sessions), pending: 0 }
}

function usePoolPreference<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string | null): [T, Dispatch<SetStateAction<T>>] {
  const { uiState } = useSettingsClient()
  const read = useCallback((pool: MobxPool) => {
    const row = pool.row('preference', key)
    return loaded(row) ? row.value : null
  }, [key])
  const raw = useWorklistPoolProjection(read, null)
  const value = useMemo(() => parse(raw), [raw, parse])
  const current = useRef(value)
  current.current = value
  const set = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next
    current.current = resolved
    uiState.set(key, serialize(resolved))
  }, [uiState, key, serialize])
  return [value, set]
}

/** Activation drafts were seeded in the old screen. Preserve that fallback;
 * the enabled reader hydrates through the declared preference entity. */
export function useSettingsDraft<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string | null): [T, Dispatch<SetStateAction<T>>] {
  if (settingsDataLayer() === 'pool') return usePoolPreference(key, parse, serialize)
  const { owner, uiState } = useSettingsClient()
  const [value, setValue] = useState(() => { recordSliceDerivation(owner, 'settings.preference'); return parse(uiState?.get(key) ?? null) })
  const current = useRef(value)
  current.current = value
  const set = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next
    current.current = resolved
    setValue(resolved)
    uiState?.set(key, serialize(resolved))
  }, [uiState, key, serialize])
  return [value, set]
}

/** The cold-start composer already subscribed; keep its existing fallback. */
export function useSettingsPersistedUiState<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string | null): [T, (value: T) => void] {
  return settingsDataLayer() === 'pool' ? usePoolPreference(key, parse, serialize) : usePersistedUiState(key, parse, serialize)
}

export const parseSettingsText = (raw: string | null): string => raw ?? ''
export const serializeSettingsText = (value: string): string | null => value || null

/** Forms with several local controllers mount after their saved seed loads,
 * so machine auto-selection cannot overwrite a draft during the load batch. */
export function useSettingsDraftSeed<T>(key: string | null, parse: (raw: string | null) => T): { value: T; loading: boolean } {
  if (settingsDataLayer() === 'pool') {
    const read = useCallback((pool: MobxPool) => {
      if (key === null) return { raw: null, loading: false }
      const row = pool.row('preference', key)
      return loaded(row) ? { raw: row.value, loading: false } : { raw: null, loading: true }
    }, [key])
    const seed = useWorklistPoolProjection(read, { raw: null, loading: key !== null })
    return { value: useMemo(() => parse(seed.raw), [seed.raw, parse]), loading: seed.loading }
  }
  const { owner, uiState } = useSettingsClient()
  const [value] = useState(() => {
    recordSliceDerivation(owner, 'settings.preferenceSeed')
    return parse(key === null ? null : uiState?.get(key) ?? null)
  })
  return { value, loading: false }
}
