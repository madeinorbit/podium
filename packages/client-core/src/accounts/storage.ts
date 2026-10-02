/** Small installation records available before a principal replica opens. */
export interface ProfileMetadataStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
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
