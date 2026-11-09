/** Existing device draft storage, retained for D27. No screen fields are written here. */
import { action, observable } from 'mobx'
import type { UiState } from '../replica/contract'
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
  const entries = observable.map(Object.entries(values))
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  return {
    keys: () => [...entries.keys()],
    get: (key) => entries.get(key) ?? null,
    set: action((key: string, value: string | null) => {
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
