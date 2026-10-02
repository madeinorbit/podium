import { offlineProfileStatus, type AuthBootstrap } from '@podium/client-core/accounts'
import { type ReactNode, useEffect, useState } from 'react'
import { BootTroubleScreen } from '../components/BootTroubleScreen'
import { MembershipDeniedView } from '../components/MembershipDeniedView'
import { LoginScreen } from '../screens/LoginScreen'
import { type AuthStatus, probeAuth, logout } from './auth'
import { AuthStatusContext } from './auth-context'
import { demoEnabled } from './demoData'
import { LaunchReadyView } from './launch-ready'
import { useServerProfile } from './server-profile-context'

type GateState = 'checking' | 'open' | 'login' | 'membership-denied' | 'failed'

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
  const [failure, setFailure] = useState<Extract<AuthBootstrap, { kind: 'failure' }>>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (demo) return
    const offline = activation === 'offline-cache' ? offlineProfileStatus(profile) : undefined
    if (offline) {
      setAuthStatus(offline)
      setState('open')
      return
    }
    let alive = true
    probeAuth(config.httpOrigin, bearer, profile.workspaceId)
      .then((decision) => {
        if (!alive) return
        setAuthStatus(decision.status ?? null)
        if (decision.kind === 'ready') {
          if (decision.auth.kind === 'failure') {
            setFailure(decision.auth)
            setState('failed')
          } else setState('open')
        } else setState(decision.kind)
      })
      .catch((cause) => {
        if (!alive) return
        setFailure({ kind: 'failure', message: String(cause), failure: { kind: 'unknown' } })
        setState('failed')
      })
    return () => {
      alive = false
    }
  }, [
    attempt,
    activation,
    bearer,
    config.httpOrigin,
    demo,
    profile.instanceId,
    profile.mode,
    profile.userId,
    profile.syncBoundaryId,
    profile.memberId,
    profile.workspaceId,
  ])

  // The persistent LaunchBoundary above this gate owns the visible splash.
  // Returning null keeps it mounted instead of starting the reveal over here.
  if (state === 'checking') return null
  if (state === 'failed' && failure) {
    return (
      <LaunchReadyView>
        <BootTroubleScreen
          kind="failed"
          detail={failure.message}
          cause={failure.failure}
          onRetry={() => {
            setState('checking')
            setAttempt((value) => value + 1)
          }}
        />
      </LaunchReadyView>
    )
  }
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
          workspaceId={profile.workspaceId}
          signInUrl={authStatus?.signInUrl}
          onBegin={async () => {
            // Revoke/clear the refused account before starting a new handoff.
            // The new account must never inherit this profile's bearer.
            await logout(config.httpOrigin, bearer, profile.workspaceId).catch(() => {})
            await removeProfile(profile.id)
          }}
        />
      </LaunchReadyView>
    )
  }
  return <AuthStatusContext.Provider value={authStatus}>{children}</AuthStatusContext.Provider>
}
