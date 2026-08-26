import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { useHttpOrigin, useIssues, useSessions } from '../client/hooks'
import {
  addKnownPodiumOrigin,
  mobilePodiumRoute,
  setPodiumTargetActivator,
} from '../lib/podium-link'

/**
 * Makes Podium addresses live on the phone (POD-1606). Mounted once inside the
 * client provider, where the router and the store both exist; renders nothing.
 *
 * The paired-profile origins are registered by <ServerProfileGate>; this adds
 * the ACTIVE server, because a session opened before the profile list settled
 * would otherwise send the user's own server to Safari.
 *
 * Re-registered on every render so the activator always closes over the current
 * rows — resolving `POD-1606` is a live-data question.
 */
export function PodiumLinkHost(): null {
  const router = useRouter()
  const httpOrigin = useHttpOrigin()
  const issues = useIssues()
  const sessions = useSessions()

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
    if (httpOrigin) addKnownPodiumOrigin(httpOrigin)
  }, [httpOrigin])

  return null
}
