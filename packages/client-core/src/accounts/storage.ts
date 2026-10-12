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
const browserMetadataStorage = {
  getItem: (key: string): string | null => globalThis.localStorage.getItem(key),
  setItem: (key: string, value: string): void => globalThis.localStorage.setItem(key, value),
}

export const browserProfileMetadataStorage: ProfileMetadataStorage = {
  getItem: async (key) => browserMetadataStorage.getItem(key),
  setItem: async (key, value) => browserMetadataStorage.setItem(key, value),
}

/**
 * Browser-wide account-entry hint, available before a principal exists. It only
 * remembers whether sign-in needs an email field; it never stores an account
 * identity or authorizes opening a principal replica. Keep the existing key so
 * invited members still see the email field on their next sign-in.
 */
const SIGN_IN_WITH_EMAIL_KEY = 'podium.login.withEmail'

export function readBrowserSignInWithEmail(): boolean {
  try {
    return browserMetadataStorage.getItem(SIGN_IN_WITH_EMAIL_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberBrowserSignInWithEmail(on: boolean): void {
  try {
    browserMetadataStorage.setItem(SIGN_IN_WITH_EMAIL_KEY, on ? '1' : '0')
  } catch {
    // This optional form hint must not prevent a verified sign-in.
  }
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
