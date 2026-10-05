import type { MobxPool } from '@podium/client-graph'
import type { SettingsRows } from '@podium/client-graph/settings-schema'
import type { GitRepositoryWire } from '@podium/model'
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react'
import type { Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useSettingsClient } from './stable-access'

const EMPTY_CATALOG: Pick<Store, 'machines' | 'repos'> = { machines: [], repos: [] }
const EMPTY_SETUP = {
  usage: new Map<string, number>() as ReadonlyMap<string, number>,
  defaultAgent: 'claude-code',
  pending: 0,
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

function readCatalog(pool: MobxPool): Pick<Store, 'machines' | 'repos'> {
  const catalog = pool.row('settingsCatalog', 'catalog')
  if (!loaded(catalog)) return EMPTY_CATALOG
  return {
    machines: catalog.machines.flatMap((id) => {
      const row = pool.row('settingsMachine', id)
      return loaded(row) ? [row] : []
    }),
    repos: catalog.repositories.flatMap((id) => {
      const row = pool.row('settingsRepository', id)
      return loaded(row) ? [row] : []
    }),
  }
}

export function useSettingsCatalog(): Pick<Store, 'machines' | 'repos'> {
  return useWorklistPoolProjection(readCatalog, EMPTY_CATALOG)
}

const readTab = (pool: MobxPool) => {
  const row = pool.row('settingsWindow', 'window')
  return loaded(row) ? row.settingsTab : 'sessions'
}
export function useSettingsTab(): SettingsRows['settingsWindow']['settingsTab'] {
  return useWorklistPoolProjection(readTab, 'sessions')
}

export function useSettingsSessionPresent(id: string | null): boolean {
  const read = useCallback(
    (pool: MobxPool) => id !== null && pool.settingsViews.sessionPresent(id) === true,
    [id],
  )
  return useWorklistPoolProjection(read, false)
}

export function useSettingsSetupSummary(repos: readonly GitRepositoryWire[]) {
  const paths = useMemo(() => [...new Set(repos.flatMap(repo => [repo.path, ...repo.worktrees.map(row => row.path)]))], [repos])
  const readSetup = useCallback((pool: MobxPool) => pool.settingsViews.setup(paths), [paths])
  return useWorklistPoolProjection(readSetup, EMPTY_SETUP)
}

function usePoolPreference<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, Dispatch<SetStateAction<T>>] {
  const { uiState } = useSettingsClient()
  const read = useCallback(
    (pool: MobxPool) => {
      const row = pool.row('preference', key)
      return loaded(row) ? row.value : null
    },
    [key],
  )
  const raw = useWorklistPoolProjection(read, null)
  const value = useMemo(() => parse(raw), [raw, parse])
  const current = useRef(value)
  current.current = value
  const set = useCallback(
    (next: SetStateAction<T>) => {
      const resolved =
        typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next
      current.current = resolved
      uiState.set(key, serialize(resolved))
    },
    [uiState, key, serialize],
  )
  return [value, set]
}

/** Drafts hydrate through the declared preference entity. */
export function useSettingsDraft<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, Dispatch<SetStateAction<T>>] {
  return usePoolPreference(key, parse, serialize)
}

export function useSettingsPersistedUiState<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, (value: T) => void] {
  return usePoolPreference(key, parse, serialize)
}

export const parseSettingsText = (raw: string | null): string => raw ?? ''
export const serializeSettingsText = (value: string): string | null => value || null

/** Forms with several local controllers mount after their saved seed loads,
 * so machine auto-selection cannot overwrite a draft during the load batch. */
export function useSettingsDraftSeed<T>(
  key: string | null,
  parse: (raw: string | null) => T,
): { value: T; loading: boolean } {
  return usePoolSettingsDraftSeed(key, parse)
}

function usePoolSettingsDraftSeed<T>(
  key: string | null,
  parse: (raw: string | null) => T,
): { value: T; loading: boolean } {
  const read = useCallback(
    (pool: MobxPool) => {
      if (key === null) return { raw: null, loading: false }
      const row = pool.row('preference', key)
      return loaded(row) ? { raw: row.value, loading: false } : { raw: null, loading: true }
    },
    [key],
  )
  const seed = useWorklistPoolProjection(read, { raw: null, loading: key !== null })
  return { value: useMemo(() => parse(seed.raw), [seed.raw, parse]), loading: seed.loading }
}
