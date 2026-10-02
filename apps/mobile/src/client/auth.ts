/** Platform adapter for the common account flow. */
import { createAuthClient } from '@podium/client-core/accounts'
import { Platform } from 'react-native'
import { mobileAccountCredentials } from './account-credentials'

export type { AuthStatus, LiveAuthCheck, LoginResult } from '@podium/client-core/accounts'

function client() {
  return createAuthClient({ credentials: mobileAccountCredentials, platform: Platform.OS })
}
export const fetchAuthStatus: ReturnType<typeof createAuthClient>['fetchAuthStatus'] = (...args) =>
  client().fetchAuthStatus(...args)
export const probeAuth: ReturnType<typeof createAuthClient>['probeAuth'] = (...args) =>
  client().probeAuth(...args)
export const checkLiveAuth: ReturnType<typeof createAuthClient>['checkLiveAuth'] = (...args) =>
  client().checkLiveAuth(...args)
export const login: ReturnType<typeof createAuthClient>['login'] = (...args) =>
  client().login(...args)
export const logout: ReturnType<typeof createAuthClient>['logout'] = (...args) =>
  client().logout(...args)

export class MobileAuthExpiredError extends Error {
  readonly kind = 'auth-expired' as const
  constructor() {
    super('This phone session has expired.')
    this.name = 'MobileAuthExpiredError'
  }
}
