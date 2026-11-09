/** Phone reads use the shared pool; actions and transport handles retain
 * their existing owner and API. Missing pool facts retain loading values. */
import type { LiveStore } from '@podium/client-core/live'
import {
  useClientRuntime,
  useHttpOrigin as useCoreHttpOrigin,
  useReplica as useCoreReplica,
  useDeviceState,
  useRequestClient,
  useSocketHub,
} from '@podium/client-core/react'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { omitGone } from '@podium/client-graph/lookup'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { SessionId } from '@podium/model'
import { reaction } from 'mobx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { demoEnabled } from './demoData'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'
import type { MobileTrpc, TranscriptPage } from './trpc'

export {
  useSessionContextBooting as useBooting,
  useSessionContextIssue as useIssue,
  useSessionContextIssues as useIssues,
  useSessionContextSession as useSession,
  useSessionContextSessions as useSessions,
  useSessionContextSpawnPending as useSpawnPending,
  useSessionContextSpawnPrompt as useSpawnPrompt,
} from './use-session-context'

/** The existing replica handle, acquired without a snapshot subscription. */
export function useReplica(): import('@podium/client-core/replica').Replica {
  return useCoreReplica()
}

/** The server this app is talking to, e.g. `https://podium.example.com`. */
export function useHttpOrigin(): string {
  return useCoreHttpOrigin()
}

export function useTrpc(): MobileTrpc {
  return useRequestClient<MobileTrpc>()
}

/** The app-wide transport hub; terminal views share it instead of opening a
 *  second socket. */
export function useHub(): SocketHub {
  return useSocketHub()
}

/** ONE UI persistence mechanism: the replica's per-principal ui-state
 *  collection. No screen writes raw AsyncStorage (doc §3.3 / POD-329). */
export function useUiState(): RoutedUiState {
  return useDeviceState()
}

/**
 * Transport liveness, as six mobile surfaces ask for it: the LiveStore's
 * connection condition (POD-5798). Connected means the link is up and
 * answering, slowly or not; the first dial and a link declared lost are not.
 * The hub's health rule decides "lost", so a quick reconnect does not flicker
 * an offline banner.
 *
 * Demo mode reports connected because there is no socket at all in it: the
 * fixture store is the whole world, and painting an offline banner over a design
 * fixture would be reporting a fact about a server nobody asked it to reach.
 */
export function useConnected(): boolean {
  const connected = useLiveValue(isLinkUp)
  return demoEnabled() ? true : connected
}

const isLinkUp = (live: LiveStore): boolean =>
  live.connection.state === 'online' || live.connection.state === 'degraded'

/** The server's build, from the newest `welcome` (LiveStore, POD-5798). */
export function useServerBuild(): string | undefined {
  return useLiveValue(serverBuildOf)
}

const serverBuildOf = (live: LiveStore): string | undefined => live.connection.serverBuild

/**
 * One LiveStore field for a component that is not an observer: re-renders
 * only when `read`'s answer changes. `read` must be a stable function.
 */
function useLiveValue<T>(read: (live: LiveStore) => T): T {
  const live = useClientRuntime<MobileTrpc>().live
  const [value, setValue] = useState(() => read(live))
  useEffect(() => reaction(() => read(live), setValue, { fireImmediately: true }), [live, read])
  return value
}

function poolBooting(pool: MobxPool): boolean {
  if (demoEnabled()) return false
  const reader = omitGone(pool.row('mobileSessionReader', 'reader'))
  return !reader || typeof reader === 'symbol' || reader.booting()
}

/**
 * One opening of the mission a phone route shows. The route's root component
 * owns it: the view model is created for the mission root the selection opens
 * (archived roots included) and closed, with its companions, on unmount.
 * `resolved` keeps the old contract: a root has settled, or the pool is past
 * its boot and the mission is simply not there.
 */
export function useMissionOpening(selectedId: string): {
  screen: MissionScreen | null
  resolved: boolean
} {
  const pool = useMobilePool()
  const uiState = useUiState()
  const uiRef = useRef(uiState)
  uiRef.current = uiState
  const readRoot = useCallback(
    (pool: MobxPool) => missionRootId(pool, selectedId, true),
    [selectedId],
  )
  const rootId = useMobilePoolProjection(readRoot, LOADING)
  const booting = useMobilePoolProjection(poolBooting, true)
  const screen = useMemo(
    () =>
      pool && typeof rootId === 'string'
        ? new MissionScreen(pool, rootId, {
            setPreference: (key, raw) => uiRef.current.set(key, raw),
          })
        : null,
    [pool, rootId],
  )
  useEffect(() => {
    if (!screen) return
    return () => screen.close()
  }, [screen])
  // An archived member can still own the current conversation. Its live
  // crew is a shown field even though the deck's visible rows have settled.
  const ready = Boolean(screen?.ready && settled(() => screen.crew) !== LOADING)
  return { screen, resolved: ready || (!screen && rootId !== LOADING && !booting) }
}

/** One page of a session transcript, newest-first, as both transcript readers
 *  (session chat, superagent) ask for it. A shared call shape rather than a
 *  derivation — the paging arguments must not drift between the two. */
export function readTranscriptPage(
  trpc: MobileTrpc,
  sessionId: SessionId,
  anchor?: string,
): Promise<TranscriptPage> {
  return trpc.sessions.transcriptRead.query({
    sessionId,
    ...(anchor ? { anchor } : {}),
    direction: 'before',
    limit: 80,
  })
}
