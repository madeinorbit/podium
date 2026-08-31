import type { ServerReadiness } from '@podium/model'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { type ReadinessDisplayState, ReadinessScreen } from '../components/ReadinessScreen'
import { demoEnabled } from './demoData'
import { LaunchReadyView } from './launch-ready'
import { fetchServerReadiness, readinessRecheckDelayMs } from './readiness'
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the manual-Retry trigger — bumping it re-runs the probe
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

  /**
   * AUTO-RECHECK WHILE PARKED ON `agent_unavailable` [perf/fluidity round].
   * That answer is the normal race of opening the app while the machine's
   * daemon is still connecting — the machine can become ready two seconds
   * later, and a gate that probes once left LIMITED AVAILABILITY on screen
   * until a manual Retry. Bounded backoff (2s, 5s, 10s, then 30s steady),
   * cancelled by unmount and — because `polling` flips false — by a ready
   * answer, an accepted degrade, a different degraded reason
   * (`configuration_invalid` stays manual), a manual Retry (state returns to
   * 'checking'), or a recheck failing over to 'unreachable', which keeps the
   * manual Retry path. The dep is the BOOLEAN, so one parked stretch keeps one
   * backoff clock — a fresh degraded object per tick must not reset it to 2s.
   */
  const polling =
    !demo &&
    !acceptedDegraded &&
    state !== 'checking' &&
    state !== 'unreachable' &&
    state.state === 'degraded' &&
    state.reason === 'agent_unavailable'
  useEffect(() => {
    if (!polling) return
    let alive = true
    let tick = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      timer = setTimeout(() => {
        fetchServerReadiness(config.httpOrigin).then(
          (readiness) => {
            if (!alive) return
            setState(readiness)
            // Still the same parked answer: keep backing off within THIS
            // effect instance (the boolean dep did not flip, so no re-run).
            if (readiness.state === 'degraded' && readiness.reason === 'agent_unavailable') arm()
          },
          () => {
            if (alive) setState('unreachable')
          },
        )
      }, readinessRecheckDelayMs(tick++))
    }
    arm()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [polling, config.httpOrigin])

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
