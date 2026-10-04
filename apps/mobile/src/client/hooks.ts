/** Phone reads use the shared pool; actions and transport handles retain
 * their existing owner and API. Missing pool facts retain loading values. */
import type { Store } from '@podium/client-core/engine'
import { useStoreHandle } from '@podium/client-core/react'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { FlightDeckMode } from '@podium/client-core/viewmodels'
import type { MissionViewValues } from '@podium/client-graph/mission-view'
import {
  EMPTY_MOBILE_MISSION,
  EMPTY_MOBILE_TASKS,
  type MobileMissionData,
  type MobileTasksData,
  type MobileTasksOptions,
} from '@podium/client-graph/mobile-screens-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import type { SessionId } from '@podium/model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { mobilePaintNow } from '../lib/work-sections'
import { demoEnabled } from './demoData'
import { useMobilePoolProjection } from './mobile-pool'
import type { MobileTrpc, TranscriptPage } from './trpc'

export {
  useSessionContextBooting as useBooting,
  useSessionContextDraft as useSessionDraft,
  useSessionContextIssue as useIssue,
  useSessionContextIssues as useIssues,
  useSessionContextSession as useSession,
  useSessionContextSessions as useSessions,
  useSessionContextSpawnPending as useSpawnPending,
  useSessionContextSpawnPrompt as useSpawnPrompt,
} from './use-session-context'

/** The pool clock tracks forward advances and rewinds at the displayed boundary. */
export function useCoarseNow(): number {
  return useMobilePoolProjection(mobilePaintNow, 0)
}

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
  return useMemo(() => pickActions(owner.getSnapshot()), [owner])
}

/** The existing replica handle, acquired without a snapshot subscription. */
export function useReplica(): MobileStore['replica'] {
  return useStoreHandle<MobileTrpc>().getSnapshot().replica
}

/** The server this app is talking to, e.g. `http://ludovico:18787`. */
export function useHttpOrigin(): string {
  return useStoreHandle<MobileTrpc>().getSnapshot().httpOrigin
}

export function useTrpc(): MobileTrpc {
  return useStoreHandle<MobileTrpc>().getSnapshot().trpc
}

/** The app-wide transport hub; terminal views share it instead of opening a
 *  second socket. */
export function useHub(): SocketHub {
  return useStoreHandle<MobileTrpc>().getSnapshot().hub
}

/** ONE UI persistence mechanism: the replica's per-principal ui-state
 *  collection. No screen writes raw AsyncStorage (doc §3.3 / POD-329). */
export function useUiState(): RoutedUiState {
  return useStoreHandle<MobileTrpc>().getSnapshot().uiState
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
  const reader = pool.row('mobileSessionReader', 'reader')
  return !reader || typeof reader === 'symbol' || reader.booting()
}

type TasksRead = MobileTasksData & { booting: boolean }
const EMPTY_TASKS_READ: TasksRead = { ...EMPTY_MOBILE_TASKS, booting: true }
export function useTaskScreenData(options: MobileTasksOptions): TasksRead {
  const read = useCallback(
    (pool: MobxPool): TasksRead => {
      const reader = pool.row('mobileScreenReader', 'reader')
      if (!reader || typeof reader === 'symbol') return EMPTY_TASKS_READ
      const data = reader.tasks(options)
      return typeof data === 'symbol' ? EMPTY_TASKS_READ : { ...data, booting: poolBooting(pool) }
    },
    [options],
  )
  return useMobilePoolProjection(read, EMPTY_TASKS_READ)
}

type MissionRead = MobileMissionData & { resolved: boolean }
const EMPTY_MISSION_READ: MissionRead = { ...EMPTY_MOBILE_MISSION, resolved: false }
export function useMissionScreenData(id: string): MissionRead {
  const read = useCallback(
    (pool: MobxPool): MissionRead => {
      const reader = pool.row('mobileScreenReader', 'reader')
      if (!reader || typeof reader === 'symbol') return EMPTY_MISSION_READ
      const data = reader.mission(id)
      return typeof data === 'symbol'
        ? EMPTY_MISSION_READ
        : {
            ...data,
            resolved: data.root !== undefined || !poolBooting(pool),
          }
    },
    [id],
  )
  return useMobilePoolProjection(read, EMPTY_MISSION_READ)
}

const EMPTY_DECK: MissionViewValues = {
  root: undefined,
  rows: [],
  members: new Set(),
  byId: new Map(),
  sessions: [],
  archivedCount: 0,
  titles: new Map(),
  progress: EMPTY_MOBILE_MISSION.progress,
  departures: [],
  continuation: null,
  note: null,
  presence: null,
  rowPresentation: new Map(),
}
/** The details deck's mode is local UI state; the addressed pool reader owns
 * its rows, state words, notes, continuation and departures. */
export function useMissionDeckData(id: string, mode: FlightDeckMode): MissionViewValues {
  const read = useCallback(
    (pool: MobxPool) => {
      const reader = pool.row('mobileScreenReader', 'reader')
      if (!reader || typeof reader === 'symbol') return EMPTY_DECK
      const data = reader.deck(id, mode)
      return typeof data === 'symbol' ? EMPTY_DECK : data
    },
    [id, mode],
  )
  return useMobilePoolProjection(read, EMPTY_DECK)
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
