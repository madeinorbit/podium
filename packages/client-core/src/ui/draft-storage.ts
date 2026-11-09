/** Existing device draft storage, retained for D27. No screen fields are written here. */
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
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  return {
    keys: () => Object.keys(values),
    get: (key) => values[key] ?? null,
    set(key, value) {
      if (value === null) delete values[key]
      else values[key] = value
      try {
        device.storage.setItem(storageKey, JSON.stringify(values))
      } catch {}
      for (const notify of listeners) notify(new Set([key]))
    },
    subscribe(notify) {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    flush: async () => {
      device.storage.setItem(storageKey, JSON.stringify(values))
      await device.flush?.()
    },
  }
}
