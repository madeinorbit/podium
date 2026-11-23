import type { ServerReadiness } from '@podium/model'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ReadinessDisplayState, ReadinessScreen } from '../components/ReadinessScreen'
import { startupTiming } from '../lib/startup-timing'
import { demoEnabled } from './demoData'
import { heldOfflineStatus } from './held-offline'
import { LaunchReadyView } from './launch-ready'
import { createPlatformConnectivity } from './platform-connectivity'
import { fetchServerReadiness, ReadinessAnswerError, readinessRecheckDelayMs } from './readiness'
import { useOptionalServerProfile } from './server-profile-context'
import { readServerConfig } from './trpc'

/** `offline`: no answer, and the device holds data it may open (POD-7176). */
type GateState = 'checking' | 'unreachable' | 'offline' | ServerReadiness

/**
 * Call `listener` each time the network comes back: the browser's `online` on
 * the web, NetInfo on a phone (the same connectivity the live connection
 * uses). Returns the unsubscribe.
 */
function onNetworkReturn(listener: () => void): () => void {
  const native = createPlatformConnectivity()
  if (native) {
    native.onlineEvents.add(listener)
    return () => {
      native.onlineEvents.remove(listener)
      native.dispose()
    }
  }
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('online', listener)
  return () => window.removeEventListener('online', listener)
}

/** The first network boundary in Expo web and native. No auth, replica, socket,
 * or route mounts until the server has explicitly opened its data plane, or
 * until the server could not be asked at all and this device already holds a
 * replica it may open: then the app opens on that data offline, as the
 * desktop shell does (SetupGate). Only a device holding nothing it may open
 * shows "Cannot reach this Podium server". An answer that is not a readiness
 * fact still fails closed. */
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
  const profileRef = useRef(serverProfile?.profile)
  profileRef.current = serverProfile?.profile

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
    startupTiming
      .measure('server.readiness', () => fetchServerReadiness(config.httpOrigin))
      .then(
        (readiness) => {
          if (alive) setState(readiness)
        },
        async (cause: unknown) => {
          // No answer at all (no network, a timeout): open what this device
          // holds. The profile is read at failure time, not a dependency: a new
          // profile write must not re-ask the server.
          const held =
            cause instanceof ReadinessAnswerError
              ? undefined
              : await heldOfflineStatus(profileRef.current)
          if (alive) setState(held ? 'offline' : 'unreachable')
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
    state !== 'offline' &&
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

  /**
   * BACK ONLINE, ASK AGAIN (POD-7179). Opened offline on the data it holds, or
   * parked on "Cannot reach this Podium server", the gate asked once and got no
   * answer. When the network returns it asks again, quietly: the running app
   * reconnects by itself, and the gate's state now follows the server's answer
   * instead of staying `offline` for good. Never through `checking`, which
   * would unmount the open app; a re-ask that again gets no answer changes
   * nothing. An app already open offline stays open on a degraded answer (its
   * person is already reviewing work); a blocked server closes it, as it would
   * have at launch.
   */
  const stateRef = useRef(state)
  stateRef.current = state
  const awaitingNetwork = !demo && (state === 'offline' || state === 'unreachable')
  useEffect(() => {
    if (!awaitingNetwork) return
    let alive = true
    const reask = () => {
      fetchServerReadiness(config.httpOrigin).then(
        (readiness) => {
          if (!alive) return
          if (stateRef.current === 'offline' && readiness.state === 'degraded') {
            setAcceptedDegraded(true)
          }
          setState(readiness)
        },
        () => {},
      )
    }
    const unsubscribe = onNetworkReturn(reask)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [awaitingNetwork, config.httpOrigin])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  if (state === 'checking') return null
  if (state === 'offline') return <>{children}</>
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
