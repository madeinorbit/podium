import type { MachineModel, MobxPool } from '@podium/client-graph'
import { here, omitGone } from '@podium/client-graph/lookup'
import { useOpeningView } from '@podium/client-graph/react'
import type { SettingsRows } from '@podium/client-graph/settings-schema'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import type { CheckoutRepository, GitRepositoryWire } from '@podium/model'
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useSettingsOpening } from './opening-context'
import { useSettingsClient } from './stable-access'

/** My machines (models: online is the LiveStore's) and the registered
 *  repositories, from the synced records (POD-6644). */
export interface SettingsCatalog {
  readonly machines: MachineModel[]
  readonly repos: CheckoutRepository[]
}
const EMPTY_CATALOG: SettingsCatalog = { machines: [], repos: [] }
const EMPTY_SETUP: { usage: ReadonlyMap<string, number>; defaultAgent: string; pending: number } = {
  usage: new Map<string, number>() as ReadonlyMap<string, number>,
  // The product default harness, as an identifier (POD-5614).
  defaultAgent: DEFAULT_HARNESS_AGENT,
  pending: 0,
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

const readUnsyncedChangeCount = (pool: MobxPool) => pool.live?.unsyncedChangeCount ?? null
/** null until this account's pool is attached; sign-out waits for its count. */
export function useSettingsUnsyncedChangeCount(): number | null {
  return useWorklistPoolProjection(readUnsyncedChangeCount, null)
}

function readCatalog(pool: MobxPool): SettingsCatalog {
  const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
  if (!loaded(catalog)) return EMPTY_CATALOG
  return {
    // The machines I may see: those with my own access row.
    machines: catalog.machines.flatMap((id) => {
      const machine = here(pool.model('machine', id))
      return machine && machine.use !== undefined ? [machine] : []
    }),
    repos: catalog.repositories.flatMap((id) => {
      const row = omitGone(pool.row('settingsRepository', id))
      return loaded(row) ? [row] : []
    }),
  }
}

export function useSettingsCatalog(): SettingsCatalog {
  return useWorklistPoolProjection(readCatalog, EMPTY_CATALOG)
}

const EMPTY_MACHINE_IDS: readonly string[] = []
const EMPTY_MACHINES: MachineModel[] = []
export function useSettingsMachineIds(): readonly string[] {
  const view = useSettingsOpening()
  const read = useCallback(
    (_pool: MobxPool) => view?.machines.ids(null) ?? EMPTY_MACHINE_IDS,
    [view],
  )
  return useWorklistPoolProjection(read, EMPTY_MACHINE_IDS)
}
export function useSettingsMachines(): MachineModel[] {
  const view = useSettingsOpening()
  const read = useCallback(
    (_pool: MobxPool) => view?.machines.models.values ?? EMPTY_MACHINES,
    [view],
  )
  return useWorklistPoolProjection(read, EMPTY_MACHINES)
}
export function useSettingsAuthorizedMachines(): MachineModel[] {
  const view = useSettingsOpening()
  const read = useCallback(
    (_pool: MobxPool) => view?.machines.models.authorized ?? EMPTY_MACHINES,
    [view],
  )
  return useWorklistPoolProjection(read, EMPTY_MACHINES)
}
export function useSettingsMachine(id: string | null): MachineModel | null {
  const read = useCallback(
    (pool: MobxPool) => {
      if (id === null) return null
      const row = omitGone(pool.model('machine', id))
      return loaded(row) ? row : null
    },
    [id],
  )
  return useWorklistPoolProjection(read, null)
}
const readTab = (pool: MobxPool) => {
  const row = omitGone(pool.row('settingsWindow', 'window'))
  return loaded(row) ? row.settingsTab : 'agents'
}
export function useSettingsTab(): SettingsRows['settingsWindow']['settingsTab'] {
  return useWorklistPoolProjection(readTab, 'agents')
}

export function useSettingsSessionPresent(id: string | null): boolean {
  const read = useCallback(
    (pool: MobxPool) => id !== null && pool.queries.setupSessionPresent(id) === true,
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
  const pool = useWorklistPool()
  const inherited = useSettingsOpening()
  const own = useOpeningView(pool, createSettingsViews, !inherited)
  const view = inherited?.settings ?? own
  const readSetup = useCallback(
    (_pool: MobxPool) => view?.setup(paths) ?? EMPTY_SETUP,
    [view, paths],
  )
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
      const row = omitGone(pool.row('preference', key))
      return loaded(row) ? { raw: row.value, loading: false } : { raw: null, loading: true }
    },
    [key],
  )
  const seed = useWorklistPoolProjection(read, { raw: null, loading: key !== null })
  return { value: useMemo(() => parse(seed.raw), [seed.raw, parse]), loading: seed.loading }
}
