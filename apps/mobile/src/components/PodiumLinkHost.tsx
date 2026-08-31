import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { useHttpOrigin, useIssues, useSessions } from '../client/hooks'
import {
  mobilePodiumRoute,
  setActivePodiumOrigin,
  setPodiumTargetActivator,
} from '../lib/podium-link'

/**
 * Makes Podium addresses live on the phone (POD-1606). Mounted once inside the
 * client provider, where the router and the store both exist; renders nothing.
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
    setActivePodiumOrigin(httpOrigin)
    return () => setActivePodiumOrigin(null)
  }, [httpOrigin])

  return null
}
