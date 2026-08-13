import type { AsyncKeyValueStorage } from '@podium/client-core/replica'

type MobileMetadataStorage = Pick<AsyncKeyValueStorage, 'getItem' | 'setItem'>

/**
 * Process-wide port for the small app-installation records needed before a
 * principal-scoped replica can open: server profiles, cleanup intents, and the
 * enumerable credential registry. The platform composition root installs the
 * native implementation; record owners never reach for a platform singleton.
 */
let installedStorage: MobileMetadataStorage | null = null

export function installMobileMetadataStorage(storage: MobileMetadataStorage): void {
  installedStorage = storage
}

export function mobileMetadataStorage(): MobileMetadataStorage {
  if (!installedStorage) {
    throw new Error('mobile metadata storage is not installed')
  }
  return installedStorage
}
