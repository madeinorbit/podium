import { omitGone } from '@podium/client-graph/lookup'
/** Phone reads use the shared pool; actions and transport handles retain
 * their existing owner and API. Missing pool facts retain loading values. */
import type { Store } from '@podium/client-core/engine'
import { useStoreHandle } from '@podium/client-core/react'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { MobxPool } from '@podium/client-graph/pool'
import type { SessionId } from '@podium/model'
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

type MobileStore = Store<MobileTrpc>

/**
 * THE MUTATION SURFACE the phone's screens use, picked once. Every field is an
 * identity-stable engine action. Acquire them from the current owner without a
 * snapshot subscription; a principal/provider rebuild supplies a new owner.
 */
const pickActions = (s: MobileStore) => ({
  markIssueRead: s.markIssueRead,
  markIssueUnread: s.markIssueUnread,
  setIssueTucked: s.setIssueTucked,
  setIssuePlacement: s.setIssuePlacement,
  updateIssue: s.updateIssue,
  closeIssue: s.closeIssue,
  deleteIssue: s.deleteIssue,
  restoreIssue: s.restoreIssue,
  deferIssue: s.deferIssue,
  undeferIssue: s.undeferIssue,
  setIssueLabels: s.setIssueLabels,
  setSnooze: s.setSnooze,
  clearSnooze: s.clearSnooze,
  setWorkState: s.setWorkState,
  sendChat: s.sendChat,
  resurrectSession: s.resurrectSession,
  continueSession: s.continueSession,
  archiveSession: s.archiveSession,
  killSession: s.killSession,
  dismissOffer: s.dismissOffer,
  spawnDraftAgent: s.spawnDraftAgent,
  refreshSuperThreads: s.refreshSuperThreads,
})

export type StoreActions = ReturnType<typeof pickActions>

export function useStoreActions(): StoreActions {
  const owner = useStoreHandle<MobileTrpc>()
  return useMemo(() => pickActions(owner.access), [owner])
}

/** The existing replica handle, acquired without a snapshot subscription. */
export function useReplica(): MobileStore['replica'] {
  return useStoreHandle<MobileTrpc>().access.replica
}

/** The server this app is talking to, e.g. `http://ludovico:18787`. */
export function useHttpOrigin(): string {
  return useStoreHandle<MobileTrpc>().access.httpOrigin
}

export function useTrpc(): MobileTrpc {
  return useStoreHandle<MobileTrpc>().access.trpc
}

/** The app-wide transport hub; terminal views share it instead of opening a
 *  second socket. */
export function useHub(): SocketHub {
  return useStoreHandle<MobileTrpc>().access.hub
}

/** ONE UI persistence mechanism: the replica's per-principal ui-state
 *  collection. No screen writes raw AsyncStorage (doc §3.3 / POD-329). */
export function useUiState(): RoutedUiState {
  return useStoreHandle<MobileTrpc>().access.uiState
}

function hubIsConnected(hub: SocketHub): boolean {
  return typeof hub.connected === 'boolean'
    ? hub.connected
    : // Compatibility for narrow test/platform hubs that predate the exact
      // connection bit. Production SocketHub always takes the first arm.
      hub.connectionHealth().status !== 'down'
}

/**
 * Transport liveness, as six mobile surfaces ask for it.
 *
 * NOT A SLICE, and not because it has too few consumers. Connection health is
 * stream-plane: ephemeral, blank offline, no durable row, nothing memoized
 * against an entity snapshot — the same reason presence gets its own publisher
 * (doc §3.4). It is read off the hub, which is where it lives.
 *
 * Demo mode reports connected because there is no socket at all in it: the
 * fixture store is the whole world, and painting an offline banner over a design
 * fixture would be reporting a fact about a server nobody asked it to reach.
 */
export function useConnected(): boolean {
  const hub = useHub()
  const [connected, setConnected] = useState(() => hubIsConnected(hub))
  useEffect(() => hub.onConnectionHealth(() => setConnected(hubIsConnected(hub))), [hub])
  return demoEnabled() ? true : connected
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
export function useMissionOpening(selectedId: string): { screen: MissionScreen | null; resolved: boolean } {
  const pool = useMobilePool()
  const uiState = useUiState()
  const uiRef = useRef(uiState)
  uiRef.current = uiState
  const readRoot = useCallback((pool: MobxPool) => missionRootId(pool, selectedId, true), [selectedId])
  const rootId = useMobilePoolProjection(readRoot, LOADING)
  const booting = useMobilePoolProjection(poolBooting, true)
  const screen = useMemo(
    () =>
      pool && typeof rootId === 'string'
        ? new MissionScreen(pool, rootId, { setPreference: (key, raw) => uiRef.current.set(key, raw) })
        : null,
    [pool, rootId],
  )
  useEffect(() => {
    if (!screen) return
    screen.open()
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
