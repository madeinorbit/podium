import type { AuthStatus } from '@podium/client-core/accounts'
import { createContext, useContext } from 'react'

/** The sign-in gate's server-authored capabilities, including for a same-machine sign-in. */
export const ServerAuthStatusContext = createContext<AuthStatus | null>(null)
export const useServerAuthStatus = () => useContext(ServerAuthStatusContext)
