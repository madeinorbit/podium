import { omitGone } from '@podium/client-graph/lookup'
import { settingsView } from '@podium/client-graph/settings-views'
import type { MobxPool } from '@podium/client-graph'
import type { SettingsRows } from '@podium/client-graph/settings-schema'
import type { GitRepositoryWire } from '@podium/model'
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import { keyedComputed } from '@podium/mobx-helpers'
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react'
import type { Store } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { preferenceSource } from '@podium/client-graph/preference-source'
import { useSettingsClient } from './stable-access'

const EMPTY_CATALOG: Pick<Store, 'machines' | 'repos'> = { machines: [], repos: [] }
const EMPTY_SETUP: { usage: ReadonlyMap<string, number>; defaultAgent: string; pending: number } = {
  usage: new Map<string, number>() as ReadonlyMap<string, number>,
  // The product default harness, as an identifier (POD-5614).
  defaultAgent: DEFAULT_HARNESS_AGENT,
  pending: 0,
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

function readCatalog(pool: MobxPool): Pick<Store, 'machines' | 'repos'> {
  const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
  if (!loaded(catalog)) return EMPTY_CATALOG
  return {
    machines: catalog.machines.flatMap((id) => {
      const row = omitGone(pool.row('settingsMachine', id))
      return loaded(row) ? [row] : []
    }),
    repos: catalog.repositories.flatMap((id) => {
      const row = omitGone(pool.row('settingsRepository', id))
      return loaded(row) ? [row] : []
    }),
  }
}

export function useSettingsCatalog(): Pick<Store, 'machines' | 'repos'> {
  return useWorklistPoolProjection(readCatalog, EMPTY_CATALOG)
}

const EMPTY_MACHINE_IDS: readonly string[] = []
const EMPTY_TARGETS: Record<string, string> = {}
function machineReaders(pool: MobxPool) {
  return pool.sources.view('web.settings.machines', () => {
    const ids = keyedComputed('settings.machineIds', (_key: null) => {
      const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
      return loaded(catalog) ? catalog.machines : EMPTY_MACHINE_IDS
    })
    const override = keyedComputed('settings.machineChannel', (id: string) => {
      const row = omitGone(pool.row('settingsMachine', id))
      return loaded(row) ? (row.updateChannelOverride ?? null) : null
    })
    const version = keyedComputed('settings.machineTarget', (id: string) => {
      const row = omitGone(pool.row('settingsMachine', id))
      return loaded(row) ? (row.targetVersion ?? null) : null
    })
    const targets = keyedComputed('settings.channelTargets', (channel: string | null) => {
      const result: Record<string, string> = {}
      for (const id of ids(null)) {
        const selected = override(id) ?? channel
        const target = version(id)
        if (selected && target) result[selected] ??= target
      }
      return result
    })
    return {
      ids,
      targets,
      dispose() {
        ids.clear()
        override.clear()
        version.clear()
        targets.clear()
      },
    }
  })
}
const readMachineIds = (pool: MobxPool) => machineReaders(pool).ids(null)
export function useSettingsMachineIds(): readonly string[] {
  return useWorklistPoolProjection(readMachineIds, EMPTY_MACHINE_IDS)
}
export function useSettingsMachine(id: string): Store['machines'][number] | null {
  const read = useCallback(
    (pool: MobxPool) => {
      const row = omitGone(pool.row('settingsMachine', id))
      return loaded(row) ? row : null
    },
    [id],
  )
  return useWorklistPoolProjection(read, null)
}
export function useSettingsMachineTargets(channel: string | null): Record<string, string> {
  const read = useCallback((pool: MobxPool) => machineReaders(pool).targets(channel), [channel])
  return useWorklistPoolProjection(read, EMPTY_TARGETS)
}

const readTab = (pool: MobxPool) => {
  const row = omitGone(pool.row('settingsWindow', 'window'))
  return loaded(row) ? row.settingsTab : 'sessions'
}
export function useSettingsTab(): SettingsRows['settingsWindow']['settingsTab'] {
  return useWorklistPoolProjection(readTab, 'sessions')
}

export function useSettingsSessionPresent(id: string | null): boolean {
  const read = useCallback(
    (pool: MobxPool) => id !== null && settingsView(pool).sessionPresent(id) === true,
    [id],
  )
  return useWorklistPoolProjection(read, false)
}

export function useSettingsSetupSummary(repos: readonly GitRepositoryWire[]) {
  const paths = useMemo(
    () => [
      ...new Set(repos.flatMap((repo) => [repo.path, ...repo.worktrees.map((row) => row.path)])),
    ],
    [repos],
  )
  const readSetup = useCallback((pool: MobxPool) => settingsView(pool).setup(paths), [paths])
  return useWorklistPoolProjection(readSetup, EMPTY_SETUP)
}

function usePoolPreference<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string | null,
): [T, Dispatch<SetStateAction<T>>] {
  const { uiState } = useSettingsClient()
  const pool = useWorklistPool()
  const read = useCallback(
    (pool: MobxPool) => {
      const row = omitGone(pool.row('preference', key))
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
      if (pool) preferenceSource(pool)?.refreshKey(key)
    },
    [uiState, pool, key, serialize],
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
      const row = omitGone(pool.row('preference', key))
      return loaded(row) ? { raw: row.value, loading: false } : { raw: null, loading: true }
    },
    [key],
  )
  const seed = useWorklistPoolProjection(read, { raw: null, loading: key !== null })
  return { value: useMemo(() => parse(seed.raw), [seed.raw, parse]), loading: seed.loading }
}
