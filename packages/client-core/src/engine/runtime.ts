import { bindStoreStatsOwner } from '../perf/store-stats'

/**
 * THE CLIENT RUNTIME — the principal-scoped coordinator (POD-404).
 *
 * This file replaces `engine/engine.ts`, the 1,489-line god object the 6.1 split
 * (POD-328) exists to delete. What is left here is coordination and nothing
 * else: construct the collaborators, run one lifecycle over them, and own the
 * single state choke point they all write through.
 *
 *   TRANSPORT        socket-transport/  (POD-400) — socket, planes, PTY epoch/seq
 *   ACTIONS          actions.ts         (POD-402) — command dispatch + outbox
 *   ROUTER/UI-STATE  ui-state.ts        (POD-403) — the ONLY UI persistence
 *   POOL WRITER      client-graph/write  — optimism, spawns and outbox settlement
 *   REACTIONS        reactions.ts       — the old useEffect table
 *   BOOT             boot.ts            — the tRPC enrichments
 *   STATE            state.ts           — the shape + its pure derivations
 *
 * ---------------------------------------------------------------------------
 * ONE RUNTIME PER PRINCIPAL. THAT IS THE WHOLE LIFECYCLE RULE.
 * ---------------------------------------------------------------------------
 *
 * A runtime is bound to ONE `ClientPrincipal` at construction and can never be
 * re-pointed at another. Sign-in, sign-out and user switch are not state
 * changes: they {@link ClientRuntime.destroy} this runtime and construct a new
 * one (`react/provider.tsx` is the only caller). This is required, not tidy:
 *
 *  - the socket carries a principal (its cookie), so its frames belong to one
 *    person;
 *  - the replica carries a per-principal cursor and slice, and a cursor from
 *    another principal makes an empty slice look permanently caught up;
 *  - the outbox carries queued writes that belong to one person and must never
 *    drain under someone else's rights.
 *
 * `destroy()` is therefore IRREVERSIBLE and poisons the state choke point:
 * after it, `apply()` is a no-op, so an in-flight tRPC promise, a late spawn
 * grace timer or a retained hub handler from the previous principal cannot
 * deliver anything into the successor. `dispose()` stays reversible — it is the
 * React effect's cleanup and StrictMode's dev double-mount re-starts the same
 * runtime.
 *
 * ---------------------------------------------------------------------------
 * NOTHING STARTS BEFORE THE PRINCIPAL EXISTS
 * ---------------------------------------------------------------------------
 *
 * There is no "anonymous" runtime and no lazy principal. A runtime cannot be
 * constructed without one, so there is no reachable state in which hydration, a
 * feed subscription, a room subscription or an outbox drain can happen before
 * authentication has produced a principal. The provider renders nothing instead.
 */

import { createLogger } from '@podium/logger'
import type {
  IssueId,
  LayoutSnapshot,
  LayoutWire,
  MutationId,
  ReadPositionWire,
  SessionId,
} from '@podium/model'
import { asUserId } from '@podium/model'
import { isShortSessionIdentifier, type SessionIdentifierResolution } from '@podium/protocol'
import type { OutboxRejectionReason } from '@podium/sync/outbox'
import type { PodiumClientApi } from '../api'
import { createDraftLedger, type DraftLedgerSnapshot } from '../drafts'
import type { OnlineEvents, OutboxEntry } from '../outbox'
import { bindSwitchTraceUi } from '../perf/switch-trace'
import { hasDomWindow } from '../platform-globals'
import type { ClientPrincipal } from '../principal'
import { createReadPositionClient, type ReadPositionPort } from '../read-position'
import type { Replica } from '../replica/replica'
import type { FeedSinkPort, SocketHub } from '../socket-transport'
import { NotificationSounder } from '../sound/notification-sounds'

import {
  createRouterUiState,
  createUiStateRouter,
  type RoutedUiState,
  type Router,
  type RouterUiState,
  type RouterWindow,
  type RouteState,
} from '../ui-state'
import { allTabIds, closeTab, openTab, reposToViews, type WorkspaceKey } from '../values'
import { createEngineActions, type EngineActionRuntime, type EngineActions } from './actions'
import { BootFetches } from './boot'
import { OutboxSettlements } from './chat-send'
import { createHostMetricsStore } from './host-metrics'
import {
  createKeyedInputs,
  type KeyedInputStats,
  type KeyedInputsChannel,
  type KeyedListChange,
  type KeyedListName,
  type KeyedListRow,
  type LocalKey,
  type LocalsListener,
} from './keyed-inputs'
import { machinesMaterialSignature } from './machines-material'
import { type NavigationIntent, planNavigation } from './navigation'
import { Reactions, WORKSPACE_PRUNE_GRACE_MS } from './reactions'
import type { ReplicatedLayoutController } from './replicated-layout'
import { sessionLinkProblem, sessionLinkSelection } from './session-link'
import {
  asIssueIdOrNull,
  type EngineState,
  type EngineStatics,
  focusedPaneSession,
  foregroundIssue,
  initialEngineState,
  NAVIGATION_LOADING,
  type NavigationProvider,
  navigationSession,
  overlayState,
  resolvedWorkspaceKey,
  userFocus,
  type WorkspacePatch,
  workspaceFor,
  workspaceKeyForState,
  workspaceMirrorPatch,
  workspacesPatch,
  workspaceUiSnapshot,
  workspaceWritePatch,
} from './state'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type Store,
  type StoreNotices,
  type StoreServerConfig,
  type UserFocus,
} from './types'
import { domVisibility, type VisibilitySource } from './visibility'
import {
  type CreateEngineOutbox,
  type CreateHub,
  createEngineHub,
  createEngineOutbox,
  type EngineOutbox,
  type OutboxKinds,
  shouldParkDeadLetter,
} from './wiring'

/**
 * One outbox entry's outcome, for listeners outside the kernel (POD-4554: the
 * round-three receipts stream, keyed by mutation id). Observation only: it
 * fires AFTER the runtime's own handling of the same event, a throwing
 * listener is logged and skipped, and nothing a listener does reaches the
 * queue or the pool transaction log.
 *
 * - `applied`: the Authority applied the mutation (the drain's success). It
 *   says nothing about the echo: the wire row carries no mutation id.
 * - `rejected`: a definitive refusal took the entry out of the queue. `parked`
 *   says whether it went to the dead-letter recovery surface (authored text)
 *   or was discarded; `reason` is the normalized refusal when the queue knows it.
 * - `superseded`: the queue collapsed this still-queued entry into a later one
 *   with the same collapse key (POD-785). It is never sent and gets no other
 *   outcome. `entry` is absent when the queue could no longer see it.
 */
export type OutboxOutcome =
  | { readonly type: 'applied'; readonly mutationId: MutationId; readonly entry: OutboxEntry }
  | {
      readonly type: 'rejected'
      readonly mutationId: MutationId
      readonly entry: OutboxEntry
      readonly parked: boolean
      readonly reason?: OutboxRejectionReason
    }
  | { readonly type: 'superseded'; readonly mutationId: MutationId; readonly entry?: OutboxEntry }

/**
 * The pool's transaction log as the runtime's actions reach it (POD-5432).
 * `write` paints the pool's rows in the caller's tick, then enqueues once into
 * the outbox. Its promise settles when the record is durable and rejects when
 * that commit fails.
 */
export interface PoolWriter {
  spawnDraftAgent?: Store['spawnDraftAgent']
  spawnIssueAgent?: Store['spawnIssueAgent']
  waitForSpawnConfirmed?: (id: SessionId) => Promise<void>
  holds?: (id: MutationId) => boolean
  dispose?: () => void
  write<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): Promise<void>
}

const LOCAL_ONLY_ONLINE_EVENTS: OnlineEvents = {
  add: () => {},
  remove: () => {},
}

/**
 * The replica factory, PARAMETERIZED BY PRINCIPAL.
 *
 * It takes the principal rather than closing over one so that the question
 * "whose store is this?" is asked at every construction, by the composition root
 * that can actually answer it (POD-1239 established the root; POD-404 makes the
 * principal an argument to it). A root handed a principal it did not open for
 * must THROW rather than return the store it has — refusing is the fail-closed
 * answer; returning someone else's slice is the failure this whole seam exists
 * to make impossible.
 */
export type CreateReplicaForPrincipal = (principal: ClientPrincipal) => Replica

export interface ClientRuntimeInit<TApi extends PodiumClientApi> {
  /**
   * WHOSE CLIENT THIS IS. Supplied by the provider from the authenticated
   * transport (ADR 3 D7) — never from the URL, storage, a payload or a name the
   * user typed. See `src/principal.ts`.
   */
  principal: ClientPrincipal
  config: StoreServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: StoreNotices
  /**
   * Replica factory — mobile injects the AsyncStorage-backed one, web the
   * IndexedDB kernel assembly. Called ONCE, with this runtime's principal.
   *
   * REQUIRED since POD-1239: an engine that can build its own replica is a
   * construction site outside every composition root, and the flag-off browser
   * client used to adopt whatever ambient `localStorage` held.
   */
  createReplicaFn: CreateReplicaForPrincipal
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Test seam: replaces SocketHub construction (runtime unit tests inject a fake). */
  createHub?: CreateHub
  /**
   * WIRE v2 / kernel replica (POD-1223). Supplied together with a
   * `createReplicaFn` that returns the kernel-backed facade: the platform layer
   * builds the whole assembly (store, kernel Replica, feed sink) for ONE
   * principal and hands the runtime its two ends. Absent ⇒ the shipped v1 path.
   */
  feed?: FeedSinkPort
  /** Platform queue factory. Web injects the real kernel Outbox opened over IndexedDB. */
  createOutboxFn?: CreateEngineOutbox
  /**
   * PLATFORM SEAMS (POD-2055 WP-C). Each has a browser default and each of
   * those defaults is wrong on React Native, where `document` is missing,
   * `window` has no DOM events and `navigator.onLine` does not exist. The
   * composition root that knows the platform supplies the real ones.
   */
  /** Where visibility comes from. Default: `document.visibilityState`. */
  visibility?: VisibilitySource
  /** Connectivity transitions for the outbox. Default: the window's `online`. */
  onlineEvents?: OnlineEvents
  /** Connectivity probe for the outbox. Default: `navigator.onLine`. */
  isOnline?: () => boolean
  /** Liveness ping cadence. Default: the hub's own (2.5 s). Native passes 10 s. */
  heartbeatIntervalMs?: number
  /** Login carriage supplied by the authenticated platform owner. */
  makeSocket?: import('../socket-transport').SocketHubOptions['makeSocket']
  /** Platform-owned persistence/navigation for a promoted server endpoint. */
  onServerRelocation?: (publicUrl: string, transferId: string, claimToken?: string) => void
  /** Open the local runtime without contacting the configured authority. */
  networkEnabled?: boolean
  /** Test seam: overrides SPAWN_CONFIRM_GRACE_MS (#263 review finding 4). */
  spawnConfirmGraceMs?: number
  /** Test seam: overrides WORKSPACE_PRUNE_GRACE_MS (POD-710). */
  workspacePruneGraceMs?: number
  /** Test seam: overrides DRAFT_SEND_DEBOUNCE_MS (POD-2045). */
  draftSendDebounceMs?: number
  /** Test seam: overrides DRAFT_PERSIST_DEBOUNCE_MS (POD-2045). */
  draftPersistDebounceMs?: number
  /** Test seam: the coarse clock's source (POD-331). Default: `Date.now()`
   *  seeded at construction and re-read every COARSE_CLOCK_MS. A harness
   *  injects its own to pin the clock and tick it on demand (POD-4550). */
  coarseClock?: CoarseClock
}

/** Where the coarse clock reads time and when it ticks. */
export interface CoarseClock {
  now(): number
  /** Calls `tick` with the new time on every tick; returns the unsubscribe. */
  subscribe(tick: (now: number) => void): () => void
}

const wallCoarseClock: CoarseClock = {
  now: () => Date.now(),
  subscribe: (tick) => {
    const timer = setInterval(() => tick(Date.now()), COARSE_CLOCK_MS)
    return () => clearInterval(timer)
  },
}

/**
 * Coarse-clock period (POD-331). Minute granularity, matching the `useNow(60_000)`
 * the sidebar surfaces used to each run privately — snoozes lapse on screen
 * without a server round-trip, and nothing here needs finer resolution.
 */
export const COARSE_CLOCK_MS = 60_000

const log = createLogger('client-core:runtime')

/**
 * How long a keystroke waits before its text goes out (POD-2045).
 *
 * The STORE is written on every keystroke — that is what the caret is attached
 * to and it must never lag. What is debounced is only the WIRE, whose whole job
 * is showing the draft on this person's other devices. That audience does not
 * need per-character fidelity, and sending the full text per keystroke made an
 * O(n²) stream of frames that the server had to parse, arbitrate, broadcast and
 * persist — the most expensive traffic in the product, generated fastest exactly
 * when the server was already struggling.
 */
export const DRAFT_SEND_DEBOUNCE_MS = 250
/** How long before an edited draft is written to device storage. Longer than the
 *  wire debounce: storage exists for the reload case, which is not a race. */
export const DRAFT_PERSIST_DEBOUNCE_MS = 500
/**
 * How many drafts this device keeps, most-recently-edited first.
 *
 * Local drafts are never dropped when a session leaves the replica: under the
 * scoped feed an eviction is a VISIBILITY change (POD-1077), and deleting
 * someone's unsent writing because a share was revoked would be the same bug
 * this file exists to fix, wearing a different hat. A count cap bounds the
 * store without ever consulting that question.
 */
export const DRAFT_KEEP_LIMIT = 50
/** Device-local ui-state key holding this device's drafts. */
export const DRAFTS_UI_KEY = 'podium.drafts.v1'

export class ClientRuntime<TApi extends PodiumClientApi = PodiumClientApi> {
  /** The one principal this runtime serves. Read-only for its whole lifetime. */
  readonly principal: ClientPrincipal
  readonly replica: Replica
  readonly hub: SocketHub
  readonly outbox: EngineOutbox
  /** Waiters on queued entries by id — how a chat send hears its outcome
   *  (POD-4762). Created before the outbox, whose callbacks release them. */
  private readonly outboxSettlements = new OutboxSettlements()
  readonly router: Router
  readonly ui: RoutedUiState
  readonly replicatedLayout: ReplicatedLayoutController
  /** This person's event-stream read positions (POD-1380) — its own family
   *  because a cursor merges monotonically, not last-writer-wins. */
  readonly readPosition: ReadPositionPort

  private readonly routerUi: RouterUiState
  private readonly reactions: Reactions
  private readonly boot: BootFetches<TApi>

  private readonly api: TApi
  get spawnNotices(): StoreNotices {
    return this.notices
  }
  get spawnGraceMs(): number | undefined {
    return this.spawnConfirmGraceMs
  }
  private readonly spawnConfirmGraceMs: number | undefined
  private readonly notices: StoreNotices
  private readonly onFatalError: (message: string) => void
  private readonly formatError: (error: unknown, fallback: string) => string
  private readonly httpOrigin: string

  /** Where this client learns whether it is on screen (POD-2055 WP-C4). */
  private readonly visibility: VisibilitySource
  private readonly hostMetricsStore = createHostMetricsStore()
  readonly hostMetrics = {
    subscribe: this.hostMetricsStore.subscribe,
    getSnapshot: this.hostMetricsStore.getSnapshot,
  }

  private readonly state: EngineState
  private stopNavigationWatch: (() => void) | undefined
  private pendingNavigation: NavigationIntent | undefined
  private pendingSessionNavigation: string | undefined
  private navigationWakeQueued = false
  private pendingNavigationTopology = false
  private pendingWorktreeFallback = false
  private statsReactionDepth = 0
  readonly services: EngineStatics<TApi>
  readonly access: Store<TApi>
  private stopTopologyWatch: (() => void) | undefined
  private prevRoute: RouteState
  /** Which workspace is on screen (POD-710). A change here is a TASK SWITCH, and
   *  the pane mirrors are re-derived from the workspace being switched to. */
  private workspaceKey: WorkspaceKey
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private offs: Array<() => void> = []
  private lastMachinesMaterial: string | undefined
  private started = false
  /** Set by destroy(). The state choke point refuses everything after it, so a
   *  superseded principal's late callback cannot reach any consumer. */
  private destroyed = false
  /** The short-id pane link awaiting the server's answer (POD-4637); a later
   *  pane navigation supersedes it, so a slow answer never yanks the view. */
  private pendingPaneLink: string | null = null
  /** A full session id a `?pane=` link named before this replica held the
   *  session (POD-4642): opened when the row arrives, reported once the prune
   *  grace gives up on it. */
  private paneLink: {
    sessionId: string
    worktree: string | null
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private readonly paneLinkGraceMs: number
  private applyingHydratedUi = false
  /** > 0 while {@link batch} is coalescing local changes into one keyed publication. */
  private batchDepth = 0
  private pendingChanges = new Set<keyof EngineState>()
  /** Sessions whose draft this batch painted, for {@link onDraft}. */
  private pendingDrafts = new Set<string>()
  /** The keyed inputs (POD-5426 §4.10): locals by key, lists by id, drafts per session. */
  private readonly inputs: KeyedInputsChannel
  private pendingReactions = new Set<keyof EngineState>()
  /** True when this runtime runs on the wire-v2 feed (POD-1223). */
  private readonly onFeed: boolean
  // ---- offline-first composer drafts (POD-2045) ----
  /** What this device believes about each composer, and who wins a disagreement.
   *  Every draft decision in this class defers to it; none is taken here. */
  private readonly draftLedger = createDraftLedger()
  private readonly draftSendTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private draftPersistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly draftSendDebounceMs: number
  private readonly coarseClock: CoarseClock
  private readonly draftPersistDebounceMs: number
  private readonly networkEnabled: boolean
  /** One-time boot fetches (repos/pins/tab-orders/settings) — once per runtime,
   *  even across a StrictMode dispose/re-start cycle. */
  private booted = false

  constructor(init: ClientRuntimeInit<TApi>) {
    this.spawnConfirmGraceMs = init.spawnConfirmGraceMs
    this.principal = init.principal
    this.api = init.api
    this.notices = init.notices ?? NOOP_NOTICES
    this.onFatalError = init.onFatalError
    this.formatError = init.formatError ?? defaultFormatError
    this.httpOrigin = init.config.httpOrigin
    this.draftSendDebounceMs = init.draftSendDebounceMs ?? DRAFT_SEND_DEBOUNCE_MS
    this.coarseClock = init.coarseClock ?? wallCoarseClock
    this.draftPersistDebounceMs = init.draftPersistDebounceMs ?? DRAFT_PERSIST_DEBOUNCE_MS
    this.networkEnabled = init.networkEnabled ?? true
    // The runtime type is only half the guard — an untyped caller omitting the
    // factory must fail LOUDLY here rather than quietly adopt ambient storage.
    if (typeof init.createReplicaFn !== 'function') {
      throw new Error(
        'a client runtime requires createReplicaFn: the platform composition root builds the ' +
          'replica for a NAMED principal and is responsible for establishing that its persisted ' +
          'store belongs to that principal (POD-307 / POD-1239 / POD-404).',
      )
    }
    // Persistent local replica (docs/spec/thin-client-replica.md), opened for
    // THIS principal. Constructed synchronously so its persisted cursor can seed
    // the hub's first changesSince; entity hydration happens async in start().
    this.replica = init.createReplicaFn(init.principal)
    bindStoreStatsOwner(this.replica, this)
    this.visibility = init.visibility ?? domVisibility()
    this.hub = createEngineHub({
      wsClientUrl: init.config.wsClientUrl,
      api: this.api,
      replica: this.replica,
      onFatalError: (m) => this.onFatalError(m),
      createHub: init.createHub,
      makeSocket: init.makeSocket,
      feed: init.feed,
      ...(init.onServerRelocation ? { onServerRelocation: init.onServerRelocation } : {}),
      ...(init.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: init.heartbeatIntervalMs }
        : {}),
    })
    this.onFeed = init.feed !== undefined
    this.outbox = (init.createOutboxFn ?? createEngineOutbox)({
      api: this.api,
      replica: this.replica,
      // Platform connectivity, when the root knows better than the browser
      // defaults `createEngineOutbox` would reach for (native: NetInfo).
      ...(this.networkEnabled
        ? {
            ...(init.onlineEvents !== undefined ? { onlineEvents: init.onlineEvents } : {}),
            ...(init.isOnline !== undefined ? { isOnline: init.isOnline } : {}),
          }
        : { onlineEvents: LOCAL_ONLY_ONLINE_EVENTS, isOnline: () => false }),
      notices: { error: (m) => this.notices.error(m), info: (m, d) => this.notices.info(m, d) },
      // Overlay lifecycle (#263): drain success hands the entry's overlay to
      // the awaiting-truth stage; a poison drop repaints without it.
      onApplied: (entry) => this.onMutationApplied(entry),
      onSettled: (mutationId, settlement) => this.outboxSettlements.settle(mutationId, settlement),
      onDropped: (entry, reason) => this.onMutationDropped(entry, reason),
      onSuperseded: (mutationId, entry) => {
        if (this.destroyed) return
        this.emitOutcome({ type: 'superseded', mutationId, ...(entry ? { entry } : {}) })
      },
      observingSupersede: () => this.outcomeListeners.size > 0,
      // The queue-size subscription is not the dead-letter event: a definitive
      // refusal can park before start() installs that subscription. Publish the
      // recovery projection at the event's own boundary so a live park cannot
      // remain durable-but-invisible.
      onDeadLetter: () => this.apply({ outboxDeadLetters: this.outbox.deadLetters() }),
    })
    const localUi = this.replica.uiState()
    this.router = createUiStateRouter(localUi, init.routerWindow)
    // ORDER IS LOAD-BEARING HERE. `createActions()` builds the replicated-layout
    // controller and seeds its base from the persisted rows (`layoutSeed`), and
    // that has to happen before the two readers below: `routerUi.hydrate()` a few
    // lines down reads persisted UI state THROUGH this controller, and every
    // replicated layout consumer (`usePersistedUiValue`) reads it on its first
    // render. A base seeded after either one arrived too late to decide what the
    // shell mounts, which is the whole of POD-571.
    const actions = this.createActions()
    this.replicatedLayout = actions.replicatedLayout
    this.readPosition = createReadPositionClient({
      api: this.api,
      local: localUi,
      onError: (message) => this.notices.error(message),
    })
    this.boot = new BootFetches<TApi>({
      api: this.api,
      publish: (patch) => this.apply(patch),
      replicatedLayout: this.replicatedLayout,
    })
    this.routerUi = createRouterUiState({
      local: localUi,
      replicated: this.replicatedLayout,
      router: this.router,
    })
    this.ui = this.routerUi.ui
    // Switch-latency debug flag is principal-scoped — no raw localStorage (POD-329).
    bindSwitchTraceUi(this.ui)
    const persisted = this.routerUi.hydrate()
    const route = this.router.current()
    this.prevRoute = route
    this.reactions = new Reactions({
      state: () => this.state,
      publish: (patch) => this.apply(patch),
      hub: this.hub,
      notices: this.notices,
      isVisible: () => this.visibility.isVisible(),
      markSessionRead: (sessionId) => void this.services.markSessionRead(sessionId),
      markIssueRead: (issueId) => void this.services.markIssueRead(issueId),
      ...(init.workspacePruneGraceMs !== undefined
        ? { pruneGraceMs: init.workspacePruneGraceMs }
        : {}),
      linkedWorktree: () => this.paneLink?.worktree ?? null,
    })
    this.paneLinkGraceMs = init.workspacePruneGraceMs ?? WORKSPACE_PRUNE_GRACE_MS
    this.state = initialEngineState({
      persisted,
      route,
      // Hydrate-first, like the entity slices: the outbox constructor has
      // already restored its durable recovery home, so the first Store snapshot
      // must expose it without waiting for start() or a queue notification.
      outboxDeadLetters: this.outbox.deadLetters(),
      now: this.coarseClock.now(),
    })
    this.workspaceKey = workspaceKeyForState(this.state)
    // Drafts are hydrate-first for the same reason the entity slices are, and
    // with more at stake: this is the person's own unsent writing, and a first
    // paint without it is an empty composer where a half-written message was.
    // It happens HERE rather than in start() because start() is a passive
    // effect — a frame late is a frame of blank box, and on a cold boot with no
    // server there is nothing else that would ever fill it in.
    this.state.drafts = this.hydrateDrafts()
    this.inputs = createKeyedInputs(() => this.state)
    this.services = this.buildStatics(actions)
    this.access = Object.defineProperties(
      { ...this.services },
      Object.fromEntries(
        Object.keys(this.state).map((key) => [
          key,
          { enumerable: true, get: () => this.readLocal(key as LocalKey) },
        ]),
      ),
    ) as Store<TApi>
  }

  /** Read this device's persisted drafts into the ledger, and return the map the
   *  first snapshot paints. A poisoned blob is a cold start, never a crash. */
  private hydrateDrafts(): EngineState['drafts'] {
    let stored: string | null = null
    try {
      stored = this.ui.get(DRAFTS_UI_KEY)
    } catch {
      // Unreadable device storage (private mode, quota) — the app still runs,
      // it simply starts with no remembered drafts.
      return this.state.drafts
    }
    if (!stored) return this.state.drafts
    try {
      this.draftLedger.restore(JSON.parse(stored) as DraftLedgerSnapshot)
    } catch {
      return this.state.drafts
    }
    const drafts = { ...this.state.drafts }
    for (const sessionId of this.draftLedger.dirtySessions()) {
      const local = this.draftLedger.get(sessionId)
      if (local?.text) drafts[sessionId] = local.text
    }
    return drafts
  }

  // ------------------------------------------------------------------ read seam

  /** Keyed locals (POD-5426 §4.10): `listener` runs after a batch that changed
   *  one of `keys`, with that subset. Bound so it can be passed bare. */
  readonly onLocals = (keys: readonly LocalKey[], listener: LocalsListener): (() => void) =>
    this.inputs.onLocals(keys, listener)
  /** The value of one local as the last batch published it. */
  readonly readLocal = <K extends LocalKey>(key: K): EngineState[K] => this.inputs.readLocal(key)
  /** Discovery and window lists by id: the ids whose row changed per batch. */
  readonly onList = <N extends KeyedListName>(
    name: N,
    listener: (change: KeyedListChange) => void,
  ): (() => void) => this.inputs.onList(name, listener)
  readonly listIds = (name: KeyedListName): readonly string[] => this.inputs.listIds(name)
  readonly listRow = <N extends KeyedListName>(name: N, id: string): KeyedListRow<N> | undefined =>
    this.inputs.listRow(name, id)
  /** The one session whose draft a batch painted. */
  readonly onDraft = (listener: (sessionId: string) => void): (() => void) =>
    this.inputs.onDraft(listener)
  /** Wake and diff counters of the keyed inputs (adapter meters). */
  get keyedInputStats(): KeyedInputStats {
    return this.inputs.stats
  }
  // ----------------------------------------------------------------- write seam

  /** The pool's transaction log while it owns optimism for pool screens
   *  (POD-5432); null otherwise. */
  private poolWriter: PoolWriter | null = null

  /** One writer per principal runtime. Queued actions paint through the pool
   * transaction log before the outbox commit; the teardown detaches that owner. */
  readonly attachPoolWriter = (writer: PoolWriter): (() => void) => {
    if (this.poolWriter !== null)
      throw new Error('A pool writer is already attached to this runtime')
    this.poolWriter = writer
    return () => {
      if (this.poolWriter === writer) this.poolWriter = null
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Arm all subscriptions/listeners, hydrate, connect, and (once per runtime)
   *  run the boot fetches. Idempotent while started; re-arms after dispose().
   *  A DESTROYED runtime never re-arms — its principal is gone. */
  start(): void {
    if (this.started || this.destroyed) return
    this.started = true
    const offs = this.offs

    // Router changes fan in through one subscription; RouterUiState owns every
    // URL write and the state mirror.
    offs.push(this.router.subscribe((r) => this.onRouteChanged(r)))
    this.router.attach()
    // A route may have changed between dispose() and a re-start (StrictMode).
    const cur = this.router.current()
    if (cur !== this.prevRoute) this.onRouteChanged(cur)
    offs.push(this.replicatedLayout.subscribe(() => this.syncReplicatedUi()))

    // One coarse clock per runtime; the pool follows this keyed local.
    offs.push(this.coarseClock.subscribe((now) => this.apply({ coarseNow: now })))

    // The outbox publishes local recovery state; PoolTransactions owns paint.
    offs.push(
      this.outbox.subscribe((size) => {
        this.batch(() => {
          this.apply({ outboxSize: size, outboxDeadLetters: this.outbox.deadLetters() })
          this.replicatedLayout.outboxChanged()
        })
      }),
    )
    this.outbox.attach()
    this.apply({ outboxSize: this.outbox.size(), outboxDeadLetters: this.outbox.deadLetters() })
    void this.replica.hydrate().catch((error) => {
      if (!this.destroyed) this.onFatalError(this.formatError(error, 'Could not load local data'))
    })
    offs.push(
      this.replica.subscribeRows('userLayouts', () => {
        this.replicatedLayout.replace(layoutSnapshotFromRows(this.replica.rows('userLayouts')))
      }),
    )

    // Hub events, via the P5a `on()` subscription seam. Only ephemeral state
    // (host metrics, machines, drafts) follows hub events through keyed channels.
    offs.push(this.hub.on('hostMetrics', (m) => this.hostMetricsStore.publish(m)))
    offs.push(this.hub.on('approvals', (a) => this.apply({ approvals: a })))
    // Apply the scoped machine snapshot immediately so a SEE revocation hides
    // its repositories, then reconcile repos and machines from one authorized
    // server snapshot when visibility, reachability, or USE changed. Full
    // machine broadcasts also carry inventory/build metadata; treating those as
    // repo invalidations repeatedly supersedes an in-flight scan-backed refresh
    // and can starve its durable fallback during daemon rebind. The id+online+use
    // set detects equal-count replacement, SEE revocation, and scan-authority
    // changes without including unrelated metadata.
    let machineScopeSignature: string | undefined
    offs.push(
      this.hub.on('machines', (m) => {
        // Scope equality below only gates repo refresh. Publication equality
        // includes every material field, including unknown future wire fields.
        const material = machinesMaterialSignature(m)
        if (material === undefined || material !== this.lastMachinesMaterial) {
          this.apply({ machines: m })
          this.lastMachinesMaterial = material
        }
        const nextSignature = m
          .map(
            (machine) =>
              `${machine.id}:${machine.online ? 'online' : 'offline'}:${machine.use ?? 'unknown'}`,
          )
          .sort()
          .join('|')
        if (nextSignature !== machineScopeSignature) {
          machineScopeSignature = nextSignature
          void this.boot.refreshRepos().catch(() => {})
        }
      }),
    )
    // An arriving composer document. It is OFFERED to the ledger rather than
    // applied: while this device holds unsent text, the person's caret outranks
    // anything the socket says (POD-2045).
    offs.push(
      this.hub.on('sessionDraft', (sessionId, text, meta) => {
        const outcome = this.draftLedger.adoptRemote(sessionId, {
          text,
          ...(meta?.rev !== undefined ? { rev: meta.rev } : {}),
        })
        if (outcome.acceptText) {
          this.applyDraftToStore(sessionId, text)
          this.scheduleDraftPersist()
        }
        if (outcome.resend) this.scheduleDraftSend(sessionId, { immediate: false })
      }),
    )
    offs.push(
      this.hub.on('userLayouts', (rows: LayoutWire[]) => {
        this.replicatedLayout.replace(Object.fromEntries(rows.map((row) => [row.key, row.value])))
      }),
    )
    // A read position moved on this person's OTHER device (POD-1380). The feed
    // is scoped per-user, so every row here is already this principal's — the
    // filter is belt-and-braces against a widened feed, not the primary guard.
    offs.push(
      this.hub.on('userReadPositions', (rows: ReadPositionWire[]) => {
        this.readPosition.replace(
          Object.fromEntries(
            rows
              .filter((row) => row.userId === this.principal.userId)
              .map((row) => [row.streamId, { lastEventId: row.lastEventId, seenAt: row.seenAt }]),
          ),
        )
      }),
    )

    // A daemon-created worktree is otherwise invisible in every repo menu until
    // reload (POD-665) — re-fetch through the same path used at boot.
    offs.push(this.hub.on('worktreesChanged', () => void this.boot.refreshRepos().catch(() => {})))
    // Reconnect drains the outbox: the browser 'online' event (the outbox's own
    // trigger) misses a server restart behind a healthy network, but the hub's
    // heartbeat-derived health catches both.
    let prevHealth = this.hub.connectionHealth().status
    offs.push(
      this.hub.on('connectionHealth', (h) => {
        if (h.status === 'ok' && prevHealth !== 'ok') {
          this.outbox.notifyConnected()
          // …and the same for drafts, which are NOT outbox mutations: they are
          // ephemeral shared state with last-writer-wins arbitration, not a
          // durable command with an id and a receipt. What they share with the
          // outbox is the moment they need — the reconnect edge, which the
          // browser's own 'online' event misses when a server restarts behind a
          // healthy network. Every draft this device typed while the socket was
          // down goes out here, at once, at its latest text.
          this.flushDirtyDrafts()
        }
        prevHealth = h.status
      }),
    )
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    offs.push(
      this.hub.on('attention', (e) => {
        if (this.visibility.isVisible()) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        try {
          new Notification(e.title, { body: e.body, tag: e.sessionId })
        } catch {
          // some webviews throw on construction — never break the app over a toast
        }
      }),
    )

    // Agent-state transitions → sound cues [POD-78]. Fed from 'sessions' (not
    // 'attention'): the attention broadcast is gated on the web-notification
    // setting and never fires for a clean "done"; sounds want both.
    const sounder = new NotificationSounder({
      ui: this.ui,
      visibleSessionIds: () => this.getUserFocus().visibleSessionIds ?? [],
    })
    offs.push(sounder.attach())
    offs.push(this.hub.on('sessions', (list) => sounder.onSessions(list)))

    // Presence feeds the server's smart router (skip mobile push while visible).
    // Re-report view-state too so hiding the tab clears it (and showing re-asserts).
    // The SOURCE is injected (POD-2055 WP-C4): web reads the document, native
    // reads AppState, and only the source knows which transition just happened.
    offs.push(
      this.visibility.subscribe(() => {
        this.reactions.onVisibilityChange()
        // A client that slept through its heartbeat deadline reconnects the
        // moment it is looked at again, instead of waiting out up to 10s of
        // backoff with the feed and every terminal dark.
        if (this.networkEnabled && this.visibility.isVisible()) this.hub.connectNow()
      }),
    )
    // The OS knows the network came back long before the backoff timer does.
    // Feature-detected rather than assumed: React Native defines `window` as the
    // global object, without DOM listeners on it (POD-2055 F4) — where this
    // declines, the platform's own signal is injected instead (mobile: NetInfo).
    if (this.networkEnabled && hasDomWindow()) {
      const dom = window
      const onOnline = (): void => this.hub.connectNow()
      dom.addEventListener('online', onOnline)
      offs.push(() => dom.removeEventListener('online', onOnline))
    }
    this.reactions.onVisibilityChange()
    // A ghost tab restored from persistence needs no delta to be a ghost, so the
    // prune pass has to be armed at boot as well as reacted to — otherwise an
    // offline reload keeps showing (and re-persisting) a tab for a session that
    // is long gone. Idempotent: it re-arms its own timer.
    this.reactions.pruneWorkspaces()
    offs.push(this.onLocals(['fileTabs', 'workspaces'], () => this.reactions.pruneWorkspaces()))

    if (this.networkEnabled) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        try {
          this.hub.connect()
        } catch (e) {
          this.onFatalError(this.formatError(e, 'WebSocket connection failed'))
        }
      }, 0)
    }

    if (!this.booted) {
      this.booted = true
      if (this.networkEnabled) {
        void this.replicatedLayout.hydrate().catch(() => {})
        void this.readPosition.hydrate().catch(() => {})
        // Sidebar prefs load out of band so boot fans out only repos + pins + tab
        // orders (never gated on settings or a conversation scan).
        void this.boot.refreshPersonalSettings().catch(() => {})
        // These enrichments are network-derived, not the source of truth for the
        // principal slice. A cold offline boot must keep serving the persisted
        // replica instead of replacing it with a fatal connection screen.
        void Promise.all([
          this.boot.refreshRepos(),
          this.boot.refreshPins(),
          this.boot.refreshTabOrders(),
          // The superagent column is the desktop shell's centre and its thread
          // list used to be fetched by the view itself. It is store state now, so
          // it loads with the rest of the boot fan-out.
          this.boot.refreshSuperThreads(),
        ]).catch(() => {})
      }
    }

    // Normalize the URL through the same owner that hydrates and flushes state.
    this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
    // A cold `?pane=` link: onRouteChanged never saw it (the route was read at
    // construction), and hydration only seeded the pane scalar from it — the
    // restored layout still has its own tab active. Open the link here.
    this.followPaneLink(this.router.current())
  }

  /** Tear down everything start() armed. Idempotent; the runtime can re-start
   *  (React StrictMode's dev double-mount). This is NOT the principal boundary
   *  — see {@link destroy}. */
  dispose(): void {
    this.lastMachinesMaterial = undefined
    this.started = false
    bindSwitchTraceUi(null)
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.reactions.dispose()
    this.dropPaneLink()
    // Drafts: drop the timers, but FLUSH the pending storage write first. A tab
    // closing is the most likely moment for a draft to be lost, and a debounce
    // that discards its last write on teardown would lose exactly the keystrokes
    // that were never sent anywhere else.
    for (const timer of this.draftSendTimers.values()) clearTimeout(timer)
    this.draftSendTimers.clear()
    if (this.draftPersistTimer !== null) {
      clearTimeout(this.draftPersistTimer)
      this.draftPersistTimer = null
      this.persistDrafts()
    }
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        // teardown is best-effort
      }
    }
    this.router.dispose()
    this.outbox.dispose()
    this.hub.dispose()
  }

  /**
   * THE PRINCIPAL BOUNDARY. Irreversible.
   *
   * Called when the authenticated principal changes (sign-in, sign-out, user
   * switch). After this the runtime is inert: `apply()` refuses, so nothing —
   * a resolving tRPC promise, a spawn-confirm grace timer, a hub handler
   * someone retained, a drain callback already scheduled — can publish a
   * previous principal's data to a consumer, and `start()` can never re-arm it.
   *
   * The successor is a NEW runtime over a NEW replica, socket and outbox; there
   * is deliberately no "reset" path, because a reset is exactly the shape that
   * leaves one cached principal-derived value behind.
   */
  destroy(): void {
    if (this.destroyed) {
      this.dispose()
      return
    }
    this.dispose()
    this.stopNavigationWatch?.()
    this.stopNavigationWatch = undefined
    this.stopTopologyWatch?.()
    this.stopTopologyWatch = undefined
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    this.pendingNavigationTopology = false
    this.pendingWorktreeFallback = false
    this.destroyed = true
    this.poolWriter?.dispose?.()
    this.poolWriter = null
    this.inputs.dispose()
    this.hostMetricsStore.destroy()
  }

  /** True once {@link destroy} has run. The provider asserts on this so a
   *  teardown that silently did not happen cannot pass as one that did. */
  get isDestroyed(): boolean {
    return this.destroyed
  }

  /** Each client's startup attachment supplies this read port. No fallback is
   * installed during loading or teardown. */
  setNavigationProvider(provider: NavigationProvider): void {
    if (this.destroyed) return
    this.stopTopologyWatch?.()
    this.stopTopologyWatch = provider.onTopology?.(() => {
      if (this.destroyed) return
      this.pendingNavigationTopology = true
      this.queueNavigationWake(provider)
    })
    this.pendingNavigationTopology = true
    this.apply({ navigation: provider })
    if (this.pendingNavigationTopology || this.pendingWorktreeFallback)
      this.queueNavigationWake(provider)
    if (this.pendingSessionNavigation)
      this.services.navigateToSession(this.pendingSessionNavigation)
    if (this.pendingNavigation) this.navigate(this.pendingNavigation)
  }

  private watchNavigation(): void {
    // Attach the new watch before releasing the old one, so the provider's
    // cached reads (activity roll-ups, mission roots) stay observed across a
    // click instead of being dropped and rebuilt from scratch.
    const previous = this.stopNavigationWatch
    this.stopNavigationWatch = undefined
    const provider = this.state.navigation
    if (!provider?.watch) {
      previous?.()
      return
    }
    // The topology port already follows background membership. An idle
    // window has no addressed pool cells to watch and needs no row reaction.
    if (
      provider.onTopology &&
      !focusedPaneSession(this.state) &&
      !this.state.selectedIssueId &&
      !this.state.openIssueId &&
      !this.pendingSessionNavigation &&
      !this.pendingNavigation
    ) {
      previous?.()
      return
    }
    try {
      this.stopNavigationWatch = this.attachNavigationWatch(provider, provider.watch)
    } finally {
      previous?.()
    }
  }

  private attachNavigationWatch(
    provider: NavigationProvider,
    watch: NonNullable<NavigationProvider['watch']>,
  ): () => void {
    return watch.call(
      provider,
      () => {
        const st = this.state
        const focused = focusedPaneSession(st)
        const session = focused ? provider.session(focused) : undefined
        const issue = foregroundIssue(st)
        const pending = this.pendingNavigation
        return [
          !provider.onTopology && (this.pendingNavigationTopology || this.pendingWorktreeFallback)
            ? provider.worktreeSessions?.()
            : undefined,
          resolvedWorkspaceKey(st),
          issue
            ? [
                issue.id,
                issue.updatedAt,
                provider.activityAt(issue.id),
                provider.issueReadAt(issue.id),
              ]
            : undefined,
          // Watch only the pool fields these navigation reactions consume.
          session && session !== NAVIGATION_LOADING
            ? [
                session.sessionId,
                session.issueId,
                session.cwd,
                session.lastActiveAt,
                session.unread,
              ]
            : session,
          this.pendingNavigationTopology &&
          session &&
          session !== NAVIGATION_LOADING &&
          session.issueId
            ? resolvedWorkspaceKey(overlayState(st, { selectedIssueId: session.issueId }))
            : undefined,
          this.pendingSessionNavigation
            ? provider.session(this.pendingSessionNavigation)
            : undefined,
          pending
            ? resolvedWorkspaceKey(
                overlayState(st, {
                  ...(pending.selectedIssueId !== undefined
                    ? { selectedIssueId: pending.selectedIssueId }
                    : {}),
                  ...(pending.selectedWorktree !== undefined
                    ? { selectedWorktree: pending.selectedWorktree }
                    : {}),
                }),
              )
            : undefined,
        ]
      },
      () => this.queueNavigationWake(provider),
    )
  }

  private queueNavigationWake(provider: NavigationProvider): void {
    if (this.navigationWakeQueued) return
    this.navigationWakeQueued = true
    // The runtime publishes before the row source's queued fold. Cross that
    // boundary before following a rehome or pruning the original tab strip.
    queueMicrotask(() =>
      queueMicrotask(() => {
        this.navigationWakeQueued = false
        if (this.destroyed || this.state.navigation !== provider) return
        this.batch(() => {
          if (
            this.pendingNavigationTopology &&
            this.reactions.worktreeFollow() &&
            this.reactions.worktreeFallback() &&
            this.reactions.sessionIssueFollow()
          ) {
            this.pendingNavigationTopology = false
            this.pendingWorktreeFallback = false
            this.reactions.pruneWorkspaces()
          }
          if (
            !this.pendingNavigationTopology &&
            this.pendingWorktreeFallback &&
            this.reactions.worktreeFallback()
          )
            this.pendingWorktreeFallback = false
          if (this.paneLink) this.openLinkedSession(this.paneLink.sessionId, this.paneLink.worktree)
          if (this.pendingSessionNavigation)
            this.services.navigateToSession(this.pendingSessionNavigation)
          if (this.pendingNavigation) this.navigate(this.pendingNavigation)
          this.syncWorkspaceSelection()
          this.reactions.updateIssueVisitBaseline()
          this.reactions.updateMarkReadTimer()
          this.reactions.updateIssueMarkReadTimer()
        })
        this.watchNavigation()
      }),
    )
  }

  // ------------------------------------------------------------ state pipeline

  /** Writes are immediate; subscribers see only the completed batch, including
   *  its reaction cascade. Reactions read state(), never the published snapshot.
   *  A destroyed runtime refuses every asynchronous writer at this boundary. */
  private apply(patch: Partial<EngineState>): void {
    if (this.destroyed) return
    if ('machines' in patch) this.lastMachinesMaterial = undefined
    this.batch(() => {
      const changed = new Set<keyof EngineState>()
      for (const k of Object.keys(patch) as Array<keyof EngineState>) {
        const next = patch[k]
        if (!Object.is(this.state[k], next)) {
          ;(this.state as unknown as Record<string, unknown>)[k as string] = next
          changed.add(k)
          this.pendingChanges.add(k)
        }
      }
      if (changed.size === 0) return
      if (this.statsReactionDepth > 0) {
        // Preserve the synchronous reaction ordering: a nested selection write
        // restores its panes before the next reaction reads the current state.
        this.runReactions(changed)
      } else {
        for (const key of changed) this.pendingReactions.add(key)
      }
    })
  }

  private runReactions(changed: ReadonlySet<keyof EngineState>): void {
    this.statsReactionDepth++
    try {
      this.react(changed)
    } finally {
      this.statsReactionDepth--
    }
  }

  /** Explicit batches defer reactions until all writes land, then publish the
   * changed local keys once. Finally restores the boundary if a reaction throws. */
  private batch(fn: () => void): void {
    if (this.destroyed) return
    this.batchDepth++
    try {
      fn()
    } finally {
      try {
        if (this.batchDepth === 1) {
          const changed = this.pendingReactions
          this.pendingReactions = new Set()
          if (changed.size > 0) this.runReactions(changed)
        }
      } finally {
        this.batchDepth--
        if (this.batchDepth === 0) {
          const changed = this.pendingChanges
          this.pendingChanges = new Set()
          const drafts = this.pendingDrafts
          this.pendingDrafts = new Set()
          // Clear bookkeeping before notifying: listeners may write again.
          if (changed.size > 0 && !this.destroyed) {
            this.inputs.emit(changed, drafts)
          }
        }
      }
    }
  }

  /** Effect → reaction table (#262): each old provider useEffect either lives
   *  here keyed by the slices it depended on, or in start() (mount-once). */
  private react(changed: ReadonlySet<keyof EngineState>): void {
    const any = (...keys: Array<keyof EngineState>): boolean => keys.some((k) => changed.has(k))
    // ONE persistence reaction; routing and serialization live in ui-state.ts.
    if (!this.applyingHydratedUi) this.routerUi.flush(workspaceUiSnapshot(this.state), changed)
    // Worktree fallback selection.
    if (any('repos', 'reposLoaded', 'selectedWorktree') && !this.pendingNavigationTopology) {
      if (!this.reactions.worktreeFallback() && this.state.navigation) {
        this.pendingWorktreeFallback = true
        this.queueNavigationWake(this.state.navigation)
      }
    }
    // TASK SWITCH → restore that workspace's panes (POD-710). The layouts are
    // the truth; the pane scalars follow whichever workspace is now on screen.
    // Pool navigation invalidates the mission root when issue topology moves.
    if (any('selectedIssueId', 'selectedWorktree', 'navigation')) this.syncWorkspaceSelection()
    // A tab whose session or file is GONE (POD-710). Nothing else can remove it
    // — it renders nothing, so there is no ✕ to click — and it is persisted, so
    // it comes back on every reload until this drops it.
    // State→URL mirror — the single URL writer.
    if (any('selectedWorktree', 'paneA'))
      this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
    // View-state report to the server. `workspaces` is a trigger in its own
    // right: a third pane's active tab changes what is on screen without moving
    // `paneA`/`paneB`. `panelMode` is equally live: switching Native → Chat must
    // release the client terminal's takeover lease before a Chat turn can reach
    // the headless engine.
    if (
      any('paneA', 'paneB', 'split', 'focusedPane', 'workspaces', 'dockVisibleSession', 'panelMode')
    )
      this.reactions.reportViewState()
    // Mark-the-viewed-session-read reaction.
    if (any('paneA', 'paneB', 'split', 'focusedPane', 'workspaces', 'navigation'))
      this.reactions.updateMarkReadTimer()
    // …and the same for the issue the operator has in the foreground (POD-272).
    if (any('navigation', 'view', 'selectedIssueId', 'openIssueId'))
      this.reactions.updateIssueVisitBaseline()
    if (any('navigation', 'view', 'selectedIssueId', 'openIssueId'))
      this.reactions.updateIssueMarkReadTimer()
    if (
      any(
        'navigation',
        'selectedIssueId',
        'selectedWorktree',
        'view',
        'openIssueId',
        'paneA',
        'paneB',
        'split',
        'focusedPane',
        'workspaces',
      )
    )
      this.watchNavigation()
  }

  /** Re-derive the pane mirrors when the workspace on screen changes. A write
   *  INSIDE one workspace already carries its own mirror (workspaceWritePatch),
   *  so this fires only on the switch. */
  private syncWorkspaceSelection(): void {
    const key = resolvedWorkspaceKey(this.state)
    if (key === NAVIGATION_LOADING) return
    if (key === this.workspaceKey) return
    this.workspaceKey = key
    // Mirror only: switching to a task that has never been opened must not
    // persist an empty layout for it.
    this.apply(workspaceMirrorPatch(workspaceFor(this.state, key)))
  }

  /**
   * A SHORT SESSION ID IN A PANE LINK (POD-4637).
   *
   * The pane is adopted as-is first, like every pane — but a short id or birth
   * ref can never become a session row, so without this the tab named nothing
   * and the link silently opened nothing. The SERVER answers, through the CLI's
   * own rule (`sessions.resolve`); no client matches prefixes. A session answer
   * rewrites the link to its full id and the ordinary full-id path opens it;
   * ambiguous and absent SAY so. Either way the prefix tab goes.
   *
   * A full id never asks: it may be an optimistic spawn the server has not
   * confirmed, and that keeps its adopt-then-wait path. An unreachable server
   * leaves the adopted tab to the prune grace, as for any unknown pane.
   */
  private resolvePaneLink(pane: string | null | undefined): void {
    if (!pane || !isShortSessionIdentifier(pane)) {
      this.pendingPaneLink = null
      return
    }
    if (navigationSession(this.state, pane)) return
    this.pendingPaneLink = pane
    void Promise.resolve()
      .then(() => this.api.sessions.resolve.query({ identifier: pane }))
      .then(
        (answer) => this.adoptPaneLinkAnswer(pane, answer),
        (error: unknown) => log.debug('pane link resolve failed', { pane, error }),
      )
  }

  private adoptPaneLinkAnswer(pane: string, answer: SessionIdentifierResolution): void {
    if (this.destroyed || this.pendingPaneLink !== pane) return
    this.pendingPaneLink = null
    if (answer.kind === 'session') {
      const route = this.router.current()
      this.router.replace({ ...route, view: 'workspace', pane: answer.sessionId })
    } else {
      this.notices.error(sessionLinkProblem(pane, answer))
    }
    this.apply(
      workspacesPatch(this.state, (ws) => (allTabIds(ws).includes(pane) ? closeTab(ws, pane) : ws)),
    )
    // A COLD link seeds `paneA` from the URL before any layout holds it, so no
    // tab closed above; re-derive the scalars from the layout on screen.
    if (this.state.paneA === pane) {
      this.apply(workspaceMirrorPatch(workspaceFor(this.state, workspaceKeyForState(this.state))))
    }
  }

  /** Open a tab in the workspace a navigation is landing in — `selection` is the
   *  selected issue/worktree AFTER the navigation, which may not be the one on
   *  screen yet. */
  private openWorkspaceTab(
    tabId: string,
    selection?: { selectedIssueId?: IssueId | null; selectedWorktree?: string | null },
    permanent = true,
  ): WorkspacePatch {
    const st = overlayState(this.state, selection ?? {})
    const key = resolvedWorkspaceKey(st)
    if (key === NAVIGATION_LOADING) return {}
    const next = openTab(workspaceFor(st, key), tabId, { permanent })
    this.workspaceKey = key
    return workspaceWritePatch(st, key, next)
  }

  private syncReplicatedUi(): void {
    const persisted = this.routerUi.hydrate()
    const patch: Partial<EngineState> = {}
    if (persisted.dockTab !== this.state.dockTab) patch.dockTab = persisted.dockTab
    if (persisted.superOpen !== this.state.superOpen) patch.superOpen = persisted.superOpen
    if (JSON.stringify(persisted.panelMode) !== JSON.stringify(this.state.panelMode)) {
      // The replicated map REPLACES the local one wholesale (POD-3932): a write
      // from any of this person's other devices lands here as a full map, so a
      // per-session pick made on this device can be overwritten by a device
      // that never saw it. Name every session whose mode this replace changes.
      const local = this.state.panelMode
      const remote = persisted.panelMode
      const changed: Array<{ sessionId: string; from: string | null; to: string | null }> = []
      for (const sid of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        if (local[sid] !== remote[sid]) {
          changed.push({ sessionId: sid, from: local[sid] ?? null, to: remote[sid] ?? null })
        }
      }
      log.debug('replicated panel modes replaced the local map', {
        changed,
        localCount: Object.keys(local).length,
        remoteCount: Object.keys(remote).length,
      })
      patch.panelMode = remote
    }
    if (Object.keys(patch).length === 0) return
    this.applyingHydratedUi = true
    try {
      this.apply(patch)
    } finally {
      this.applyingHydratedUi = false
    }
  }

  // ------------------------------------------------------------------- routing

  private committingNavigation = false

  private navigate(intent: NavigationIntent): boolean {
    if (this.destroyed) return false
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    // Any navigation supersedes a link still waiting for its session, so a late
    // row never yanks the operator off where they went since (POD-4642).
    this.dropPaneLink()
    const plan = planNavigation(this.state, this.router.current(), intent, {
      visible: this.visibility.isVisible(),
      now: new Date().toISOString(),
    })
    if (plan.pending) {
      this.pendingNavigation = intent
      this.watchNavigation()
      return false
    }
    const changed = Object.entries(plan.patch).some(
      ([key, value]) => !Object.is(this.state[key as keyof EngineState], value),
    )
    // History validates/serializes before state is committed. Its synchronous
    // callback must not independently adopt the same destination and publish.
    this.committingNavigation = true
    try {
      if (plan.replace) this.router.replace(plan.route)
      else this.router.navigate(plan.route)
    } finally {
      this.committingNavigation = false
    }
    this.prevRoute = this.router.current()
    this.workspaceKey = plan.key
    this.apply(plan.patch)
    return changed
  }

  /**
   * URL ⇄ workspace pane state. While the workspace is the surface, the
   * selection mirrors into the query (replace — no history spam) so the URL
   * stays shareable; a route change carrying pane state (deep link,
   * back/forward) applies to the selection here.
   *
   * The URL→state direction only adopts a wt/pane VALUE THAT CHANGED in the
   * URL, and only a worktree that can actually be shown — an unknown ?wt=
   * settles deterministically: the URL is normalized to the fallback once.
   * Panes are adopted as-is, because an unknown pane has no fallback↔adopt pair
   * and so cannot oscillate: it becomes a real tab in the workspace it lands
   * in, and if it never resolves to a session or a file the prune reaction
   * retires it after its grace period (`Reactions.pruneWorkspaces`). It is NOT
   * the view's job — the view renders the layout and cannot see a tab that
   * resolves to nothing.
   *
   * NOTE (ADR 3 D7): the route is a VIEW selector and nothing more. No branch
   * here reads an identity from the URL — the principal arrives through the
   * provider, and a `?user=` in the address bar is inert by construction.
   */
  private onRouteChanged(route: RouteState): void {
    if (this.committingNavigation) return
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    const prev = this.prevRoute
    this.prevRoute = route
    const st = this.state
    const patch: Partial<EngineState> = {
      view: route.view,
      settingsTab: route.settingsTab,
      openIssueId: asIssueIdOrNull(route.issueId),
    }
    if (
      route.worktree &&
      route.worktree !== prev?.worktree &&
      route.worktree !== st.selectedWorktree
    ) {
      const worktrees = reposToViews(st.repos).flatMap((repo) => repo.worktrees)
      const crew = st.navigation.worktreeSessions?.()
      const canShow =
        !st.reposLoaded ||
        worktrees.some((w) => w.path === route.worktree) ||
        crew === NAVIGATION_LOADING ||
        (crew ?? []).some((s) => s.cwd === route.worktree || s.cwd.startsWith(`${route.worktree}/`))
      if (canShow) patch.selectedWorktree = route.worktree
    }
    // A pane the state is not already showing is a LINK (deep link, back/forward),
    // not this runtime's own mirror write.
    const linked = !!route.pane && route.pane !== prev?.pane && route.pane !== st.paneA
    if (!linked && route.pane !== prev?.pane) this.resolvePaneLink(route.pane)
    this.apply(patch)
    if (linked) this.followPaneLink(route)
    this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
  }

  /**
   * A `?pane=<session id>` LINK OPENS THAT SESSION (POD-4642).
   *
   * Cold and warm links both land here. A known session opens the way the
   * jump-to-session action opens it — its issue and worktree selected, its tab
   * active — because the tab strip draws the LAYOUT, and a pane scalar seeded
   * from the URL alone left the restored tab in front under the new link.
   *
   * A full id this replica does not hold yet is adopted as a tab, as before (it
   * may be an optimistic spawn, or a row still on its way), and remembered: its
   * arrival opens it, and the worktree fallback holds the linked worktree
   * meanwhile instead of swapping in another repo. If the prune grace passes
   * without it, the link SAYS so. Short ids ask the server
   * ({@link resolvePaneLink}); a session answer comes back through here as a
   * full id.
   */
  private followPaneLink(route: RouteState): void {
    const pane = route.pane
    this.dropPaneLink()
    this.resolvePaneLink(pane)
    if (!pane) return
    const short = isShortSessionIdentifier(pane)
    if (!short && this.openLinkedSession(pane, route.worktree ?? null)) return
    // A deep-linked pane is an OPEN, so the workspace it lands in gains the tab;
    // the mirror would otherwise erase it on the next layout write.
    this.apply(this.openWorkspaceTab(pane))
    if (short || pane.startsWith('file:')) return
    const timer = setTimeout(() => {
      if (this.paneLink?.sessionId !== pane) return
      this.dropPaneLink()
      if (this.destroyed || navigationSession(this.state, pane)) return
      this.notices.error(sessionLinkProblem(pane, { kind: 'absent' }))
      // The held worktree may name nothing now; let the fallback settle it.
      this.reactions.worktreeFallback()
    }, this.paneLinkGraceMs)
    this.paneLink = { sessionId: pane, worktree: route.worktree ?? null, timer }
  }

  /** Open a linked session this replica holds; false when it holds none. */
  private openLinkedSession(sessionId: string, worktree: string | null): boolean {
    const meta = navigationSession(this.state, sessionId)
    if (!meta) return false
    this.dropPaneLink()
    const selection = sessionLinkSelection(this.state, meta, worktree)
    // Already the active tab of the workspace it lands in (a plain reload):
    // nothing to move, and a split's focus stays where it was.
    const key = workspaceKeyForState(this.state)
    if (
      key === workspaceKeyForState(overlayState(this.state, selection)) &&
      workspaceMirrorPatch(workspaceFor(this.state, key)).paneA === sessionId
    )
      return true
    this.navigate({ view: 'workspace', ...selection, tabId: sessionId, history: 'view' })
    return true
  }

  private dropPaneLink(): void {
    if (!this.paneLink) return
    clearTimeout(this.paneLink.timer)
    this.paneLink = null
  }

  // -------------------------------------------------------------- outbox seams

  private onMutationApplied(entry: OutboxEntry): boolean {
    if (this.destroyed) return false
    const actionHold = this.reconcileActionState(entry, 'applied')
    this.emitOutcome({ type: 'applied', mutationId: entry.mutationId, entry })
    return actionHold ?? this.poolWriter?.holds?.(entry.mutationId) ?? false
  }

  private onMutationDropped(entry: OutboxEntry, reason?: OutboxRejectionReason): void {
    if (this.destroyed) return
    this.reconcileActionState(entry, 'dropped')
    this.emitOutcome({
      type: 'rejected',
      mutationId: entry.mutationId,
      entry,
      parked: shouldParkDeadLetter(entry.kind, entry.input),
      ...(reason ? { reason } : {}),
    })
  }

  private readonly outcomeListeners = new Set<(outcome: OutboxOutcome) => void>()

  /** Per-entry outbox outcomes (POD-4554). See {@link OutboxOutcome}. Bound so
   *  it can be passed bare. */
  readonly subscribeOutboxOutcomes = (listener: (outcome: OutboxOutcome) => void): (() => void) => {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }

  private emitOutcome(outcome: OutboxOutcome): void {
    for (const listener of [...this.outcomeListeners]) {
      try {
        listener(outcome)
      } catch (err) {
        // An observer must never wedge the drain that called us.
        log.warn('outbox outcome listener threw', { err, type: outcome.type })
      }
    }
  }

  /** Kinds whose truth is a tRPC read rather than a replicated row: the drain
   *  outcome re-fetches instead of holding an overlay. Returns null for the
   *  kinds whose truth and optimism the pool owns. */
  private reconcileActionState(entry: OutboxEntry, outcome: 'applied' | 'dropped'): boolean | null {
    if (entry.kind === 'layoutSet' || entry.kind === 'layoutClear') {
      if (outcome === 'dropped') {
        this.replicatedLayout.commandDropped(entry)
        return false
      }
      const hold = this.replicatedLayout.commandApplied(entry)
      if (hold) void this.boot.refreshReplicatedLayout([entry.mutationId]).catch(() => {})
      return hold
    }
    if (entry.kind === 'pinSet') {
      void this.boot.refreshPins().catch(() => {})
      return false
    }
    if (entry.kind === 'tabSetOrder') {
      void this.boot.refreshTabOrders().catch(() => {})
      return false
    }
    if (entry.kind === 'settingsUpdatePersonal') {
      void this.boot.refreshPersonalSettings().catch(() => {})
      return false
    }
    return null
  }

  // ------------------------------------------------------------------- actions

  /** Paint a draft. The ONLY writer of `state.drafts`, and it decides nothing —
   *  every caller has already asked the ledger who wins. */
  private applyDraftToStore(sessionId: SessionId, text: string): void {
    const d = this.state.drafts
    if (d[sessionId] === text) return
    this.pendingDrafts.add(sessionId)
    this.apply({ drafts: { ...d, [sessionId]: text } })
  }

  /**
   * Put this session's unsent text on the wire — after the debounce, or now.
   *
   * The send is deliberately NOT conditional on it succeeding. A frame the
   * socket refused leaves the entry dirty, which puts it in the reconnect flush
   * set; a frame that went out ALSO leaves it dirty until the server echoes it
   * back. Nothing here has to distinguish those two, which is why there is no
   * retry timer, no ack table and no queue: dirty means "the server has not
   * confirmed this", and there are exactly two moments it is worth saying again
   * — when typing pauses, and when the connection returns.
   */
  private scheduleDraftSend(sessionId: SessionId, opts: { immediate: boolean }): void {
    const existing = this.draftSendTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.draftSendTimers.delete(sessionId)
    if (opts.immediate) {
      this.sendDraftNow(sessionId)
      return
    }
    const timer = setTimeout(() => {
      this.draftSendTimers.delete(sessionId)
      this.sendDraftNow(sessionId)
    }, this.draftSendDebounceMs)
    timer.unref?.()
    this.draftSendTimers.set(sessionId, timer)
  }

  private sendDraftNow(sessionId: SessionId): void {
    if (this.destroyed) return
    const local = this.draftLedger.get(sessionId)
    // Not dirty means the server already agrees. Saying it again would be a
    // no-op edit the server has to arbitrate, persist and fan out.
    if (!local?.dirty) return
    this.hub.sendDraftEdit(sessionId, local.serverRev, local.text)
  }

  /** Re-offer every draft this device holds unsent. The reconnect edge. */
  private flushDirtyDrafts(): void {
    for (const sessionId of this.draftLedger.dirtySessions()) {
      this.scheduleDraftSend(sessionId, { immediate: true })
    }
  }

  /**
   * Write the drafts to device storage, coalesced.
   *
   * This is the half that makes typing survive a RELOAD with no server, and it
   * is the reason a draft is safe on a machine that has never been online. The
   * cap is applied here rather than at read time so the ledger and the stored
   * blob stay the same size — an unbounded local store of other people's
   * revoked sessions would be the slow leak this feature paid for.
   */
  private scheduleDraftPersist(): void {
    if (this.draftPersistTimer !== null) return
    const timer = setTimeout(() => {
      this.draftPersistTimer = null
      this.persistDrafts()
    }, this.draftPersistDebounceMs)
    timer.unref?.()
    this.draftPersistTimer = timer
  }

  /** Preserve the last keystroke and wait only for local queue durability.
   * Delivery and awaiting-truth entries are already durable and resume after reload. */
  readonly prepareReload = async (): Promise<void> => {
    if (this.destroyed) throw new Error('The draft owner changed; please retry reloading.')
    this.persistDrafts(true)
    await this.replica.uiState().flush?.()
    await this.outbox.flushLocalWrites?.()
    // Typing can continue while an IndexedDB enqueue commits.
    if (this.destroyed) throw new Error('The draft owner changed; please retry reloading.')
    if (this.draftPersistTimer !== null) clearTimeout(this.draftPersistTimer)
    this.draftPersistTimer = null
    this.persistDrafts(true)
    await this.replica.uiState().flush?.()
    await this.replica.flush()
    await this.outbox.flushLocalWrites?.()
    this.persistDrafts(true)
    await this.replica.uiState().flush?.()
  }

  private persistDrafts(strict = false): void {
    if (this.destroyed) return
    const snapshot = this.draftLedger.snapshot()
    const entries = Object.entries(snapshot)
    if (entries.length > DRAFT_KEEP_LIMIT) {
      const doomed = entries.sort((a, b) => b[1].editedAt - a[1].editedAt).slice(DRAFT_KEEP_LIMIT)
      for (const [sessionId] of doomed) {
        this.draftLedger.remove(sessionId as SessionId)
        delete snapshot[sessionId]
      }
    }
    try {
      this.ui.set(DRAFTS_UI_KEY, entries.length === 0 ? null : JSON.stringify(snapshot))
    } catch (err) {
      // A draft that cannot be cached is still on screen and still on its way to
      // the server. Losing the reload guarantee is not worth breaking the app.
      log.warn('could not cache this device drafts', { err })
      if (strict) throw err
    }
  }

  private getUserFocus(): UserFocus {
    return userFocus(this.state)
  }

  // Land a just-opened file/artifact tab on screen (#101) — the file-tab twin of
  // navigateToSession: opening a tab from a non-workspace view (the issues page,
  // the issue explorer) must switch to the workspace through the router.
  // Selecting the tab's issue/worktree keeps fileTabsForWorkspace from dropping
  // the tab and bouncing the pane.
  private revealFileTab(args: Parameters<EngineActionRuntime<TApi>['revealFileTab']>[0]): void {
    this.navigate({
      view: 'workspace',
      ...(args.issueId ? { selectedIssueId: args.issueId } : {}),
      ...(args.worktreePath ? { selectedWorktree: args.worktreePath } : {}),
      tabId: args.tabId,
      permanent: args.permanent !== false,
      ...(args.fileTab ? { fileTab: args.fileTab } : {}),
      ...(args.recentFile ? { recentFile: args.recentFile } : {}),
      retireOrphanFiles: true,
      history: 'push',
    })
  }

  private requirePoolWriter(): PoolWriter {
    if (!this.poolWriter || this.destroyed) throw new Error('Pool transactions are not attached')
    return this.poolWriter
  }

  private createActions(): EngineActions<TApi> {
    return createEngineActions({
      api: this.api,
      hub: this.hub,
      outbox: this.outbox,
      outboxSettlements: this.outboxSettlements,
      router: this.router,
      notices: this.notices,
      layoutSeed: layoutSnapshotFromRows(this.replica.rows('userLayouts')),
      onLayoutBaseInstalled: (snapshot) => this.persistLayoutBase(snapshot),
      state: () => this.state,
      apply: (patch) => this.apply(patch),
      navigate: (intent) => this.navigate(intent),
      waitForSessionNavigation: (identifier) => {
        this.dropPaneLink()
        this.pendingNavigation = undefined
        this.pendingSessionNavigation = identifier
        this.watchNavigation()
      },
      // S5: one publication per click. The gesture's synchronous paints share
      // this batch; the async outbox drain echo and background broadcasts stay
      // separate by construction (they fire after the batch closed).
      batch: (fn) => this.batch(fn),
      onLocals: (keys, listener) => this.onLocals(keys, listener),
      write: <K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]) =>
        this.poolWriter !== null
          ? this.poolWriter.write(kind, input)
          : Promise.reject(new Error('Pool transactions are not attached')),
      revealFileTab: (args) => this.revealFileTab(args),
      spawnDraftAgent: (args: Parameters<Store<TApi>['spawnDraftAgent']>[0]) =>
        this.requirePoolWriter().spawnDraftAgent!(args),
      spawnIssueAgent: (args: Parameters<Store<TApi>['spawnIssueAgent']>[0]) =>
        this.requirePoolWriter().spawnIssueAgent!(args),
      waitForSpawnConfirmed: (sessionId) =>
        this.requirePoolWriter().waitForSpawnConfirmed!(sessionId),
      // ONE KEYSTROKE. The store write is synchronous and unconditional — it is
      // what the caret is attached to. Everything else about this edit (when it
      // goes out, whether it went out, when it is written to disk) is a
      // consequence, and none of it can hold the typing up.
      setSessionDraft: (sessionId, text) => {
        this.draftLedger.localEdit(sessionId, text, Date.now())
        this.applyDraftToStore(sessionId, text)
        // A CLEAR is the tail of a send, and a send that leaves the draft
        // standing on another device for a quarter of a second reads as the
        // message having duplicated itself. It skips the debounce.
        this.scheduleDraftSend(sessionId, { immediate: text === '' })
        this.scheduleDraftPersist()
      },
      refreshSuperThreads: () => this.boot.refreshSuperThreads(),
    })
  }

  /**
   * Cache an authoritative layout base so the NEXT boot paints it on frame one.
   *
   * Only on the legacy wire. The kernel feed carries `userLayout` like every
   * other entity and its cache has exactly one ordered writer — `applySnapshot`
   * REFUSES there by design, and it is right to: those rows arrive through the
   * feed and need nothing from us. The legacy wire carries no layout at all, so
   * `api.layout.get.query()` is the only truth this device ever sees and this is
   * the one place it can be kept.
   *
   */
  private persistLayoutBase(snapshot: LayoutSnapshot): void {
    if (this.onFeed) return
    const userId = asUserId(this.principal.userId)
    try {
      this.replica.applySnapshot(
        'userLayouts',
        Object.entries(snapshot).map(([key, value]) => ({ userId, key, value })),
      )
    } catch (err) {
      // This runs INSIDE `installBase`, so a throw here would take the caller's
      // `emit()` with it and the base we just installed would never repaint —
      // trading a cold next boot for a broken current one. A cache write is
      // never worth that; the replica's own writes fail the same way, loudly in
      // the log and harmlessly to the app.
      log.warn('could not cache the layout base for the next boot', { err })
    }
  }

  private buildStatics(actions: EngineActions<TApi>): EngineStatics<TApi> {
    return {
      hub: this.hub,
      trpc: this.api,
      replica: this.replica,
      uiState: this.ui,
      readPosition: this.readPosition,
      httpOrigin: this.httpOrigin,
      // The ONE key resolver, published so no view re-derives it (POD-710).
      workspaceKey: () => workspaceKeyForState(this.state),
      getUserFocus: () => this.getUserFocus(),
      recoverOutbox: {
        retry: (id, satisfaction) => this.outbox.retry(id, satisfaction),
        edit: (id, input) => this.outbox.edit(id, input),
        discard: (id) => this.outbox.discard(id),
      },
      refreshRepos: () => this.boot.refreshRepos(),
      refreshSuperThreads: () => this.boot.refreshSuperThreads(),
      ...actions,
    } as EngineStatics<TApi>
  }
}

/** Persisted layout ROWS → the controller's snapshot shape. The rows are already
 *  this principal's (the replica is principal-scoped and the feed is per-user),
 *  so the key/value pair is all the controller needs back. */
function layoutSnapshotFromRows(rows: readonly LayoutWire[]): LayoutSnapshot {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

/**
 * Construct the client runtime for ONE principal.
 *
 * The ONLY production caller is `react/provider.tsx`. That is an audited
 * property, not a convention: `scripts/audit-phase2-client.ts` item 5 fails if a
 * second production site constructs a runtime, a replica, a socket hub or an
 * outbox, because a second construction site is a second principal boundary
 * nobody is watching.
 */
export function createClientRuntime<TApi extends PodiumClientApi = PodiumClientApi>(
  init: ClientRuntimeInit<TApi>,
): ClientRuntime<TApi> {
  return new ClientRuntime(init)
}
