import type { StorageApi, UiState } from '../replica/contract'

/** The phone supplies the synchronous, preloaded AsyncStorage bridge here. */
export interface DeviceStorage {
  readonly storage: StorageApi
  readonly keyPrefix: string
  readonly flush?: () => void | Promise<void>
}

/** Non-screen device preferences and authored drafts keep their existing keys. */
export function createDeviceKeys(device: DeviceStorage): UiState {
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const legacyKey = `${device.keyPrefix}.uistate.v1`
  // Preserve only today's existing device keys when retiring the side-cache.
  let legacy: Record<string, string> = {}
  try {
    legacy = JSON.parse(device.storage.getItem(legacyKey) ?? '{}') ?? {}
  } catch {}
  return {
    get(key) {
      return (
        device.storage.getItem(`${device.keyPrefix}.device.${encodeURIComponent(key)}`) ??
        (typeof legacy[key] === 'string' ? legacy[key] : null)
      )
    },
    set(key, value) {
      const target = `${device.keyPrefix}.device.${encodeURIComponent(key)}`
      if (value === null) device.storage.removeItem(target)
      else device.storage.setItem(target, value)
      if (Object.hasOwn(legacy, key)) {
        delete legacy[key]
        device.storage.setItem(legacyKey, JSON.stringify(legacy))
      }
      for (const notify of listeners) notify(new Set([key]))
    },
    subscribe(notify) {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    flush: device.flush,
  }
}
