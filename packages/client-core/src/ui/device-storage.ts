import type { StorageApi } from '../replica/contract'
/** The phone supplies its synchronous, preloaded AsyncStorage bridge here. */
export interface DeviceStorage {
  readonly storage: StorageApi
  readonly keyPrefix: string
  readonly flush?: () => void | Promise<void>
}
