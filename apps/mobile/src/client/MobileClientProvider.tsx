/**
 * Mobile binding for the shared client store (arch-v2 P3, issue #192): the
 * hand-rolled useState metadata layer is gone — the Expo app runs the SAME
 * StoreProvider as the web (replica-backed entity reads, outboxed optimistic
 * mutations) so a cold offline start paints from local data and offline writes
 * replay on reconnect.
 *
 * READ PATH (POD-1241): KernelReplica + FeedAuthorityClient over the v2 feed,
 * with entity rows in SqliteSyncStore. WRITE PATH (POD-1220): the durable
 * outbox binding already on SQLite. AsyncStorage holds only side-cache
 * (ui-state, transcript windows) and the pre-migration legacy bridge.
 *
 * `useMobileClient` keeps its existing shape: it is now a thin adapter over
 * the shared store (mobile-only extras — transcript paging, ask-user answers —
 * ride on the store's hub/trpc). Demo mode (`?demo=1`) stays a static fixture.
 */

import type { SpawnTarget } from '@podium/client-core'
import { OUTBOX_COMMANDS, outboxCommandFor } from '@podium/client-core/engine'
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { asClientPrincipal } from '@podium/client-core/principal'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  createKernelOutboxStorage,
  createKernelReplica,
  createSideCache,
  FeedAuthorityClient,
  FeedSink,
  preparePrincipalNamespace,
  PushedBootstrapSource,
  REPLICA_KEY_PREFIX,
  type Replica,
  type StorageApi,
} from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { FeedSinkPort, SocketHub } from '@podium/client-core/socket-transport'
import type { ServerConfig } from '@podium/client-core/transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { PinState } from '@podium/client-core/viewmodels'
import type {
  AgentKind,
  ConversationSummaryWire,
  GitRepositoryWire,
  IssueWire,
  MachineWire,
  SessionId,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/model'
import { asSessionId } from '@podium/model'
import type { FeedChangesSinceReplyLenient, HeadlessActivityEvent } from '@podium/protocol'
import {
  decideLegacyAdoption,
  LEGACY_STANDALONE_OUTBOX_KEY,
  type LegacyIdentityEvidence,
  type LegacyMigrationOutcome,
  migrateLegacyReplica,
} from '@podium/sync/adapters/legacy-replica'
import {
  fromExpoSqlite,
  type SqlDatabaseLike,
  SqliteSyncStore,
} from '@podium/sync/adapters/mobile-sqlite'
import type { OutboxAttribution, OutboxCommand } from '@podium/sync/outbox'
import { Replica as KernelReplica, type Cursor, type ReplicaEvent } from '@podium/sync/replica'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SQLite from 'expo-sqlite'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { BootSplash } from '../components/BootSplash'
import { fetchAuthStatus } from './auth'
import {
  DEMO_ISSUES,
  DEMO_SESSIONS,
  DEMO_SUPER_SESSION,
  DEMO_TRANSCRIPTS,
  demoEnabled,
} from './demoData'
import { type MobileTrpc, makeMobileTrpc, readServerConfig, type TranscriptPage } from './trpc'

export interface MobileClientValue {
  sessions: SessionMeta[]
  issues: IssueWire[]
  /** Repo registry + pin state — the Work list derives the desktop sidebar's
   *  project groups from exactly these (POD-338). */
  repos: GitRepositoryWire[]
  machines: MachineWire[]
  pins: PinState
  conversations: ConversationSummaryWire[]
  connected: boolean
  cursor: number | null
  error: string | null
  /** Non-fatal things the user is owed (ADR 6 D4.4's never-silent posture):
   *  storage degradation, and queued work a storage migration could not carry
   *  across because it could not be attributed to this account. */
  notice: string | null
  serverConfig: ServerConfig
  /** The app-wide transport hub; terminal views share it instead of opening another socket. */
  hub: SocketHub | null
  trpc: MobileTrpc
  /** Principal-scoped UI preference store; no screen writes raw AsyncStorage. */
  uiState: RoutedUiState
  /** The same optimistic draft-issue launch used by desktop's New Agent control. */
  spawnDraftAgent(args: { target: SpawnTarget; agentKind: AgentKind; firstPrompt?: string }): {
    sessionId: SessionId
    issueId: string
  }
  sessionById(sessionId: SessionId): SessionMeta | undefined
  issueById(issueId: string): IssueWire | undefined
  readTranscript(sessionId: SessionId, anchor?: string): Promise<TranscriptPage>
  subscribeTranscript(
    sessionId: SessionId,
    since: string | undefined,
    cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void
  subscribeHeadless(sessionId: SessionId, cb: (e: HeadlessActivityEvent) => void): () => void
  /** Queue a chat message (offline-safe, idempotent; wakes a parked session). */
  sendMessage(sessionId: SessionId, text: string): Promise<void>
  answerQuestion(sessionId: SessionId, choices: { optionIndices: number[] }[]): Promise<void>
  setArchived(sessionId: SessionId, archived: boolean): Promise<void>
  setWorkState(sessionId: SessionId, workState: WorkState | null): Promise<void>
  killSession(sessionId: SessionId): Promise<void>
  continueSession(sessionId: SessionId): Promise<void>
  renameSession(sessionId: SessionId, name: string): Promise<void>
  snooze(sessionId: SessionId, until: string | null): Promise<void>
  clearSnooze(sessionId: SessionId): Promise<void>
  /** Tuck a finished issue into the Work list's Closed fold, or bring it back
   *  (POD-333): server state, so the fold agrees across every client. */
  setIssueTucked(id: string, tucked: boolean): Promise<void>
  markIssueRead(id: string): Promise<void>
  /** Round-robin triage order: needsYou, then idle, then working. */
  focusSessionIds: string[]
  outboxSize: number
  /** Default sign-out policy: erase this principal's complete local namespace. */
  eraseLocalData(): Promise<void>
}

const MobileClientContext = createContext<MobileClientValue | null>(null)

/** Static fixture client for `?demo=1` — design/screenshot mode, no backend. */
function demoValue(config: ServerConfig): MobileClientValue {
  const sessions = DEMO_SESSIONS
  const groups = groupSessions(withoutShells(sessions))
  const noop = async () => {}
  return {
    sessions,
    issues: DEMO_ISSUES,
    repos: [],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    conversations: [],
    connected: true,
    cursor: null,
    error: null,
    notice: null,
    serverConfig: config,
    hub: null,
    trpc: {
      superagent: {
        // The screen reads this thread's session transcript, so the demo thread
        // must name a session DEMO_TRANSCRIPTS has rows for (POD-344).
        listThreads: {
          query: async () => [
            {
              id: 'global',
              kind: 'global' as const,
              podiumSessionId: DEMO_SUPER_SESSION,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archived: false,
            },
          ],
        },
        history: { query: async () => [] },
        sendTurn: { mutate: async () => ({ threadId: 'global' }) },
        interruptTurn: { mutate: noop },
        clear: { mutate: noop },
      },
      repos: { list: { query: async () => ['/home/dev/src/podium'] } },
      // Demo mode has no backend: issue mutations resolve without changing the
      // fixture, so screening/curation flows are drivable for design review.
      issues: {
        promote: { mutate: async () => ({}) },
        start: { mutate: async () => ({}) },
        close: { mutate: async () => ({}) },
        update: { mutate: noop },
        addComment: { mutate: noop },
        clearNeedsHuman: { mutate: noop },
        archive: { mutate: noop },
      },
    } as unknown as MobileTrpc,
    uiState: {
      get: () => null,
      set: () => undefined,
      subscribe: () => () => undefined,
    },
    spawnDraftAgent: () => ({ sessionId: asSessionId('demo-session'), issueId: 'demo-issue' }),
    sessionById: (id) => sessions.find((s) => s.sessionId === id),
    issueById: (id) => DEMO_ISSUES.find((i) => i.id === id),
    readTranscript: async (sessionId) => ({
      items: DEMO_TRANSCRIPTS[sessionId] ?? [],
      hasMore: false,
    }),
    subscribeTranscript: () => () => {},
    subscribeHeadless: () => () => {},
    sendMessage: noop,
    answerQuestion: noop,
    setArchived: noop,
    setWorkState: noop,
    killSession: noop,
    continueSession: noop,
    renameSession: noop,
    snooze: noop,
    clearSnooze: noop,
    setIssueTucked: noop,
    markIssueRead: noop,
    focusSessionIds: [...groups.needsYou, ...groups.idle, ...groups.working].map(
      (s) => s.sessionId,
    ),
    outboxSize: 0,
    eraseLocalData: noop,
  }
}

// ---------------------------------------------------------------------------
// THE MOBILE REPLICA COMPOSITION ROOT (POD-1220 durable + POD-1241 wire v2)
// ---------------------------------------------------------------------------

/** The SQLite file the durable outbox and entity cache live in. */
export const MOBILE_REPLICA_DB = 'podium-replica.db'

/** Test-only/legacy fallback. Production passes AuthStatus.userId explicitly; an
 * unattributed pre-identity store is accepted only through the injected gate. */
export const MOBILE_REPLICA_PRINCIPAL = 'default'

/** Re-exported for the tests and callers that named it here. The TABLE now
 *  lives beside `OutboxKinds` in client-core (POD-316) so the web recovery
 *  surface reads the same one — two copies would drift, and the thing that
 *  drifts is which contract a queued write is replayed under. */
export const MOBILE_OUTBOX_COMMANDS = OUTBOX_COMMANDS

const resolveMobileCommand = (kind: string): OutboxCommand | undefined => outboxCommandFor(kind)

/**
 * WHICH KEYS THE BRIDGE MUST HYDRATE, and why the default is not enough.
 *
 * `createAsyncStorageReplicaStorage` hydrates `podium.replica*` by default, but the
 * PRE-replica standalone outbox blob is `podium.outbox.v1` — outside that prefix. A
 * device that upgraded straight from a build older than the replica collections has
 * its queued work in exactly that key and nowhere else, so hydrating the default
 * prefix alone would make the migration read an empty store and report success.
 */
export const LEGACY_HYDRATE_PREFIXES = [REPLICA_KEY_PREFIX, LEGACY_STANDALONE_OUTBOX_KEY] as const

/**
 * Empty import plan for the entity-cache attribution decision. The decision and
 * the records are two things `decideLegacyAdoption` returns; only the decision
 * applies here. Re-deriving the rule locally would fork a privacy rule.
 */
const EMPTY_ADOPTION_PLAN = {
  verdict: 'import' as const,
  outbox: [],
  retireKeys: [],
  rejected: [],
  cursorDiscarded: false,
}

export interface MobileReplicaDeps {
  /** The SQLite engine. Injected so a test drives a real file-backed database. */
  readonly openDatabase: () => SqlDatabaseLike
  /** Remove the file, so a poisoned or newer-version store cold-starts instead of
   *  wedging boot (ADR 6 D4.5). The adapter makes this REQUIRED for that reason. */
  readonly deleteDatabase: () => void
  /** The hydrated AsyncStorage bridge: the legacy migration's source AND the
   *  side-cache home for ui-state / transcript windows. */
  readonly storage: StorageApi
  /** Hydrated AsyncStorage inventory used for namespace retention/erasure. */
  readonly enumerateKeys?: () => string[]
  /** Await write-behind durability, especially before sign-out reloads. */
  readonly flushStorage?: () => Promise<void>
  readonly principal?: string
  /** WHO THIS DEVICE'S EXISTING QUEUE BELONGS TO — the attribution gate's input.
   *  Injected, never derived here: a gate that supplied its own evidence would be
   *  a gate that always agreed with itself, and a test must be able to present an
   *  unattributable device and observe the REFUSAL. */
  readonly evidence?: LegacyIdentityEvidence
  /**
   * THE v2 CATCH-UP READ (POD-1241). Bound to `sync.feedChangesSince` in the
   * live provider; tests inject a silent authority that delivers nothing so a
   * cold-start paint assertion cannot be rescued by a live feed.
   */
  readonly fetchChangesSince: (cursor: Cursor) => Promise<FeedChangesSinceReplyLenient>
  /** Surfaced, never swallowed (ADR 6 D4.4). */
  readonly onDegraded: (message: string) => void
  readonly now?: () => number
}

export interface MobileReplica {
  /** What the engine reads through — the kernel-backed facade. */
  readonly replica: Replica
  /** Wire-v2 feed sink. Supplied WITH the replica; neither half is meaningful alone. */
  readonly feed: FeedSinkPort
  /** What the migration did — the caller tells the user (D4.4). */
  readonly outcome: LegacyMigrationOutcome
  readonly store: SqliteSyncStore
  readonly principal: string
  /**
   * Call once the engine's hub exists. A re-bootstrap is a reconnect, so
   * `PushedBootstrapSource` needs `hub.requestFreshWorld()`, and the hub is
   * built FROM this assembly — late binding breaks the cycle.
   */
  attachHub(hub: SocketHub): void
  /** Fail-closed sign-out: erase AsyncStorage and SQLite for this principal. */
  erase(): Promise<void>
}

/**
 * Open the durable store, run the attribution gate, assemble the v2 feed path,
 * and return the replica the engine reads through.
 *
 * POD-1220 landed the durable half: SqliteSyncStore, migrateLegacyReplica, and
 * the SQLite outbox binding. This issue (POD-1241) lands the READ half: the
 * kernel Replica, FeedAuthorityClient, FeedSink, and the facade that projects
 * entity rows into the engine's Replica interface.
 *
 * THE HAZARD THIS ASSEMBLY EXISTS TO CLOSE. Before the wire cutover, pointing
 * the facade at a cache whose frames never arrive painted an EMPTY SLICE on
 * every cold start — indistinguishable from a working offline cold start until
 * you have data. The feed sink is therefore required, and the cold-start test
 * proves rows paint from a populated store when the authority delivers nothing.
 */
export async function openMobileReplica(deps: MobileReplicaDeps): Promise<MobileReplica> {
  const principal = deps.principal ?? MOBILE_REPLICA_PRINCIPAL
  const now = deps.now ?? Date.now
  const store = await SqliteSyncStore.open({
    openDatabase: deps.openDatabase,
    deleteDatabase: deps.deleteDatabase,
    // A degraded store still WORKS — the queue runs in memory and forgets on
    // reload — so this is a notice, not a fatal error. Silence is the one option
    // ADR 6 D4.4 rules out.
    onDegraded: (degradation) =>
      deps.onDegraded(
        `Offline changes may not survive a restart on this device (${degradation.cause}).`,
      ),
  })
  const namespace = preparePrincipalNamespace({
    storage: deps.storage,
    enumerateKeys: deps.enumerateKeys ?? (() => []),
    basePrefix: REPLICA_KEY_PREFIX,
    principal,
    now: deps.now,
  })
  if (!namespace.durable) {
    deps.onDegraded('Offline entity storage is unavailable; this session will stay in memory.')
  }
  for (const stalePrincipal of namespace.evictedPrincipals) {
    await store.erasePrincipal(stalePrincipal)
  }
  const view = store.viewFor(principal)
  const attribution: OutboxAttribution = {
    actor: { kind: 'user', userId: principal },
    onBehalfOf: principal,
  }

  // Default evidence is the per-principal namespace ledger assembled above.
  // A caller may inject unknown/foreign evidence to exercise the refusal arm.
  const evidence: LegacyIdentityEvidence =
    deps.evidence ??
    (namespace.durable
      ? {
          kind: 'multi-user',
          signedInAs: principal,
          identitiesEverSignedIn: namespace.knownPrincipals,
        }
      : { kind: 'unknown' })

  // ---- THE ATTRIBUTION GATE, before a single entity row is read ------------
  //
  // Same rule as web's openKernelAssembly: an unattributable store is discarded
  // and re-bootstrapped, never adopted. The outbox migration below is a separate
  // call that parks unattributable queued work; this one governs the entity
  // cache the cold-start paint reads.
  const adoption = decideLegacyAdoption(EMPTY_ADOPTION_PLAN, evidence, now())
  if (!adoption.adopt) {
    view.cache.discardCache()
    deps.onDegraded(
      `Refreshing from the server after a storage upgrade (${adoption.reason}).`,
    )
  }

  const outcome = await migrateLegacyReplica({
    legacy: deps.storage,
    outbox: view.outbox,
    transact: store.unitOfWork.transact,
    resolveCommand: resolveMobileCommand,
    attribution,
    evidence,
    now,
  })

  const outboxes = await createKernelOutboxStorage({
    outbox: view.outbox,
    resolveCommand: resolveMobileCommand,
    attribution,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  // Side cache: ui-state + transcript windows on the AsyncStorage bridge.
  // Outbox does NOT live here (ADR 6 D1) — it is injected from SQLite below.
  const side = createSideCache({
    storage: deps.storage,
    enumerateKeys: deps.enumerateKeys ?? (() => []),
    keyPrefix: namespace.keyPrefix,
    // Legacy outbox migration already ran above into SQLite; do not also fold
    // a second copy into the side-cache blob store.
    adoptLegacyOutbox: false,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  const facade = createKernelReplica({
    cache: view.cache,
    side,
    outbox: outboxes,
  })

  // ---- WIRE v2 (POD-1241) — the feed that populates entity rows ------------
  let hub: SocketHub | undefined
  let freshWorldPending = false
  const bootstraps = new PushedBootstrapSource({
    requestFreshWorld: () => {
      if (hub === undefined) {
        freshWorldPending = true
        return
      }
      hub.requestFreshWorld()
    },
  })

  const kernel = new KernelReplica({
    store: view.cache,
    authority: new FeedAuthorityClient({
      fetchChangesSince: deps.fetchChangesSince,
      bootstraps,
    }),
    onEvent: (event: ReplicaEvent) => {
      facade.onKernelEvent(event)
    },
  })

  const feed = new FeedSink({ replica: kernel, bootstraps })

  return {
    replica: facade,
    feed,
    outcome,
    store,
    principal,
    attachHub: (attached) => {
      hub = attached
      if (freshWorldPending) {
        freshWorldPending = false
        attached.requestFreshWorld()
      }
    },
    erase: async () => {
      side.dispose()
      namespace.erase()
      await Promise.all([
        store.erasePrincipal(principal),
        deps.flushStorage?.() ?? Promise.resolve(),
      ])
    },
  }
}

export function MobileClientProvider({ children }: { children: ReactNode }) {
  if (demoEnabled()) return <DemoProvider>{children}</DemoProvider>
  return <LiveProvider>{children}</LiveProvider>
}

function DemoProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const value = useMemo(() => demoValue(config), [config])
  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

/**
 * Attach the engine's hub to the mobile assembly (POD-1241).
 *
 * A re-bootstrap is a reconnect, so `PushedBootstrapSource` needs the hub — and
 * the hub is built by the engine FROM the assembly, so it cannot be handed over
 * at construction. This runs inside the provider, where the hub exists.
 */
function MobileHubAttach({ attachHub }: { attachHub: (hub: SocketHub) => void }): null {
  const { hub } = useStore()
  useEffect(() => {
    attachHub(hub)
  }, [attachHub, hub])
  return null
}

function LiveProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(() => makeMobileTrpc(config.httpOrigin), [config.httpOrigin])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // AsyncStorage is Promise-only; hydrate the side-cache bridge before the store
  // boots. The migration and SQLite open then run BEFORE the store answers a
  // read and the app does not paint until they resolve — a replica read mid-
  // migration would show a slice that is about to be retired.
  const [openedReplica, setOpenedReplica] = useState<MobileReplica | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [bridge, status] = await Promise.all([
        createAsyncStorageReplicaStorage(AsyncStorage, LEGACY_HYDRATE_PREFIXES),
        fetchAuthStatus(config.httpOrigin),
      ])
      if (status.userId === null) throw new Error('authenticated account is unavailable')
      // The live server's v2 catch-up. Typed through the hand-written MobileTrpc
      // surface is deliberately loose: the client is createTRPCClient<any>, and
      // PodiumClientApi still only names the v1 changesSince. Runtime has the
      // real procedure; casting here is the same seam web uses.
      const syncV2 = trpc.sync as typeof trpc.sync & {
        feedChangesSince: {
          query: (input: { cursor: Cursor }) => Promise<FeedChangesSinceReplyLenient>
        }
      }
      const opened = await openMobileReplica({
        openDatabase: () => fromExpoSqlite(SQLite.openDatabaseSync(MOBILE_REPLICA_DB)),
        deleteDatabase: () => SQLite.deleteDatabaseSync(MOBILE_REPLICA_DB),
        storage: bridge.storage,
        enumerateKeys: bridge.keys,
        flushStorage: bridge.flush,
        principal: status.userId,
        fetchChangesSince: async (cursor) => syncV2.feedChangesSince.query({ cursor }),
        onDegraded: setNotice,
      })
      if (!alive) return
      // ADR 6 D4.4 — never silent, in order of how much it costs the user.
      //
      // PARKED and REJECTED are both work that will never be sent, and both are
      // reported: parked entries lost the attribution question, rejected ones never
      // reached it (undecodable, or naming a command no contract in
      // MOBILE_OUTBOX_COMMANDS resolves). Reporting only the first would leave a
      // whole class of lost writes announced nowhere, which is the posture D4.4
      // rules out — and `rejected` is the class a stale contract table produces, so
      // it is exactly the one a silent path would hide from the person who could
      // fix it. A discarded cursor is milder: one re-bootstrap, visible as a slow
      // first paint, so it only speaks when nothing louder has.
      const lost = opened.outcome.parked + opened.outcome.rejected.length
      if (lost > 0) {
        setNotice(
          `${lost} queued change(s) from an earlier session could not be carried over and were not sent.`,
        )
      } else if (opened.outcome.cursorDiscarded) {
        setNotice('Refreshing from the server after a storage upgrade.')
      }
      setOpenedReplica(opened)
    })()
    return () => {
      alive = false
    }
  }, [config.httpOrigin, trpc])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  // `info` stays a no-op: the engine's only info is a transient "a session moved
  // to X" toast, and `notice` below is a STICKY banner for the storage facts the
  // user is owed. Routing the toast into it would leave a stale line on screen.
  const notices = useMemo<StoreNotices>(
    () => ({ error: (message) => setError(message), info: () => {} }),
    [],
  )
  if (!openedReplica) return <BootSplash />
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={setError}
      notices={notices}
      // The principal the auth status named, and the store opened for exactly
      // it. The factory REFUSES any other principal rather than handing back
      // the store it happens to hold: on a shared device that would give one
      // account another's slice and cursor (POD-404).
      principal={asClientPrincipal(openedReplica.principal)}
      createReplicaFn={(principal) => {
        if (principal.userId !== openedReplica.principal) {
          throw new Error(
            `mobile replica belongs to a different principal (opened for ${openedReplica.principal})`,
          )
        }
        return openedReplica.replica
      }}
      // Wire v2 advertisement + frame sink (POD-1241). Providing this is how
      // the hub sends wireVersion and receives feedDelta/feedBootstrap/…
      feed={openedReplica.feed}
      routerWindow={routerWindow}
    >
      <MobileHubAttach attachHub={openedReplica.attachHub} />
      <LiveBridge
        config={config}
        error={error}
        notice={notice}
        eraseLocalData={openedReplica.erase}
      >
        {children}
      </LiveBridge>
    </StoreProvider>
  )
}

/** Adapts the shared store to the MobileClientValue the screens consume. */
function LiveBridge({
  config,
  error,
  notice,
  eraseLocalData,
  children,
}: {
  config: ServerConfig
  error: string | null
  notice: string | null
  eraseLocalData: () => Promise<void>
  children: ReactNode
}) {
  const store = useStore<MobileTrpc>()
  const { hub, trpc, replica, sessions, issues, repos, machines, pins, conversations, outboxSize } =
    store
  const [connected, setConnected] = useState(() => hub.connectionHealth().status !== 'down')
  useEffect(() => hub.onConnectionHealth((health) => setConnected(health.status !== 'down')), [hub])

  const focusSessionIds = useMemo(() => {
    const groups = groupSessions(withoutShells(sessions))
    return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
  }, [sessions])

  const readTranscript = useCallback(
    (sessionId: SessionId, anchor?: string) =>
      trpc.sessions.transcriptRead.query({
        sessionId,
        ...(anchor ? { anchor } : {}),
        direction: 'before',
        limit: 80,
      }),
    [trpc],
  )
  const subscribeTranscript = useCallback(
    (
      sessionId: SessionId,
      since: string | undefined,
      cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
    ) => hub.subscribeTranscript(sessionId, since, cb),
    [hub],
  )
  const subscribeHeadless = useCallback(
    (sessionId: SessionId, cb: (e: HeadlessActivityEvent) => void) =>
      hub.subscribeHeadless(sessionId, cb),
    [hub],
  )
  const sendMessage = useCallback(
    async (sessionId: SessionId, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      // Optimistic + outboxed via the shared store (survives offline reloads).
      await store.resumeAndSend(sessionId, trimmed)
    },
    [store.resumeAndSend],
  )
  const answerQuestion = useCallback(
    async (sessionId: SessionId, choices: { optionIndices: number[] }[]) => {
      await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
    },
    [trpc],
  )

  const value = useMemo<MobileClientValue>(
    () => ({
      sessions,
      issues,
      repos,
      machines,
      pins,
      conversations,
      connected,
      cursor: replica.getCursor(),
      error,
      notice,
      serverConfig: config,
      hub,
      trpc,
      uiState: store.uiState,
      spawnDraftAgent: store.spawnDraftAgent,
      sessionById: (sessionId) => sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => issues.find((i) => i.id === issueId),
      focusSessionIds,
      outboxSize,
      eraseLocalData,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      // Curation actions come straight from the shared store: optimistic
      // replica apply + outboxed round-trip (mobile gains offline writes).
      setArchived: store.archiveSession,
      setWorkState: store.setWorkState,
      killSession: store.killSession,
      continueSession: store.continueSession,
      renameSession: store.renameSession,
      snooze: store.setSnooze,
      clearSnooze: store.clearSnooze,
      setIssueTucked: store.setIssueTucked,
      markIssueRead: store.markIssueRead,
    }),
    [
      sessions,
      issues,
      repos,
      machines,
      pins,
      conversations,
      connected,
      replica,
      error,
      notice,
      config,
      hub,
      trpc,
      store.spawnDraftAgent,
      focusSessionIds,
      outboxSize,
      store.uiState,
      eraseLocalData,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      store.archiveSession,
      store.setWorkState,
      store.killSession,
      store.continueSession,
      store.renameSession,
      store.setSnooze,
      store.clearSnooze,
      store.setIssueTucked,
      store.markIssueRead,
    ],
  )

  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
