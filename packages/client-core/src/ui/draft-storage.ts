/** Existing device drafts and the one-time input handoff to UiPersistence. */
import { action, observable } from 'mobx'
import {
  LEGACY_UI_KEYS,
  LEGACY_UI_MAP_PREFIXES,
  LEGACY_UI_PREFIXES,
  MIRRORED_UI_KEYS,
  type UiState,
} from '../replica/contract'
import type { DeviceStorage } from './device-storage'

export const DEVICE_DRAFT_KEYS = new Set([
  'podium.drafts.v1',
  'podium.newWork.model',
  'podium.newWork.effort',
  'podium.newWork.machine',
  'podium.newWork.repo',
  'podium.githubProjectIntake.draft',
  'podium.localProjectIntake.draft',
  'podium.existingPodium.clientDraft',
  'podium.existingPodium.machineDraft',
  'podium.onboarding.vpsServerDraft',
  'podium.firstTaskActivation.draft',
  'podium.onboarding.active',
])
export interface LegacyDeviceKeys extends UiState {
  keys(): readonly string[]
}
/** The on-disk shape and key are unchanged. UiPersistence consumes only its own keys. */
export function openLegacyDeviceKeys(device: DeviceStorage): LegacyDeviceKeys {
  const storageKey = `${device.keyPrefix}.uistate.v1`
  let values: Record<string, string> = {}
  try {
    const value: unknown = JSON.parse(device.storage.getItem(storageKey) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      values = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
  } catch {}
  // LEGACY(remove-after: 2027-03): raw localStorage keys from pre-replica installs; removing this drops their one-time import.
  // UiPersistence consumes the imported screen keys and keeps the one current
  // screen document. Persist this principal's fold before retiring any input.
  try {
    if (device.storage.getItem(`${storageKey}.migrated`) === null) {
      const retired = new Set<string>()
      const mirrored = new Set<string>(MIRRORED_UI_KEYS)
      const take = (key: string) => {
        const value = device.storage.getItem(key)
        if (value === null) return
        values[key] = value
        if (!mirrored.has(key)) retired.add(key)
      }
      for (const key of [...LEGACY_UI_KEYS, ...MIRRORED_UI_KEYS]) take(key)
      let enumerated: readonly string[] = []
      try {
        enumerated = device.enumerateKeys?.() ?? Object.keys(device.storage)
      } catch {}
      for (const key of enumerated) {
        if (LEGACY_UI_PREFIXES.some((prefix) => key.startsWith(prefix))) take(key)
        for (const [prefix, target] of Object.entries(LEGACY_UI_MAP_PREFIXES)) {
          if (!key.startsWith(prefix)) continue
          const value = device.storage.getItem(key)
          if (value === null) continue
          let entries: Record<string, string> = {}
          try {
            const parsed: unknown = JSON.parse(values[target] ?? '{}')
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
              entries = parsed as Record<string, string>
          } catch {}
          entries[key.slice(prefix.length)] = value
          values[target] = JSON.stringify(entries)
          retired.add(key)
        }
      }
      try {
        device.storage.setItem(storageKey, JSON.stringify(values))
        device.storage.setItem(`${storageKey}.migrated`, '1')
        for (const key of retired) device.storage.removeItem(key)
      } catch {}
    }
  } catch {}
  const entries = observable.map(Object.entries(values))
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  return {
    keys: () => [...entries.keys()],
    get: (key) => entries.get(key) ?? null,
    set: action((key: string, value: string | null) => {
      if ((entries.get(key) ?? null) === value) return
      if (value === null) entries.delete(key)
      else entries.set(key, value)
      try {
        device.storage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)))
      } catch {}
      for (const notify of listeners) notify(new Set([key]))
    }),
    subscribe(notify) {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    flush: async () => {
      device.storage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)))
      await device.flush?.()
    },
  }
}
