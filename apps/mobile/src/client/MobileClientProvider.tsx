import {
  createDemoReplica,
  DEMO_PRINCIPAL,
  DEMO_SUPER_SESSION,
  DEMO_TRANSCRIPTS,
  demoEnabled,
  publishDemoSlice,
} from '@podium/client-core/demo'

/**
 * THE MOBILE COMPOSITION ROOT — bootstrap, and nothing else (POD-332).
 *
 * The Expo app runs the SAME `StoreProvider` as the web (replica-backed entity
 * reads, outboxed optimistic mutations), so a cold offline start paints from
 * local data and offline writes replay on reconnect.
 *
 * READ PATH (POD-1241): KernelReplica + HTTP sources and the live WebSocket feed,
 * with entity rows in SqliteSyncStore. WRITE PATH (POD-1220 durable, POD-2073
 * kernel-driven): the queue's rows have been in SQLite since POD-1220, and the
 * state machine over them is now the kernel `Outbox` the web app runs — see
 * `openKernelEngineOutbox` below. AsyncStorage holds only side-cache
 * (ui-state, transcript windows), and small
 * pre-replica app metadata (server profiles, cleanup intents, credential id
 * registry) — never authoritative per-user state, which is replicated rows
 * read through the same slices and commands as the web (doc §3.3, POD-1076).
 *
 * WHAT THIS FILE STOPPED BEING. It used to also publish `MobileClientValue`: a
 * 55-field object rebuilt in one `useMemo` with a 27-entry dependency array,
 * re-exporting store fields under mobile-local names and re-deriving on the
 * phone what the web read from a published slice. It is deleted. Screens read
 * the existing pool through `./hooks` and the screen readers. Store handles
 * still supply the original actions and transport ownership.
 *
 * Three facts survive that a store cannot answer — a fatal error, a storage
 * degradation notice, and this principal's local erase. They live in `./shell`,
 * which says why each one cannot come from a snapshot.
 *
  * Demo mode (`?demo=1`) is now a REAL store over a kernel-backed facade seeded
  * with the fixtures (POD-5277), rather than a second hand-written value object: the design
  * surface therefore exercises the same pool readers as the product.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import { type CreateEngineOutbox, OUTBOX_COMMANDS } from '@podium/client-core/engine'
import { profileServerIdentity } from '@podium/client-core/accounts'
import {
  browserWakeSource,
  createFeedRelay,
  type FeedBroadcastChannelFactory,
  observeLiveConnection,
} from '@podium/client-core/live-connection'
import {
  browserFollowAdopt,
  type FollowEvent,
  type FollowPorts,
  followHub,
  type ServerIdentity,
} from '@podium/client-core/server-follow'
import { CONNECT_DEFAULT_BASE_URL } from '@podium/protocol/server-locate'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  isTranscriptWindowStorageKey,
  parseReplicaNamespaceKey,
  REPLICA_KEY_PREFIX,
  type Replica,
  type StorageApi,
} from '@podium/client-core/replica'
import {
  classifyAuthStatus,
  openReplicaAssembly,
  type ReplicaDataStore,
  type ReplicaFailure,
  ReplicaGateError,
  STORE_REFRESH_NOTICE,
  startReplicaBoot,
} from '@podium/client-core/replica-assembly'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { FeedSinkPort } from '@podium/client-core/socket-transport'
import type { HttpSyncSourceDeps } from '@podium/client-core/sync-stream'
import { createLogger } from '@podium/logger'
import { asUserId, type SessionId } from '@podium/model'
import type { LegacyIdentityEvidence } from '@podium/client-core/replica-assembly'

export { BOOT_STALL_MS, STORE_REFRESH_NOTICE } from '@podium/client-core/replica-assembly'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { setClockWakeSource } from '@podium/mobx-helpers'
import { platformClockWakeSource } from './clock-wake-source'
import { BootSplash } from '../components/BootSplash'
import { BootTroubleScreen } from '../components/BootTroubleScreen'
import { mobileAccountCredentials } from './account-credentials'
import { checkLiveAuth, fetchAuthStatus } from './auth'
import { useAuthStatus } from './auth-context'
// From `./launch-ready`, not `./launch`: the boundary itself imports
// expo-router's SplashScreen, and the composition root has no business pulling
// the router in just to report that its boot failed.
import { LaunchReadyView } from './launch-ready'
import { MobileSyncBoundary } from './MobileSyncBoundary'
import { openMobileEntityStore } from './mobile-entity-store'
import { mobileVersionObservers } from './mobile-live-connection'
import { installMobileMetadataStorage } from './mobile-metadata-storage'
import { attachMobilePool, useMobilePool } from './mobile-pool'
import { createMobileSyncFetch } from './mobile-sync-fetch'
import { MobileSyncProgressStore } from './mobile-sync-progress'
import { type NativeConnectivity, nativeClientSeams } from './native-connectivity'
import { makePlatformSocketLogin } from './native-websocket'
import { createPlatformConnectivity } from './platform-connectivity'
import { platformFeedChannel } from './platform-feed-channel'
import { useOptionalServerProfile } from './ServerProfileGate'
import {
  completePendingProfileCleanup,
  loadPendingProfileCleanups,
  type PendingProfileCleanup,
} from './server-profiles'
import type { MobileShell, NoticeTone } from './shell'
import { MobileShellSurface, useShellErrorChannel } from './shell-surface'

const log = createLogger('mobile:replica')
const followLog = createLogger('mobile:server-follow')

/** Why the phone is or is not following, for whoever reads the log (POD-5921). */
function logFollowEvent(event: FollowEvent): void {
  if (event.kind === 'miss') followLog.info('server not found elsewhere yet', { ...event.miss })
  else if (event.kind === 'found') followLog.info('server found at a new address', { origin: event.origin })
  else if (event.kind === 'adopted') followLog.info('followed the server', { ...event.move, claimToken: undefined })
  else if (event.kind === 'adopt-failed') followLog.warn('could not follow the server', { err: event.error })
}

import { type MobileTrpc, makeMobileTrpc, readServerConfig } from './trpc'

// App-installation metadata must be available before a principal-scoped replica
// can open. This composition root owns the native dependency and injects it into
// the profile/credential repositories; those record owners never import the
// platform singleton themselves.
installMobileMetadataStorage(AsyncStorage)

// ---------------------------------------------------------------------------
// THE MOBILE REPLICA COMPOSITION ROOT (POD-1220 durable + POD-1241 wire v2)
// ---------------------------------------------------------------------------

/** The SQLite file the durable outbox and entity cache live in. */
export { MOBILE_REPLICA_DB } from './replica-storage-constants'

import { mobileAccountEraser } from './account-data'
import { mobileBrowserAccounts } from './browser-accounts'
import { MOBILE_REPLICA_DB } from './replica-storage-constants'

/** Test-only/legacy fallback. Production passes AuthStatus.userId explicitly; an
 * unattributed pre-identity store is accepted only through the injected gate. */
export const MOBILE_REPLICA_PRINCIPAL = 'default'

/** Re-exported for the tests and callers that named it here. The TABLE now
 *  lives beside `OutboxKinds` in client-core (POD-316) so the web recovery
 *  surface reads the same one — two copies would drift, and the thing that
 *  drifts is which contract a queued write is replayed under. */
export const MOBILE_OUTBOX_COMMANDS = OUTBOX_COMMANDS

export type MobileEntityStore = ReplicaDataStore

export interface MobileReplicaDeps {
  /**
   * Open the durable store. Native injects SQLite; web injects IndexedDB
   * (POD-541). Tests inject a file-backed SQLite the same way as before.
   */
  readonly openStore: () => Promise<MobileEntityStore>
  /**
   * THE AUTHORITY THE QUEUE SENDS TO (POD-2073).
   *
   * A dependency of the ASSEMBLY, not of the provider, because the kernel
   * `Outbox` is opened here: it takes its submit port at construction, and it
   * has to be open before the store mounts so a cold start reads a queue that
   * has already reconciled (a crash mid-send returns to `queued`, an aged entry
   * is already parked) rather than one that reconciles under the first render.
   * Web reaches the same conclusion by the same route — `openKernelAssembly`
   * takes `trpc` for exactly this and nothing else.
   */
  readonly api: PodiumClientApi
  /** Hydrated side-cache home for ui-state and transcript windows. */
  readonly storage: StorageApi
  /** Hydrated AsyncStorage inventory used for namespace retention/erasure. */
  readonly enumerateKeys?: () => string[]
  /** Await write-behind durability, especially before sign-out reloads. */
  readonly flushStorage?: () => Promise<void>
  readonly principal?: string
  /** Authenticated server user. Storage principal may additionally include a server profile. */
  readonly clientPrincipal?: string
  /**
   * Local-only profile removals queued while their server credential was unsafe
   * to use. Completion must remain pending until both storage engines erase.
   */
  readonly pendingPrincipalCleanups?: readonly {
    principal: string
    complete(): Promise<void>
  }[]
  /** WHO THIS DEVICE'S EXISTING QUEUE BELONGS TO — the attribution gate's input.
   *  Injected, never derived here: a gate that supplied its own evidence would be
   *  a gate that always agreed with itself, and a test must be able to present an
   *  unattributable device and observe the REFUSAL. */
  readonly evidence?: LegacyIdentityEvidence
  /**
   * Production HTTP sources. The optional legacy read below keeps the pushed
   * feed test fixtures intact until the programme cutover removes that path.
   */
  readonly httpSync: Pick<HttpSyncSourceDeps, 'origin' | 'streamingFetch'>

  /** Surfaced, never swallowed (ADR 6 D4.4). */
  readonly onDegraded: (message: string, tone?: NoticeTone) => void
  readonly now?: () => number
  readonly broadcastChannelFactory?: FeedBroadcastChannelFactory
  readonly onAuthExpired?: () => void
}

export interface MobileReplica {
  readonly createReplicaFn: import('@podium/client-core/engine').CreateReplicaForPrincipal
  dispose(): Promise<void>
  /** What the engine reads through — the kernel-backed facade. */
  readonly replica: Replica
  /** Wire-v2 feed sink. Supplied WITH the replica; neither half is meaningful alone. */
  readonly feed: FeedSinkPort
  /** Cold-start gate and warm catch-up status, driven from the kernel lifecycle. */
  readonly syncProgress: MobileSyncProgressStore
  /**
   * The engine's write queue: the kernel `Outbox` state machine, already open
   * over this principal's SQLite outbox rows (POD-2073).
   *
   * Handed over as a FACTORY rather than as the queue itself because the engine
   * supplies the half this assembly cannot know — the notices surface, the
   * overlay's applied/dropped callbacks, and the platform connectivity seams —
   * and it may be consumed exactly once, which is what stops two engines from
   * driving one durable queue.
   */
  readonly createOutboxFn: CreateEngineOutbox
  readonly store: MobileEntityStore
  readonly principal: string
  readonly clientPrincipal: string
  /** Drain entity storage and the debounced AsyncStorage side cache. */
  settled(): Promise<void>
  /** Fail-closed sign-out: erase AsyncStorage and SQLite for this principal. */
  erase(): Promise<void>
}

/** Platform adapters and the mobile presentation of the shared assembly. */
export async function openMobileReplica(deps: MobileReplicaDeps): Promise<MobileReplica> {
  const principal = deps.principal ?? MOBILE_REPLICA_PRINCIPAL
  const clientPrincipal =
    deps.clientPrincipal ?? parseReplicaNamespaceKey(principal)?.memberId ?? principal
  const assembly = await openReplicaAssembly({
    ...deps,
    principal,
    clientPrincipal,
    settings: {
      storage: deps.storage,
      enumerateKeys: deps.enumerateKeys ?? (() => []),
      flush: deps.flushStorage,
      basePrefix: REPLICA_KEY_PREFIX,
    },
    onDegraded: (detail) => {
      const report = detail as { kind?: string; notice?: string }
      if (report?.kind === 'store-not-adopted') deps.onDegraded(STORE_REFRESH_NOTICE, 'info')
      else deps.onDegraded(String(detail))
    },
    onAuthExpired: deps.onAuthExpired,
  })
  let relay: ReturnType<typeof createFeedRelay> | undefined
  try {
    if (deps.broadcastChannelFactory)
      relay = createFeedRelay(assembly.feed, {
        principal,
        channelName: `podium.mobile-replica.feed.v1:${MOBILE_REPLICA_DB}`,
        createChannel: deps.broadcastChannelFactory,
      })
  } catch (error) {
    await assembly.dispose()
    throw error
  }
  const erasePrincipalData = async () => {
    relay?.dispose()
    await assembly.erasePrincipalData()
  }
  const dispose = async () => {
    relay?.dispose()
    await assembly.dispose()
  }
  const ownership = mobileAccountEraser.register(principal, { erasePrincipalData, dispose })
  return {
    replica: assembly.replica,
    createReplicaFn: assembly.createReplicaFn,
    feed: relay?.feed ?? assembly.feed,
    syncProgress: new MobileSyncProgressStore(assembly.progress),
    createOutboxFn: assembly.createOutboxFn,
    store: assembly.store,
    principal,
    clientPrincipal,
    settled: assembly.settled,
    erase: erasePrincipalData,
    dispose: ownership.dispose,
  }
}

export function MobileClientProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    setClockWakeSource(platformClockWakeSource)
    return () => setClockWakeSource(undefined)
  }, [])
  if (demoEnabled()) return <DemoProvider>{children}</DemoProvider>
  return <LiveProvider>{children}</LiveProvider>
}

/**
 * `?demo=1` — the design/screenshot surface, over a REAL store (POD-332).
 *
 * It used to be a second hand-written value object implementing the same 55
 * fields with fixtures and no-ops, which meant the demo surface and the product
 * surface could diverge silently: a screen ported to a slice would render from
 * the slice in production and from the fixture object in demo, and only one of
 * them was ever looked at.
 *
  * Now the fixtures are ROWS in the kernel's own vocabulary. A kernel-backed
  * facade (`createDemoReplica` — the same `createKernelReplica` the product
  * assembly hands the pool) is seeded with them and the ordinary
  * `StoreProvider` runs over it, so every screen exercises the same
  * pool readers and the same store actions it does in the
  * product. What is stubbed is only the network: a tRPC surface that answers the
  * handful of reads the fixture flows make and resolves mutations without
  * changing the world.
 *
 * The boot enrichments (repos, pins, tab orders, superagent threads) fail
 * harmlessly against that stub — the engine already runs every one of them
 * detached and swallowed, because a cold offline boot must keep serving the
 * replica instead of a connection error.
 */
function DemoProvider({ children }: { children: ReactNode }) {
  const { error, report: reportError } = useShellErrorChannel()
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(demoTrpc, [])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  // Design-harness states for the two lifecycle treatments. They use the real
  // boundary and remain opt-in so the ordinary fixture keeps representing a
  // fully settled app (`?demo=1&syncDemo=cold|warm`).
  const syncProgress = useMemo(() => {
    const progress = new MobileSyncProgressStore()
    const mode =
      typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('syncDemo')
    if (mode === 'cold') {
      progress.begin('cold')
      progress.noteBootstrapFrame({
        seq: 1,
        last: false,
        changes: Array.from({ length: 638 }),
        totalRows: 1_024,
      })
    } else if (mode === 'warm') {
      progress.begin('stale')
      progress.noteEvent({ type: 'posture', posture: 'healing', previous: 'stale' })
    } else {
      progress.begin('live')
    }
    return progress
  }, [])
  // Publish the seeded slice once the pool has attached (POD-5277): the
  // pool's question indexes build from replica events, and the pool's
  // presence here means its row source has subscribed. StrictMode-safe —
  // re-installing the identical slice is a no-op downstream.
  // (One instance behind the factory: the engine owns construction, and the
  // publisher below reads the same one.)
  const [demoReplica] = useState(createDemoReplica)
  const createReplicaFn = useMemo(() => () => demoReplica, [demoReplica])
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={() => {}}
      principal={asClientPrincipal(DEMO_PRINCIPAL)}
      createReplicaFn={createReplicaFn}
      routerWindow={routerWindow}
      attachRuntime={(runtime) => attachMobilePool(runtime, (cause) => reportError(cause.message))}
    >
      <DemoSlicePublisher replica={demoReplica} />
      <MobileShellSurface value={{ ...DEMO_SHELL, error }}>
        <MobileSyncBoundary store={syncProgress}>{children}</MobileSyncBoundary>
      </MobileShellSurface>
    </StoreProvider>
  )
}

/**
 * Publishes the demo slice's install event once the pool exists. Mounted
 * inside the provider so `useMobilePool` resolves; the pool's presence means
 * its row source has subscribed, so the install's replace batch is observed.
 */
function DemoSlicePublisher({ replica }: { replica: ReturnType<typeof createDemoReplica> }) {
  const pool = useMobilePool()
  const published = useRef(false)
  useEffect(() => {
    if (pool !== null && !published.current) {
      published.current = true
      publishDemoSlice(replica)
    }
  }, [pool, replica])
  return null
}

const DEMO_SHELL: MobileShell = {
  error: null,
  notice: null,
  eraseLocalData: async () => {},
}

/** The stubbed network for demo mode: the reads the fixture flows make, and
 *  mutations that resolve without changing the fixture so screening and
 *  curation flows stay drivable for design review. */
function demoTrpc(): MobileTrpc {
  const noop = async () => {}
  return {
    superagent: {
      // The screen reads this thread's session transcript, so the demo thread
      // must name a session DEMO_TRANSCRIPTS has rows for (POD-344).
      listThreads: {
        query: async () => [
          { id: 'global', kind: 'global' as const, podiumSessionId: DEMO_SUPER_SESSION },
        ],
      },
      sendTurn: { mutate: async () => ({ threadId: 'global' }) },
      interruptTurn: { mutate: noop },
      clear: { mutate: noop },
    },
    repos: { list: { query: async () => ['/home/dev/src/podium'] } },
    sessions: {
      transcriptRead: {
        query: async ({ sessionId }: { sessionId: SessionId }) => ({
          items: DEMO_TRANSCRIPTS[sessionId] ?? [],
          hasMore: false,
        }),
      },
      sendText: { mutate: noop },
      answerAskUserQuestion: { mutate: noop },
      // The working demo sessions draw Stop; a press must land, not read "Not stopped".
      interrupt: { mutate: async () => ({ ok: true }) },
    },
    issues: {
      promote: { mutate: async () => ({}) },
      start: { mutate: async () => ({}) },
      close: { mutate: async () => ({}) },
      update: { mutate: noop },
      addComment: { mutate: noop },
      panelApply: { mutate: async () => ({}) },
      clearNeedsHuman: { mutate: noop },
      archive: { mutate: noop },
    },
  } as unknown as MobileTrpc
}

/** The same connection observers as web, with the phone's platform plugs. */
function MobileHubAttach({
  connectivity,
  networkEnabled,
  onDisconnected,
  httpOrigin,
  bearer,
  onVersionNotice,
  follow,
}: {
  connectivity: NativeConnectivity | undefined
  networkEnabled: boolean
  onDisconnected: () => void
  httpOrigin: string
  bearer: string | null
  onVersionNotice: (message: string) => void
  /** How this client follows a moved server (POD-5921); absent in demo mode. */
  follow: FollowPorts | undefined
}): null {
  const hub = useStoreHandle<MobileTrpc>().access.hub
  useEffect(() => {
    if (!follow) return
    return followHub(hub, follow, {
      connectBaseUrl: () => CONNECT_DEFAULT_BASE_URL,
      log: logFollowEvent,
    })
  }, [follow, hub])
  useEffect(() => {
    const version = mobileVersionObservers({
      credentials: mobileAccountCredentials,
      fetchVersion: async () => {
        const browser = mobileAccountCredentials.delivery === 'browser'
        const response = await fetch(`${httpOrigin}/version`, {
          credentials: browser ? 'include' : 'omit',
          headers: !browser && bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
        })
        return await response.json()
      },
      report: onVersionNotice,
    })
    const stop = observeLiveConnection(hub, {
      connectivity,
      wakeSource: Platform.OS === 'web' ? browserWakeSource() : undefined,
      onDisconnected,
      onWireSkew: version.onWireSkew,
      onReconnect: networkEnabled ? version.onReconnect : undefined,
    })
    return () => {
      stop()
      version.dispose()
    }
  }, [connectivity, hub, networkEnabled, onDisconnected, httpOrigin, bearer, onVersionNotice])
  return null
}

function LiveProvider({ children }: { children: ReactNode }) {
  const serverProfile = useOptionalServerProfile()
  const legacyConfig = useMemo(readServerConfig, [])
  const config = serverProfile?.config ?? legacyConfig
  const profileId = serverProfile?.profile.id ?? 'legacy'
  const bearer = serverProfile?.bearer ?? null
  const activation = serverProfile?.activation ?? 'verified'
  const revalidateOfflineProfile = serverProfile?.revalidateOfflineProfile
  const updateCredential = serverProfile?.updateCredential
  const recordUser = serverProfile?.recordUser
  const recordUserRef = useRef(recordUser)
  recordUserRef.current = recordUser
  // THE PHONE'S OWN SENSES (POD-2055 F4). AppState and NetInfo, adapted to the
  // seams the shared client already has; `undefined` on web, where the DOM
  // answers those questions itself. Built once for the life of the provider —
  // it holds two OS subscriptions, so a rebuild per render would leak them.
  const connectivity = useMemo(() => createPlatformConnectivity(), [])
  useEffect(() => () => connectivity?.dispose(), [connectivity])
  const { error, report: reportError, notices } = useShellErrorChannel()
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null)
  // FOLLOWING A MOVED SERVER (POD-5921). Native: the identity lives on the
  // saved profile and a move is the SAME profile at the new origin, so the
  // SecureStore bearer comes along. Web: the page came from the server, so the
  // identity is kept in memory and a move is a navigation (the session cookie
  // cannot follow; the person signs in there).
  const serverProfileRef = useRef(serverProfile)
  serverProfileRef.current = serverProfile
  const followPorts = useMemo<FollowPorts>(() => {
    if (Platform.OS === 'web') {
      let identity: ServerIdentity | undefined
      return {
        loadIdentity: () => identity,
        saveIdentity: (next) => {
          identity = next
        },
        adopt: browserFollowAdopt({
          location: window.location,
          notify: (message) => setNotice({ message, tone: 'info' }),
        }),
      }
    }
    return {
      loadIdentity: () => {
        const profile = serverProfileRef.current?.profile
        return profile ? profileServerIdentity(profile) : undefined
      },
      saveIdentity: (identity) => {
        void serverProfileRef.current?.saveServerIdentity?.(identity).catch((cause: unknown) => {
          followLog.warn('could not save the server identity', { err: cause })
        })
      },
      adopt: async (move) => {
        const moveServer = serverProfileRef.current?.moveServer
        if (!moveServer) throw new Error('no saved server profile to move')
        // A transfer's claim token is for a browser session; the phone's own
        // bearer lives in the moved database and keeps working (POD-5921).
        await moveServer(move.origin)
        setNotice({ message: `Podium moved to ${new URL(move.origin).host}`, tone: 'info' })
      },
    }
  }, [])
  const authExpiryHandled = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different credential or workspace resets expiry handling
  useEffect(() => {
    authExpiryHandled.current = false
  }, [bearer, config.httpOrigin, config.workspaceId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new credential needs a fresh expiry handler
  const expireLiveCredential = useCallback(() => {
    if (!updateCredential || authExpiryHandled.current) return
    authExpiryHandled.current = true
    void updateCredential(null).catch((cause: unknown) => {
      authExpiryHandled.current = false
      reportError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [bearer, updateCredential, reportError])
  // biome-ignore lint/correctness/useExhaustiveDependencies: profile identity changes must replace the verification callback
  const verifyLiveCredential = useCallback(() => {
    if (activation === 'offline-cache') {
      void revalidateOfflineProfile?.().catch((cause: unknown) => {
        reportError(cause instanceof Error ? cause.message : String(cause))
      })
      return
    }
    if (!bearer || authExpiryHandled.current) return
    void checkLiveAuth(config.httpOrigin, bearer, config.workspaceId).then((result) => {
      if (result.kind === 'expired') expireLiveCredential()
    })
  }, [
    activation,
    bearer,
    config.httpOrigin,
    config.workspaceId,
    config.workspaceSlug,
    expireLiveCredential,
    reportError,
    revalidateOfflineProfile,
  ])
  const trpc = useMemo(
    () =>
      makeMobileTrpc(
        config.httpOrigin,
        bearer,
        expireLiveCredential,
        config.workspaceId
          ? { workspaceId: config.workspaceId }
          : config.workspaceSlug
            ? { workspaceSlug: config.workspaceSlug }
            : undefined,
      ),
    [bearer, config.httpOrigin, config.workspaceId, config.workspaceSlug, expireLiveCredential],
  )
  const inheritedAuthStatus = useAuthStatus()
  const clientSeams = nativeClientSeams(connectivity)
  const transportSeams =
    activation === 'offline-cache'
      ? {
          visibility: clientSeams.visibility,
          heartbeatIntervalMs: clientSeams.heartbeatIntervalMs,
          isOnline: () => false,
        }
      : clientSeams
  const networkEnabled = activation !== 'offline-cache'
  const makeSocket = useMemo(
    () =>
      makePlatformSocketLogin({
        credentials: mobileAccountCredentials,
        httpOrigin: config.httpOrigin,
        bearer: () => bearer,
      }),
    [bearer, config.httpOrigin],
  )
  const reportVersionNotice = useCallback(
    (message: string) => setNotice({ message, tone: 'warning' }),
    [],
  )
  // AsyncStorage is Promise-only; hydrate the side-cache bridge before the store
  // boots. The migration and SQLite open then run BEFORE the store answers a
  // read and the app does not paint until they resolve — a replica read mid-
  // migration would show a slice that is about to be retired.
  const [openedReplica, setOpenedReplica] = useState<MobileReplica | null>(null)
  // THE BOOT'S FAILURE SURFACE (POD-712). Without these two, a boot that threw
  // and a boot that was merely slow both rendered `null`, which the launch
  // boundary above shows as the wordmark splash — forever, and identically.
  const [bootFailure, setBootFailure] = useState<string | null>(null)
  const [bootCause, setBootCause] = useState<ReplicaFailure | null>(null)
  const [bootStalled, setBootStalled] = useState(false)
  // Bumped to run the effect again: the Retry button on a failed boot.
  const [bootAttempt, setBootAttempt] = useState(0)
  const retryBoot = useCallback(() => {
    setBootFailure(null)
    setBootCause(null)
    setBootStalled(false)
    setOpenedReplica(null)
    setBootAttempt((n) => n + 1)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `bootAttempt` is not read in the body — it IS the retry, the one thing that makes this effect run a second time after a failed or abandoned boot
  useEffect(() => {
    // MOUNT LIVENESS, AND NOTHING ELSE. `pagehide` used to clear this same flag
    // (ee02d6331), which conflated "this component went away" with "the page was
    // backgrounded" — two different facts with opposite correct responses. A
    // pagehide mid-boot therefore made the resolved replica close itself and
    // skip `setOpenedReplica`, and since the effect's deps never changed there
    // was no path back: the splash stayed up for the life of the page.
    let replicaForCleanup: MobileReplica | null = null
    const onPageHide = () => {
      void replicaForCleanup
        ?.settled()
        .catch((cause) => log.warn('replica flush failed', { cause }))
    }
    if (Platform.OS === 'web') window.addEventListener('pagehide', onPageHide)
    const stopBoot = startReplicaBoot({
      open: async () => {
        if (Platform.OS === 'web')
          await mobileBrowserAccounts(
            config.httpOrigin,
            config.workspaceId,
            config.workspaceSlug,
          ).drain()
        const [bridge, status, pendingCleanups] = await Promise.all([
          createAsyncStorageReplicaStorage(AsyncStorage, [REPLICA_KEY_PREFIX], {
            coalesce: isTranscriptWindowStorageKey,
          }),
          inheritedAuthStatus ?? fetchAuthStatus(config.httpOrigin, bearer, config.workspaceId),
          Platform.OS === 'web' ? Promise.resolve([]) : loadPendingProfileCleanups(),
        ])
        const identity = classifyAuthStatus(status)
        if (!('principal' in identity))
          throw new ReplicaGateError('authenticated replica identity is unavailable', identity)
        const opened = await openMobileReplica({
          // POD-541: web uses IndexedDB (ADR 6 D1). expo-sqlite's OPFS worker
          // times out under Chromium even with COOP/COEP + correct wasm MIME, so
          // the replica degraded to memory-only and offline deep links lost the
          // task. Native keeps SQLite.
          //
          // POD-1746 reached the OPFS timeout from the other side and found two
          // upstream bugs behind it (see patches/expo-sqlite@57.0.1.patch): the
          // worker was constructed from an unresolved URL, and the sync bridge
          // wrote its length prefix through a misaligned Uint32Array. That patch
          // and the async open/delete plumbing in SqliteSyncStore are merged but
          // NOT wired here — ADR 6 D2's reversal condition asks for a spike that
          // passes, and this one has not been run against the current tree.
          // Flipping web back to SQLite means changing the web platform module
          // to async open/delete; keeping that experiment outside this
          // composition root also keeps each shipped bundle on one engine.
          openStore: () =>
            openMobileEntityStore(MOBILE_REPLICA_DB, (cause) =>
              setNotice({
                message: `Offline changes may not survive a restart on this device (${cause}).`,
                tone: 'warning',
              }),
            ),
          // The same client the store gets, so the queue sends through the
          // transport the rest of the app is authenticated on (POD-2073).
          api: trpc,
          broadcastChannelFactory: platformFeedChannel(),
          storage: bridge.storage,
          enumerateKeys: bridge.keys,
          flushStorage: bridge.flushDurable,
          // Re-pairing changes the credential handle, not the server-authored replica identity.
          principal: identity.principal,
          clientPrincipal: status.memberId,
          onAuthExpired: expireLiveCredential,
          pendingPrincipalCleanups: pendingCleanups.map((cleanup: PendingProfileCleanup) => ({
            principal: cleanup.principal,
            complete: () => completePendingProfileCleanup(cleanup),
          })),
          httpSync: {
            origin: config.httpOrigin,
            streamingFetch: createMobileSyncFetch(
              bearer,
              undefined,
              config.workspaceId
                ? { workspaceId: config.workspaceId }
                : config.workspaceSlug
                  ? { workspaceSlug: config.workspaceSlug }
                  : undefined,
            ),
          },
          onDegraded: (message, tone) => setNotice({ message, tone: tone ?? 'warning' }),
        })
        try {
          await recordUserRef.current?.(status.memberId!, {
            syncBoundaryId: status.syncBoundaryId!,
            memberId: status.memberId!,
          })
        } catch (error) {
          await opened.dispose()
          throw error
        }
        return opened
      },
      dispose: (replica) => replica.dispose(),
      onCleanupError: (cause) => log.warn('replica cleanup failed', { cause }),
      onState: (state) => {
        if (state.status === 'ready') {
          replicaForCleanup = state.value
          setOpenedReplica(state.value)
          setBootFailure(null)
          setBootCause(null)
          setBootStalled(false)
        } else if (state.status === 'failed') {
          setBootFailure(state.failure)
          setBootCause(state.cause)
          setBootStalled(false)
        } else {
          setOpenedReplica(null)
          setBootFailure(null)
          setBootCause(null)
          setBootStalled(state.status === 'stalled')
        }
      },
    })
    return () => {
      stopBoot()
      replicaForCleanup = null
      if (Platform.OS === 'web') window.removeEventListener('pagehide', onPageHide)
    }
  }, [
    bearer,
    config.httpOrigin,
    config.workspaceId,
    config.workspaceSlug,
    expireLiveCredential,
    profileId,
    trpc,
    inheritedAuthStatus,
    bootAttempt,
    retryBoot,
  ])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  // The engine's `notices` come from the same channel as `reportError` above: one
  // error on screen at a time, drawn by the banner `MobileShellSurface` mounts
  // over every route (POD-4662). See ./shell-surface.
  // The three composition-root facts no store snapshot can answer. Memoized on
  // the values themselves so a shell consumer re-renders when one MOVES and not
  // when the provider re-renders for another reason (see ./shell).
  const erase = openedReplica?.erase
  const shell = useMemo<MobileShell>(
    () => ({
      error,
      notice: notice === null ? null : { ...notice, dismiss: () => setNotice(null) },
      eraseLocalData: erase ?? (async () => {}),
    }),
    [error, notice, erase],
  )
  // A boot that failed, or one the watchdog says has been going too long, is
  // wrapped in LaunchReadyView so the launch boundary RETIRES the splash and
  // reveals it. Returning null here (the only option before POD-712) left the
  // wordmark shimmering over a boot that was never coming back.
  if (!openedReplica && (bootFailure !== null || bootStalled)) {
    return (
      <LaunchReadyView>
        <BootTroubleScreen
          kind={bootFailure !== null ? 'failed' : 'stalled'}
          detail={bootFailure}
          cause={bootCause ?? undefined}
          onRetry={retryBoot}
        />
      </LaunchReadyView>
    )
  }
  // LaunchBoundary stays mounted above auth + replica assembly. A null subtree
  // here leaves that one branded transition in place instead of remounting it.
  if (!openedReplica) {
    // The first attempt is covered by LaunchBoundary's one branded splash.
    // A retry starts only after that boundary has intentionally retired it to
    // show BootTroubleScreen, so it needs its own visible loading surface rather
    // than dropping the user onto an empty root while storage reopens.
    return bootAttempt === 0 ? null : (
      <LaunchReadyView>
        <BootSplash label="RETRYING" />
      </LaunchReadyView>
    )
  }
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={reportError}
      notices={notices}
      // The principal the auth status named, and the store opened for exactly
      // it. The factory REFUSES any other principal rather than handing back
      // the store it happens to hold: on a shared device that would give one
      // account another's slice and cursor (POD-404).
      principal={asClientPrincipal(
        asUserId(openedReplica.clientPrincipal),
        parseReplicaNamespaceKey(openedReplica.principal)?.syncBoundaryId,
      )}
      createReplicaFn={openedReplica.createReplicaFn}
      // Wire v2 advertisement + frame sink (POD-1241). Providing this is how
      // the hub sends wireVersion and receives feedDelta/feedBootstrap/…
      feed={openedReplica.feed}
      // The kernel write queue, already open over this principal's SQLite rows
      // (POD-2073). Without this the engine would build its own compatibility
      // queue over `replica.outboxStorage()` — which on this path is the side
      // cache, i.e. AsyncStorage — and the durable rows in SQLite would have no
      // driver at all: every queued offline write invisible and unsent.
      createOutboxFn={openedReplica.createOutboxFn}
      // The MobX pool over THIS runtime and replica (POD-4976). It builds
      // nothing unless the device setting was on at the first attachment of
      // this app load; StoreProvider releases it before the runtime goes, so a
      // sign-out or user switch disposes it with the signed-in user's store.
      attachRuntime={(runtime) => attachMobilePool(runtime, (cause) => reportError(cause.message))}
      networkEnabled={networkEnabled}
      makeSocket={makeSocket}
      routerWindow={routerWindow}
      // Visibility, connectivity and ping cadence, from the platform rather
      // than from browser globals a phone does not have (POD-2055 WP-C).
      // Empty on web, which keeps every DOM default.
      {...transportSeams}
    >
      <MobileHubAttach
        connectivity={connectivity}
        networkEnabled={networkEnabled}
        onDisconnected={verifyLiveCredential}
        httpOrigin={config.httpOrigin}
        bearer={bearer}
        onVersionNotice={reportVersionNotice}
        follow={followPorts}
      />
      <MobileShellSurface value={shell}>
        <MobileSyncBoundary
          store={openedReplica.syncProgress}
          onRetry={openedReplica.syncProgress.retry}
        >
          {children}
        </MobileSyncBoundary>
      </MobileShellSurface>
    </StoreProvider>
  )
}
