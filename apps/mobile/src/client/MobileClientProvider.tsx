/**
 * Mobile binding for the shared client store (arch-v2 P3, issue #192): the
 * hand-rolled useState metadata layer is gone — the Expo app runs the SAME
 * StoreProvider as the web (replica-backed entity reads, outboxed optimistic
 * mutations) over an AsyncStorage-backed replica, so a cold offline start
 * paints from local data and offline writes replay on reconnect.
 *
 * `useMobileClient` keeps its existing shape: it is now a thin adapter over
 * the shared store (mobile-only extras — transcript paging, ask-user answers —
 * ride on the store's hub/trpc). Demo mode (`?demo=1`) stays a static fixture.
 */

import type { SpawnTarget } from '@podium/client-core'
import { OUTBOX_COMMANDS, outboxCommandFor } from '@podium/client-core/engine'
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { OutboxStorage } from '@podium/client-core/outbox'
import { asClientPrincipal } from '@podium/client-core/principal'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  createKernelOutboxStorage,
  createReplica,
  type KernelOutboxStorages,
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  type Replica,
  type ReplicaKind,
  type ReplicaRows,
  type StorageApi,
  type TranscriptWindow,
  type UiState,
} from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { SocketHub } from '@podium/client-core/socket-transport'
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
import type { HeadlessActivityEvent } from '@podium/protocol'
import {
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
// THE MOBILE REPLICA COMPOSITION ROOT (POD-1220)
// ---------------------------------------------------------------------------

/** The SQLite file the durable outbox lives in. */
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

export interface MobileReplicaDeps {
  /** The SQLite engine. Injected so a test drives a real file-backed database. */
  readonly openDatabase: () => SqlDatabaseLike
  /** Remove the file, so a poisoned or newer-version store cold-starts instead of
   *  wedging boot (ADR 6 D4.5). The adapter makes this REQUIRED for that reason. */
  readonly deleteDatabase: () => void
  /** The hydrated AsyncStorage bridge: the legacy replica's backing AND the
   *  migration's source. */
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
  /** Surfaced, never swallowed (ADR 6 D4.4). */
  readonly onDegraded: (message: string) => void
  readonly now?: () => number
}

export interface MobileReplica {
  /** What the engine reads through. */
  readonly replica: Replica
  /** What the migration did — the caller tells the user (D4.4). */
  readonly outcome: LegacyMigrationOutcome
  readonly store: SqliteSyncStore
  readonly principal: string
  /** Fail-closed sign-out: erase AsyncStorage and SQLite for this principal. */
  erase(): Promise<void>
}

/**
 * Open the durable store, run the attribution gate, and return the replica the
 * engine reads through.
 *
 * WHY THIS DECORATES THE LEGACY REPLICA INSTEAD OF ASSEMBLING THE KERNEL ONE, which
 * is the omission the next reader will otherwise take for an oversight and "fix".
 * Mobile is still a WIRE-v1 peer — `terminal-client`'s connection registers the four
 * v2 feed handlers as deliberately empty — and `createKernelReplica`'s facade REFUSES
 * `applySnapshot` / `applyChanges` / `setCursor` by design, because those are the
 * wire-v1 write-in path and it is a v2-only read model. Constructing it here would
 * throw on the first hub frame. Entities, cursor and transcript windows therefore
 * keep coming from today's v1 AsyncStorage path unchanged; the v2 assembly
 * (KernelReplica + FeedAuthorityClient) is POD-1241's scope, and it carries its own
 * hazard — an authority whose frames never arrive paints an empty slice that looks
 * exactly like working cold-start-offline.
 *
 * WHAT DOES MOVE, and why it is the half that matters: the OUTBOX. ADR 6 D1 names
 * outbox entries among what AsyncStorage "MUST NOT hold … on any path", and D4.3
 * makes losing them "a correctness bug, not degraded UX". `wiring.ts` takes both
 * outbox homes off the replica it is handed, so overriding two methods moves the
 * user's unsent work into SQLite with no engine change at all.
 *
 * AND WHY THE TWO HALVES CANNOT BE SPLIT. Migrating into a SQLite outbox the engine
 * does not read would write the queue somewhere NOTHING DRAINS — strictly worse than
 * today, and it reports success at every observable level. Conversely, the outbox is
 * the ONLY family the attribution gate governs here: entities and the cursor are
 * retired unconditionally either way, so a gate called without the durable binding
 * would be a gate with a caller and no effect.
 */
export async function openMobileReplica(deps: MobileReplicaDeps): Promise<MobileReplica> {
  const principal = deps.principal ?? MOBILE_REPLICA_PRINCIPAL
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
  const outcome = await migrateLegacyReplica({
    legacy: deps.storage,
    outbox: view.outbox,
    transact: store.unitOfWork.transact,
    resolveCommand: resolveMobileCommand,
    attribution,
    evidence:
      deps.evidence ??
      (namespace.durable
        ? {
            kind: 'multi-user',
            signedInAs: principal,
            identitiesEverSignedIn: namespace.knownPrincipals,
          }
        : { kind: 'unknown' }),
    now: deps.now ?? Date.now,
  })

  const outboxes = await createKernelOutboxStorage({
    outbox: view.outbox,
    resolveCommand: resolveMobileCommand,
    attribution,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  return {
    replica: withDurableOutbox(
      createReplica({
        ...(namespace.durable ? { storage: deps.storage } : {}),
        keyPrefix: namespace.keyPrefix,
      }),
      outboxes,
    ),
    outcome,
    store,
    principal,
    erase: async () => {
      namespace.erase()
      await Promise.all([
        store.erasePrincipal(principal),
        deps.flushStorage?.() ?? Promise.resolve(),
      ])
    },
  }
}

/**
 * The legacy replica with its two outbox homes redirected into SQLite.
 *
 * Delegation is written out member by member rather than spread or `Object.create`d.
 * A spread would drop the class's prototype methods entirely; a prototype chain would
 * let a `this.x = …` inside the base shadow a field onto the wrapper and quietly fork
 * the replica's state. Writing it out costs a screen and makes the compiler the thing
 * that notices when `Replica` grows a member.
 */
function withDurableOutbox(base: Replica, outboxes: KernelOutboxStorages): Replica {
  return {
    get persistent(): boolean {
      return base.persistent
    },
    hydrate: () => base.hydrate(),
    applySnapshot<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]): void {
      base.applySnapshot(kind, rows)
    },
    applyChanges<K extends ReplicaKind>(
      kind: K,
      upserts: ReplicaRows[K][],
      removeIds: string[],
    ): void {
      base.applyChanges(kind, upserts, removeIds)
    },
    getCursor: () => base.getCursor(),
    setCursor: (cursor: number) => base.setCursor(cursor),
    transcriptWindow: (key: string): TranscriptWindow | undefined => base.transcriptWindow(key),
    putTranscriptWindow: (key: string, items: TranscriptItem[]) =>
      base.putTranscriptWindow(key, items),
    collection: (kind: ReplicaKind): unknown => base.collection(kind),
    rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
      return base.rows(kind)
    },
    subscribeRows: (kind: ReplicaKind, cb: () => void) => base.subscribeRows(kind, cb),
    batch<T>(fn: () => T): T {
      return base.batch(fn)
    },
    // THE TWO OVERRIDES — the whole point of the decorator.
    outboxStorage: (): OutboxStorage => outboxes.queued,
    outboxAwaitingStorage: (): OutboxStorage => outboxes.awaiting,
    outboxDeadLetterStorage: (): OutboxStorage => outboxes.deadLetter,
    uiState: (): UiState => base.uiState(),
    flush: () => base.flush(),
    // POD-1246: the merge with main added feed-cursor persistence and cache reset
    // to `Replica`. This wrapper is written out member by member precisely so the
    // compiler reports that growth rather than a spread silently swallowing it —
    // which is what happened here. Straight delegation: the cursor and the cache
    // both belong to the base replica; only the two outbox homes are redirected.
    getFeedCursor: () => base.getFeedCursor(),
    setFeedCursor: (cursor) => base.setFeedCursor(cursor),
    resetCache: () => base.resetCache(),
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

function LiveProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(() => makeMobileTrpc(config.httpOrigin), [config.httpOrigin])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // AsyncStorage is Promise-only; hydrate the replica's synchronous storage
  // bridge before the store boots (offline cold-start paints from it). The
  // migration then runs BEFORE the store answers a read and the app does not
  // paint until it resolves — a replica read mid-migration would show a slice
  // that is about to be retired.
  const [openedReplica, setOpenedReplica] = useState<MobileReplica | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [bridge, status] = await Promise.all([
        createAsyncStorageReplicaStorage(AsyncStorage, LEGACY_HYDRATE_PREFIXES),
        fetchAuthStatus(config.httpOrigin),
      ])
      if (status.userId === null) throw new Error('authenticated account is unavailable')
      const opened = await openMobileReplica({
        openDatabase: () => fromExpoSqlite(SQLite.openDatabaseSync(MOBILE_REPLICA_DB)),
        deleteDatabase: () => SQLite.deleteDatabaseSync(MOBILE_REPLICA_DB),
        storage: bridge.storage,
        enumerateKeys: bridge.keys,
        flushStorage: bridge.flush,
        principal: status.userId,
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
  }, [config.httpOrigin])
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
      routerWindow={routerWindow}
    >
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
