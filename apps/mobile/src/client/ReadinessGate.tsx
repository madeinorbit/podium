import type { ServerReadiness } from '@podium/model'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type ReadinessDisplayState, ReadinessScreen } from '../components/ReadinessScreen'
import { demoEnabled } from './demoData'
import { LaunchReadyView } from './launch-ready'
import { fetchServerReadiness } from './readiness'
import { useOptionalServerProfile } from './server-profile-context'
import { readServerConfig } from './trpc'

type GateState = 'checking' | 'unreachable' | ServerReadiness

/** The first network boundary in Expo web and native. No auth, replica, socket,
 * or route mounts until the server has explicitly opened its data plane. */
export function ReadinessGate({ children }: { children: ReactNode }) {
  const fallbackConfig = useMemo(readServerConfig, [])
  const serverProfile = useOptionalServerProfile()
  const config = serverProfile?.config ?? fallbackConfig
  const demo = demoEnabled()
  const [state, setState] = useState<GateState>(() =>
    demo ? { state: 'ready', reason: null, dataPlane: 'available' } : 'checking',
  )
  const [attempt, setAttempt] = useState(0)
  const [acceptedDegraded, setAcceptedDegraded] = useState(false)

  useEffect(() => {
    if (demo) return
    if (serverProfile?.activation === 'offline-cache') {
      // Readiness is server-owned and cannot be inferred offline. A profile
      // admitted by ServerProfileGate is allowed only to read its already-bound
      // local replica, so do not turn missing diagnostics into a false block.
      setState({ state: 'ready', reason: null, dataPlane: 'available' })
      return
    }
    let alive = true
    setState('checking')
    setAcceptedDegraded(false)
    fetchServerReadiness(config.httpOrigin).then(
      (readiness) => {
        if (alive) setState(readiness)
      },
      () => {
        if (alive) setState('unreachable')
      },
    )
    return () => {
      alive = false
    }
  }, [attempt, config.httpOrigin, demo, serverProfile?.activation])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  if (state === 'checking') return null
  if (state !== 'unreachable') {
    if (state.state === 'ready') return <>{children}</>
    if (state.state === 'degraded' && acceptedDegraded) return <>{children}</>
  }
  let displayState: ReadinessDisplayState
  if (state === 'unreachable') displayState = state
  else if (state.reason === 'configuration_invalid') displayState = 'configuration_invalid'
  else if (state.state === 'ready') return <>{children}</>
  else displayState = state.state
  return (
    <LaunchReadyView>
      <ReadinessScreen
        state={displayState}
        onRetry={retry}
        onContinue={
          state !== 'unreachable' && state.state === 'degraded'
            ? () => setAcceptedDegraded(true)
            : undefined
        }
      />
    </LaunchReadyView>
  )
}
