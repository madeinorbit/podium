import { createContext, useContext } from 'react'
import type { AuthStatus } from './auth'

/**
 * The auth gate is the first live bootstrap request. Keep its successful
 * result available to the replica provider so opening the shell does not
 * immediately issue the same request again.
 */
export const AuthStatusContext = createContext<AuthStatus | null>(null)

export function useAuthStatus(): AuthStatus | null {
  return useContext(AuthStatusContext)
}
