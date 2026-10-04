/** Small installation records available before a principal replica opens. */
export interface ProfileMetadataStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

/**
 * Browser adapter owned by the accounts layer. Server profiles choose the scoped
 * metadata keys; credentials and UI state have separate persistence owners.
 * Resolve storage on access so native imports need no browser storage singleton.
 */
export const browserProfileMetadataStorage: ProfileMetadataStorage = {
  getItem: async (key) => globalThis.localStorage.getItem(key),
  setItem: async (key, value) => globalThis.localStorage.setItem(key, value),
}

/** HttpOnly cookies have no readable token; native credentials live in the keychain. */
export interface AccountCredentials {
  readonly delivery: 'browser' | 'native'
  get(profileId: string): Promise<string | null>
  set(profileId: string, bearer: string): Promise<void>
  remove(profileId: string): Promise<void>
}

export const cookieCredentials: AccountCredentials = {
  delivery: 'browser',
  get: async () => null,
  set: async () => {},
  remove: async () => {},
}
