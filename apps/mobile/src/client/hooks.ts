/**
 * THE MOBILE READ SEAM (POD-332) — thin, and deliberately so.
 *
 * `MobileClientValue` is gone. It was a 55-field adapter object rebuilt inside
 * one `useMemo` with a 27-entry dependency array, which meant every screen
 * re-rendered whenever ANY of those 27 moved, and every store field the phone
 * wanted had to be added to a mobile-local interface first. Screens now read
 * the SAME store and the SAME published slices as the web.
 *
 * What is left here is the small amount of typing and naming that is genuinely
 * mobile's: `MobileTrpc` is the phone's tRPC surface (`PodiumClientApi` plus the
 * hand-written extras Metro can afford), so every store read has to be
 * instantiated at that type. Converted screens select their latched pool
 * reader here; their temporary OFF hooks retain the existing derivations.
 *
 * WHAT DOES NOT LIVE HERE, and where it went instead:
 *  - the worklist (sections/rows/pinned/groups) → `worklistSlice` [POD-331]
 *  - machine placement and the see/use/manage verbs → `slices/machines` [§3.1.4]
 *  - superagent threads → `superagentSlice` [POD-330]
 *  - every mutation (rename, snooze, tuck, mark-read, spawn) → store actions
 *  - fatal errors, storage notices, sign-out erase → `./shell`
 */
import type { Store } from '@podium/client-core/engine'
import { recordSliceDerivation } from '@podium/client-core/perf'
import {
  useAllIssueViewModels,
  useHostMetrics as useCoreHostMetrics,
  useIssueViewModel,
  useStore,
  useStoreHandle,
  useStoreSelector,
} from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import {
  confirmedWorkingAgentCountsByIssue,
  type FlightDeckMode,
  missionProgress,
  missionRootFor,
  missionSessions,
} from '@podium/client-core/viewmodels'
import type { MissionViewValues } from '@podium/client-graph/mission-view'
import {
  EMPTY_MOBILE_MISSION,
  EMPTY_MOBILE_TASKS,
  type MobileMissionData,
  type MobileTasksData,
  type MobileTasksOptions,
} from '@podium/client-graph/mobile-screens-schema'
import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, HostMetricsWire, MachineWire, SessionId } from '@podium/model'
import { asIssueId } from '@podium/model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildScreeningQueue } from '../lib/screening'
import { taskBoardProgress, taskBoardSections } from '../lib/task-board'
import { demoEnabled } from './demoData'
import { mobileDataLayer, useMobilePoolProjection } from './mobile-pool'
import type { MobileTrpc, TranscriptPage } from './trpc'

type MobileStore = Store<MobileTrpc>

/** Select only the mobile snapshot fields a consumer uses. */
function useMobileStoreSelector<T>(
  select: (store: MobileStore) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreSelector<T, MobileTrpc>(select, isEqual)
}

export { useMobileStoreSelector as useStoreSelector }

/** The whole snapshot, typed at the phone's tRPC surface. Use a narrower hook
 *  below when one field will do — this one re-renders on any store change.
 *  Reserved for explicit whole-snapshot diagnostics; screens select. */
export function useMobileStore() {
  return useStore<MobileTrpc>()
}

/** Shallow equality for the picked-object hooks below. The picked fields are
 *  the runtime's STATICS — built once and spread unchanged into every snapshot
 *  (`{...state, ...statics}`) — so this always answers "equal" after the first
 *  render and the subscriber never re-renders on a store publish. */
function shallowEqualPick<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  const keys = Object.keys(a) as (keyof T)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

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

/** The coarse shared clock used for stable working/progress projections. */
export function useCoarseNow(): number {
  return useStoreSelector<number, MobileTrpc>((s) => s.coarseNow)
}

/** Connected machines. Array identity moves only on machinesChanged. */
export function useMachines(): MachineWire[] {
  return useStoreSelector<MachineWire[], MobileTrpc>((s) => s.machines)
}

/** Registered repos. Array identity moves only when the registry changes. */
export function useRepos(): GitRepositoryWire[] {
  return useStoreSelector<GitRepositoryWire[], MobileTrpc>((s) => s.repos)
}

/** Latest per-host health frames — the 5s daemon cadence. Only Pulse-grade
 *  surfaces should subscribe to this. */
export function useHostMetrics(): HostMetricsWire[] {
  return useCoreHostMetrics()
}

/** Durable-outbox depth, for the inbox's pending badge. */
export function useOutboxSize(): number {
  return useStoreSelector<number, MobileTrpc>((s) => s.outboxSize)
}

/** The superagent thread the phone renders (in practice 'global'). */
export function useSuperThreadId(): MobileStore['superThreadId'] {
  return useStoreSelector<MobileStore['superThreadId'], MobileTrpc>((s) => s.superThreadId)
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

/** S2 joins the replica homes before publishing this optimistic read view. */
export function useSessions(): SessionView[] {
  return useStoreSelector<SessionView[], MobileTrpc>((s) => s.sessions)
}

/** The runtime's folded sources include normalized optimism and personal markers. */
function useIssueSources() {
  return useMobileStoreSelector(
    (s) => ({
      replica: s.replica,
      issueProjections: s.issueProjections,
      issueUserStates: s.issueUserStates,
    }),
    shallowEqualPick,
  )
}

export function useIssues(): IssueViewModel[] {
  const { replica, issueProjections, issueUserStates } = useIssueSources()
  return useAllIssueViewModels(replica, issueProjections, issueUserStates)
}

/**
 * One issue by id, or undefined.
 *
 * UNDEFINED IS NOT "DELETED" (doc §3.1 ¶2). Under the scoped feed an id can name
 * a row this principal may not see, one that was evicted from their view, or one
 * that simply has not arrived — and a screen must render none of those as a
 * deletion. Callers here show the id inert rather than an error, which is the
 * same choice `resolveIssueEdge`'s `pending` renders on the desktop issue page.
 */
export function useIssue(id: string | undefined): IssueViewModel | undefined {
  const { replica, issueProjections, issueUserStates } = useIssueSources()
  const model = useIssueViewModel(replica, asIssueId(id ?? ''), issueProjections, issueUserStates)
  return id === undefined ? undefined : model
}

export function useSession(id: SessionId | undefined): SessionView | undefined {
  return useStoreSelector<SessionView | undefined, MobileTrpc>((s) =>
    id === undefined ? undefined : s.sessions.find((session) => session.sessionId === id),
  )
}

export function useSessionDraft(id: SessionId): string {
  return useStoreSelector<string, MobileTrpc>((state) => state.drafts[id] ?? '')
}

/**
 * True while this id names a session the server has NOT confirmed yet — an
 * optimistic spawn overlay (#119) with no row behind it.
 *
 * A TERMINAL MUST NOT ATTACH TO ONE (POD-1613). `SocketHub.attach` sends its
 * `attach` frame exactly once, when the connection is constructed, and re-sends
 * it only if the SOCKET reconnects. Attaching to an id the server has never
 * heard of therefore burns the single attempt: the frame is dropped, nothing
 * retries it, and `mountSession`'s ready backstop then reveals a terminal that
 * stays blank forever. The desktop AgentPanel spends the same fact through
 * `panelGates().terminalMounted`; this is the phone's reader for it.
 */
export function useSpawnPending(id: SessionId | undefined): boolean {
  return useStoreSelector<boolean, MobileTrpc>((s) =>
    id === undefined ? false : s.pendingSpawnIds.has(id),
  )
}

/** The first turn painted by the shared spawn optimism engine. The engine owns
 * it until the authoritative session row arrives; the conversation host then
 * keeps it through any settle-time remount until the transcript echoes it. */
export function useSpawnPrompt(id: SessionId | undefined): string | undefined {
  return useStoreSelector<string | undefined, MobileTrpc>((s) =>
    id === undefined ? undefined : s.pendingSpawnPrompts.get(id),
  )
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

/**
 * True while no snapshot has arrived yet — the lists have nothing to show and
 * do not yet know whether they are empty [POD-366].
 *
 * NOT A SLICE, for the same reason `useConnected` is not one: this is a fact
 * about the transport's progress, not a derivation over an entity snapshot. The
 * replica hands out a cursor only once a feed frame has landed, so before that
 * an empty list means "not loaded" rather than "nothing here" — and painting an
 * empty state on a cold start reads as breakage rather than latency. Screens
 * show skeletons on this and keep the empty state for genuinely empty.
 *
 * Demo mode is never booting: the fixture store IS the snapshot.
 */
export function useBooting(): boolean {
  return useStoreSelector<boolean, MobileTrpc>((s) =>
    demoEnabled()
      ? false
      : s.replica.getCursor() === null &&
        s.sessions.length === 0 &&
        s.issueProjections.length === 0,
  )
}

function poolBooting(pool: MobxPool): boolean {
  if (demoEnabled()) return false
  const reader = pool.row('mobileSessionReader', 'reader')
  return !reader || typeof reader === 'symbol' || reader.booting()
}

type TasksRead = MobileTasksData & { booting: boolean }
const EMPTY_TASKS_READ: TasksRead = { ...EMPTY_MOBILE_TASKS, booting: true }
function useLegacyTaskScreenData(options: MobileTasksOptions): TasksRead {
  recordSliceDerivation(useStoreHandle<MobileTrpc>(), 'mobileScreens.tasks')
  const issues = useIssues()
  const sessions = useSessions()
  const booting = useBooting()
  const now = useCoarseNow()
  return useMemo(() => {
    const board = taskBoardSections(issues, { ...options, expanded: new Set(options.expanded) })
    const workingByIssue = confirmedWorkingAgentCountsByIssue(issues, sessions, now)
    return {
      issues,
      sessions,
      booting,
      board,
      workingByIssue,
      progressByIssue: taskBoardProgress(issues, board, workingByIssue),
      proposals: buildScreeningQueue(issues).length,
    }
  }, [issues, sessions, booting, now, options])
}
function usePoolTaskScreenData(options: MobileTasksOptions): TasksRead {
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
/** One startup choice, shared with the mobile pilot; no legacy fallback on ON. */
export function useTaskScreenData(options: MobileTasksOptions): TasksRead {
  const useRead = mobileDataLayer() === 'pool' ? usePoolTaskScreenData : useLegacyTaskScreenData
  return useRead(options)
}

type MissionRead = MobileMissionData & { resolved: boolean }
const EMPTY_MISSION_READ: MissionRead = { ...EMPTY_MOBILE_MISSION, resolved: false }
function useLegacyMissionScreenData(id: string, screen: 'mission' | 'details'): MissionRead {
  recordSliceDerivation(useStoreHandle<MobileTrpc>(), `mobileScreens.${screen}`)
  const issues = useIssues()
  const sessions = useSessions()
  const booting = useBooting()
  return useMemo(() => {
    const root = missionRootFor(issues, asIssueId(id))
    return {
      root,
      issues,
      sessions,
      missionSessions: root ? missionSessions(issues, sessions, root.id) : [],
      progress: missionProgress(issues, sessions, root?.id),
      resolved: root !== undefined || (!booting && issues.length > 0),
    }
  }, [issues, sessions, id, booting])
}
function usePoolMissionScreenData(id: string, _screen: 'mission' | 'details'): MissionRead {
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
function useLegacyMissionDetailsData(id: string, _screen: 'mission' | 'details'): MissionRead {
  recordSliceDerivation(useStoreHandle<MobileTrpc>(), 'mobileScreens.details')
  const issues = useIssues()
  const sessions = useSessions()
  return useMemo(() => {
    const root = missionRootFor(issues, asIssueId(id))
    return {
      root,
      issues,
      sessions,
      missionSessions: root ? missionSessions(issues, sessions, root.id) : [],
      progress: EMPTY_MOBILE_MISSION.progress,
      resolved: root !== undefined,
    }
  }, [issues, sessions, id])
}
export function useMissionScreenData(
  id: string,
  screen: 'mission' | 'details' = 'mission',
): MissionRead {
  const useRead =
    mobileDataLayer() === 'pool'
      ? usePoolMissionScreenData
      : screen === 'details'
        ? useLegacyMissionDetailsData
        : useLegacyMissionScreenData
  return useRead(id, screen)
}

const EMPTY_DECK: MissionViewValues = {
  root: undefined,
  rows: [],
  members: new Set(),
  byId: new Map(),
  sessions: [],
  archived: [],
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
export function usePoolMissionDeckData(id: string, mode: FlightDeckMode): MissionViewValues {
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
