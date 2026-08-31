import { useRouter } from 'expo-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text } from 'react-native'
import { useAuthStatus } from '../client/auth-context'
import { useBooting, useHttpOrigin, useIssues, useSessions } from '../client/hooks'
import {
  consumePendingMobileHandoff,
  decideMobileHandoff,
  mobileHandoffFallbackStatus,
  pendingMobileHandoffSnapshot,
  subscribePendingMobileHandoff,
} from '../client/mobile-handoff'
import { useServerProfile } from '../client/server-profile-context'
import { MOBILE_HOME } from '../lib/navigation'
import {
  mobilePodiumRoute,
  setActivePodiumOrigin,
  setPodiumTargetActivator,
} from '../lib/podium-link'

/**
 * Makes Podium addresses live on the phone (POD-1606). Mounted once inside the
 * client provider, where the router and the store both exist. Its only output is
 * a stable screen-reader status node for handoff progress and fail-closed copy.
 *
 * The paired-profile origins are registered by <ServerProfileGate>; this owns
 * the ACTIVE server, in its own slot. This component is a DESCENDANT of that
 * gate, so its effect runs first and a shared list would be overwritten by the
 * gate's next write — and when the server comes from EXPO_PUBLIC_PODIUM_SERVER
 * there is no profile row to restore it from.
 *
 * Re-registered on every render so the activator always closes over the current
 * rows — resolving `POD-1606` is a live-data question.
 */
export function PodiumLinkHost() {
  const router = useRouter()
  const httpOrigin = useHttpOrigin()
  const issues = useIssues()
  const sessions = useSessions()
  const booting = useBooting()
  const authStatus = useAuthStatus()
  const { profile, profiles, activation } = useServerProfile()
  const pending = useSyncExternalStore(
    subscribePendingMobileHandoff,
    pendingMobileHandoffSnapshot,
    pendingMobileHandoffSnapshot,
  )
  const [handoffStatus, setHandoffStatus] = useState('')

  useEffect(() => {
    setPodiumTargetActivator((target) => {
      const route = mobilePodiumRoute(target, { issues, sessions })
      if (!route) return false
      router.push(route as never)
      return true
    })
    return () => setPodiumTargetActivator(null)
  })

  useEffect(() => {
    setActivePodiumOrigin(httpOrigin)
    return () => setActivePodiumOrigin(null)
  }, [httpOrigin])

  useEffect(() => {
    if (!pending.request) return
    const decision = decideMobileHandoff(pending.request, {
      profiles,
      activeProfileId: profile.id,
      activation,
      authentication:
        authStatus === null
          ? 'unavailable'
          : authStatus.authed && authStatus.userId
            ? 'authenticated'
            : 'unauthenticated',
      ...(authStatus?.authed && authStatus.userId
        ? { authenticatedUserId: authStatus.userId }
        : {}),
      replicaReady: !booting,
      sessions,
    })

    if (decision.kind === 'wait-replica') {
      setHandoffStatus('Checking the matching saved server.')
      return
    }
    if (decision.kind === 'authenticate') {
      // AuthGate normally owns this state and keeps this host unmounted. Keeping
      // the request pending here protects the same boundary during a slow gate
      // transition without resolving it against an unauthenticated replica.
      setHandoffStatus('Sign in to the matching saved server to continue.')
      return
    }
    if (decision.kind === 'switch-profile') {
      // ServerProfileGate owns this transition outside AuthGate, so a signed-out
      // destination can be selected before its login surface mounts.
      setHandoffStatus('Opening the matching saved server.')
      return
    }
    if (decision.kind === 'fallback') {
      consumePendingMobileHandoff(pending.id)
      setHandoffStatus(mobileHandoffFallbackStatus(decision.reason))
      router.replace(MOBILE_HOME as never)
      return
    }

    const route = mobilePodiumRoute(decision.target, { issues, sessions })
    if (!route) {
      consumePendingMobileHandoff(pending.id)
      setHandoffStatus(mobileHandoffFallbackStatus('session-unavailable'))
      router.replace(MOBILE_HOME as never)
      return
    }
    consumePendingMobileHandoff(pending.id)
    setHandoffStatus('Opening the session.')
    router.replace(route as never)
  }, [activation, authStatus, booting, issues, pending, profile.id, profiles, router, sessions])

  return handoffStatus ? (
    <Text role="status" accessibilityLiveRegion="polite" style={styles.srStatus}>
      {handoffStatus}
    </Text>
  ) : null
}

const styles = StyleSheet.create({
  srStatus: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
})
