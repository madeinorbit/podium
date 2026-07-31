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
import type { OutboxKinds } from '@podium/client-core/engine'
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { OutboxStorage } from '@podium/client-core/outbox'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  createKernelOutboxStorage,
  createReplica,
  type KernelOutboxStorages,
  REPLICA_KEY_PREFIX,
  type Replica,
  type ReplicaKind,
  type ReplicaRows,
  type StorageApi,
  type TranscriptWindow,
  type UiState,
} from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { ServerConfig } from '@podium/client-core/transport'
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
import {
  ENQUEUEABLE_DELIVERY,
  type OutboxAttribution,
  type OutboxCommand,
} from '@podium/sync/outbox'
import type { SocketHub } from '@podium/terminal-client'
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
  }
}

// ---------------------------------------------------------------------------
// THE MOBILE REPLICA COMPOSITION ROOT (POD-1220)
// ---------------------------------------------------------------------------

/** The SQLite file the durable outbox lives in. */
export const MOBILE_REPLICA_DB = 'podium-replica.db'

/**
 * The principal this device's slice is stored under.
 *
 * `CLIENT_PRINCIPAL_GRADE` is still `device` — `/auth/status` is a shared-password
 * gate and `auth.ts`'s `AuthStatus` carries no user identity — so there is exactly one
 * principal this app can name and it is this constant. It is NOT a placeholder to
 * fill in with a user id later without thought: when per-user login lands, a store
 * keyed `default` holds rows captured before anyone could be attributed, and
 * POD-377's rule applies — adopt only when attribution is CERTAIN.
 */
export const MOBILE_REPLICA_PRINCIPAL = 'default'

/** `ENQUEUEABLE_DELIVERY` is declared against the WHOLE delivery union while
 *  `OutboxCommand` narrows to the single member it names. The cast is that
 *  narrowing and nothing else — it is the same value, reused rather than
 *  re-spelled, so a rename of the class reaches this table. */
const delivery = ENQUEUEABLE_DELIVERY as OutboxCommand['delivery']

/**
 * The CONTRACT TABLE, which `readLegacyReplica` and the outbox binding both refuse
 * to invent (ADR 3 D9): a client entry carries a bare `kind` and an `OutboxCommand`
 * needs `{name, version, delivery}`, so guessing a version would re-author a queued
 * write under a contract its input may not satisfy.
 *
 * It is typed `Record<keyof OutboxKinds, …>` deliberately. That is the only thing
 * standing between this table and silent drift: adding a drainable kind to the
 * engine's queue without a contract here is a TYPE ERROR in this app's typecheck,
 * rather than an `unknown-command` rejection a user discovers when their offline
 * work fails to migrate.
 *
 * Every version is 1 because every one of these contracts has only ever had one —
 * the client has never re-authored a queued mutation shape. That is a statement
 * about today, and the day one of them changes, the entry here changes with it.
 */
export const MOBILE_OUTBOX_COMMANDS: Record<keyof OutboxKinds, OutboxCommand> = {
  resumeAndSend: { name: 'sessions.resumeAndSend', version: 1, delivery },
  rename: { name: 'sessions.rename', version: 1, delivery },
  setArchived: { name: 'sessions.setArchived', version: 1, delivery },
  setWorkState: { name: 'sessions.setWorkState', version: 1, delivery },
  snoozeSet: { name: 'snoozes.set', version: 1, delivery },
  snoozeClear: { name: 'snoozes.clear', version: 1, delivery },
  sessionMarkRead: { name: 'sessions.markRead', version: 1, delivery },
  sessionMarkUnread: { name: 'sessions.markUnread', version: 1, delivery },
  issueMarkRead: { name: 'issues.markRead', version: 1, delivery },
  issueMarkUnread: { name: 'issues.markUnread', version: 1, delivery },
  issueSetTucked: { name: 'issues.setTucked', version: 1, delivery },
}

const resolveMobileCommand = (kind: string): OutboxCommand | undefined =>
  MOBILE_OUTBOX_COMMANDS[kind as keyof OutboxKinds]

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
  const view = store.viewFor(principal)
  const attribution: OutboxAttribution = {
    actor: { kind: 'user', userId: principal },
    onBehalfOf: principal,
  }

  // ---- THE ATTRIBUTION GATE, before the store answers a single read ---------
  //
  // POD-377 built this and POD-378 verified it; until now nothing on either client
  // called it, and a gate with no caller is indistinguishable from an enforced one
  // in every handoff that cites it. It guards a privacy rule: POD-307 says a store
  // that cannot be attributed to the person signed in is DISCARDED and re-bootstrapped,
  // never adopted, because on a shared device adoption is how one person's queued
  // writes become another person's — replayed under their name and re-authorized
  // against their rights, which is not a check that can catch it.
  //
  // The default arm is `single-account`, and that is a claim about this tree rather
  // than a convenience: `AuthStatus` is `{needsAuth, authed}` and nothing else, so no
  // user identities exist in the system at all and the queue can only be the one
  // operator's. `auth-status-tripwire.test.ts` fails the day that stops being true.
  const outcome = await migrateLegacyReplica({
    legacy: deps.storage,
    outbox: view.outbox,
    transact: store.unitOfWork.transact,
    resolveCommand: resolveMobileCommand,
    attribution,
    evidence: deps.evidence ?? { kind: 'single-account', principal },
    now: deps.now ?? Date.now,
  })

  const outboxes = await createKernelOutboxStorage({
    outbox: view.outbox,
    resolveCommand: resolveMobileCommand,
    attribution,
    onDegraded: (error) => deps.onDegraded(String(error)),
  })

  return {
    replica: withDurableOutbox(createReplica({ storage: deps.storage }), outboxes),
    outcome,
    store,
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
    uiState: (): UiState => base.uiState(),
    flush: () => base.flush(),
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
  const [replica, setReplica] = useState<Replica | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const bridge = await createAsyncStorageReplicaStorage(AsyncStorage, LEGACY_HYDRATE_PREFIXES)
      const opened = await openMobileReplica({
        openDatabase: () => fromExpoSqlite(SQLite.openDatabaseSync(MOBILE_REPLICA_DB)),
        deleteDatabase: () => SQLite.deleteDatabaseSync(MOBILE_REPLICA_DB),
        storage: bridge.storage,
        onDegraded: setNotice,
      })
      if (!alive) return
      // ADR 6 D4.4 — never silent. Parked work is work the user queued and will
      // not see sent; a discarded cursor is a re-bootstrap they may notice as a
      // slow first paint. Both are theirs to know about.
      if (opened.outcome.parked > 0) {
        setNotice(
          `${opened.outcome.parked} queued change(s) from an earlier session could not be attributed to this account and were not sent.`,
        )
      } else if (opened.outcome.cursorDiscarded) {
        setNotice('Refreshing from the server after a storage upgrade.')
      }
      setReplica(opened.replica)
    })()
    return () => {
      alive = false
    }
  }, [])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  const notices = useMemo<StoreNotices>(
    () => ({ error: (message) => setError(message), info: setNotice }),
    [],
  )
  if (!replica) return <BootSplash />
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={setError}
      notices={notices}
      createReplicaFn={() => replica}
      routerWindow={routerWindow}
    >
      <LiveBridge config={config} error={error} notice={notice}>
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
  children,
}: {
  config: ServerConfig
  error: string | null
  notice: string | null
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
      spawnDraftAgent: store.spawnDraftAgent,
      sessionById: (sessionId) => sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => issues.find((i) => i.id === issueId),
      focusSessionIds,
      outboxSize,
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
