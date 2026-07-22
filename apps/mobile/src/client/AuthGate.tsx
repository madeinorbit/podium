import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { BootSplash } from '../components/BootSplash'
import { LoginScreen } from '../screens/LoginScreen'
import { fetchAuthStatus } from './auth'
import { readServerConfig } from './trpc'

type GateState = 'checking' | 'open' | 'login' | 'unreachable'

/**
 * Mounts the app only once the server is reachable and (when a password is set)
 * the session cookie is valid — so the socket + tRPC clients never start in a
 * 401 loop. Auth-disabled servers pass straight through.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const [state, setState] = useState<GateState>('checking')

  useEffect(() => {
    let alive = true
    fetchAuthStatus(config.httpOrigin)
      .then((status) => {
        if (!alive) return
        setState(status.needsAuth && !status.authed ? 'login' : 'open')
      })
      .catch(() => {
        // /auth/status is unauthenticated; failure means the server is down.
        // Open anyway: the provider's connection banner tells the story and
        // recovers on its own, which beats a dead gate screen.
        if (alive) setState('open')
      })
    return () => {
      alive = false
    }
  }, [config.httpOrigin])

  if (state === 'checking') return <BootSplash />
  if (state === 'login') {
    return <LoginScreen httpOrigin={config.httpOrigin} onAuthed={() => setState('open')} />
  }
  return <>{children}</>
}
