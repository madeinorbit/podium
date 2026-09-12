import { UserId } from '@podium/model'
import { type ReactNode, useEffect, useState } from 'react'
import { MembershipDeniedView } from '../components/MembershipDeniedView'
import { LoginScreen } from '../screens/LoginScreen'
import { type AuthStatus, fetchAuthStatus, logout } from './auth'
import { AuthStatusContext } from './auth-context'
import { demoEnabled } from './demoData'
import { LaunchReadyView } from './launch-ready'
import { useServerProfile } from './server-profile-context'

type GateState = 'checking' | 'open' | 'login' | 'membership-denied' | 'unreachable'

/**
 * Mounts the app only once the server is reachable and (when a password is set)
 * the browser cookie or native bearer is valid — so the socket + tRPC clients
 * never start in a 401 loop. Auth-disabled servers pass straight through.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { activation, config, bearer, profile, updateCredential, removeProfile } =
    useServerProfile()
  const demo = demoEnabled()
  const [state, setState] = useState<GateState>(() => (demo ? 'open' : 'checking'))
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)

  useEffect(() => {
    if (demo) return
    if (activation === 'offline-cache' && profile.userId) {
      // The server cannot answer, but this profile already names the exact
      // profileId + userId namespace the replica was written under. This is a
      // cached identity assertion for local reads only. The first live 401 or
      // unauthenticated status response retires it and returns to sign-in.
      setAuthStatus({
        needsAuth: profile.mode === 'protected',
        authed: true,
        userId: UserId.parse(profile.userId),
      })
      setState('open')
      return
    }
    let alive = true
    fetchAuthStatus(config.httpOrigin, bearer, profile.workspaceId)
      .then((status) => {
        if (!alive) return
        setAuthStatus(status)
        setState(
          !status.authed && status.providerSignedIn === true && status.deniedReason
            ? 'membership-denied'
            : status.needsAuth && !status.authed
              ? 'login'
              : 'open',
        )
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
  }, [
    activation,
    bearer,
    config.httpOrigin,
    demo,
    profile.mode,
    profile.userId,
    profile.workspaceId,
  ])

  // The persistent LaunchBoundary above this gate owns the visible splash.
  // Returning null keeps it mounted instead of starting the reveal over here.
  if (state === 'checking') return null
  if (state === 'login') {
    return (
      <LaunchReadyView>
        <LoginScreen
          httpOrigin={config.httpOrigin}
          cloudSignInUrl={authStatus?.mode === 'cloud' ? authStatus.signInUrl : undefined}
          onAuthed={async (token) => {
            await updateCredential(token)
            // Updating the credential increments the profile runtime key. The
            // fresh AuthGate then re-reads status and names the authenticated
            // principal before any client/replica construction.
          }}
        />
      </LaunchReadyView>
    )
  }
  if (state === 'membership-denied') {
    return (
      <LaunchReadyView>
        <MembershipDeniedView
          reason={authStatus?.deniedReason ?? ''}
          server={config.httpOrigin}
          signInUrl={authStatus?.signInUrl}
          onBegin={async () => {
            // Revoke/clear the refused account before starting a new handoff.
            // The new account must never inherit this profile's bearer.
            await logout(config.httpOrigin, bearer, profile.workspaceId).catch(() => {})
            await removeProfile(profile.id).catch(() => {})
          }}
        />
      </LaunchReadyView>
    )
  }
  return <AuthStatusContext.Provider value={authStatus}>{children}</AuthStatusContext.Provider>
}
