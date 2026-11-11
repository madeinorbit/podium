import { type AuthBootstrap, offlineProfileStatus } from '@podium/client-core/accounts'
import { type ReactNode, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { BootTroubleScreen } from '../components/BootTroubleScreen'
import { MembershipDeniedView } from '../components/MembershipDeniedView'
import { LoginScreen } from '../screens/LoginScreen'
import { type AuthStatus, logout, probeAuth } from './auth'
import { AuthStatusContext } from './auth-context'
import { demoEnabled } from './demoData'
import { LaunchReadyView } from './launch-ready'
import { useServerProfile } from './server-profile-context'

type GateState = 'checking' | 'open' | 'login' | 'membership-denied' | 'failed'

/** The phone web export delegates invitation/reset links to the shared responsive screen. */
function browserInvitationTarget(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  if (!new URLSearchParams(url.hash.slice(1)).get('invite')) return null
  url.pathname = url.pathname.replace(/\/mobile(?:\/.*)?$/, '/')
  url.searchParams.set('desktop', '1')
  return url.href
}

/**
 * Mounts the app only once the server is reachable and (when a password is set)
 * the browser cookie or native bearer is valid — so the socket + tRPC clients
 * never start in a 401 loop. Auth-disabled servers pass straight through.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { activation, config, bearer, profile, updateCredential, removeProfile } =
    useServerProfile()
  const demo = demoEnabled()
  const invitationTarget = browserInvitationTarget()
  const [state, setState] = useState<GateState>(() => (demo ? 'open' : 'checking'))
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [failure, setFailure] = useState<Extract<AuthBootstrap, { kind: 'failure' }>>()
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: selected profile fields own the probe; attempt explicitly retries it.
  useEffect(() => {
    if (invitationTarget) {
      window.location.replace(invitationTarget)
      return
    }
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
    invitationTarget,
    activation,
    bearer,
    config.httpOrigin,
    demo,
    profile.instanceId,
    profile.mode,
    profile.userId,
    profile.syncBoundaryId,
    profile.memberId,
    profile.signedOut,
    profile.workspaceId,
  ])

  // The persistent LaunchBoundary above this gate owns the visible splash.
  // Returning null keeps it mounted instead of starting the reveal over here.
  if (invitationTarget || state === 'checking') return null
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
  if (state === 'login' && (!authStatus?.capabilities || !authStatus.prompt)) {
    return (
      <LaunchReadyView>
        <BootTroubleScreen
          kind="failed"
          detail="Sign-in options are unavailable."
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </LaunchReadyView>
    )
  }
  if (state === 'login' && authStatus?.capabilities && authStatus.prompt) {
    // Older pairings were unsigned 32-byte tokens. Shared sign-ins are signed.
    return (
      <LaunchReadyView>
        <LoginScreen
          httpOrigin={config.httpOrigin}
          repairNeeded={bearer !== null && /^[A-Za-z0-9_-]{43}$/.test(bearer)}
          capabilities={authStatus.capabilities}
          prompt={authStatus.prompt}
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
          reason="This account is not a member of this workspace."
          server={config.httpOrigin}
          workspaceId={profile.workspaceId}
          capabilities={authStatus?.capabilities}
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
