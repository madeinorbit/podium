/**
 * THE CLIENT RUNTIME — the principal-scoped coordinator (POD-404).
 *
 * This file replaces `engine/engine.ts`, the 1,489-line god object the 6.1 split
 * (POD-328) exists to delete. What is left here is coordination and nothing
 * else: construct the collaborators, run one lifecycle over them, and own the
 * single state choke point they all write through.
 *
 *   TRANSPORT        socket-transport/  (POD-400) — socket, planes, PTY epoch/seq
 *   REPLICA-BINDING  replica-binding.ts (POD-401) — hydration + slice publication
 *   ACTIONS          actions.ts         (POD-402) — command dispatch + outbox
 *   ROUTER/UI-STATE  ui-state.ts        (POD-403) — the ONLY UI persistence
 *   OPTIMISM         optimism.ts        — the overlay ledger (#263)
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

import type { ReadPositionWire, IssueId, LayoutWire, SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import { createReadPositionClient, type ReadPositionPort } from '../read-position'
import type { ClientPrincipal } from '../principal'
import type { Replica } from '../replica/replica'
import type { FeedSinkPort, SocketHub } from '../socket-transport'
import { bindSwitchTraceUi } from '../perf/switch-trace'
import { NotificationSounder } from '../sound/notification-sounds'
import type { SpawnTarget } from '../spawn-agent'
import { createSubscriptionStore, type SubscriptionStore } from '../store'
import {
  createRouterUiState,
  createUiStateRouter,
  type RoutedUiState,
  type Router,
  type RouterUiState,
  type RouterWindow,
  type RouteState,
  routeDefaults,
} from '../ui-state'
import { type RecentFileEntry, reposToViews } from '../viewmodels'
import { createEngineActions, type EngineActions } from './actions'
import { BootFetches } from './boot'
import { dedupeSessions, OptimismLedger } from './optimism'
import { Reactions } from './reactions'
import {
  createReplicaBinding,
  type ReplicaBinding,
  type ReplicaPublication,
} from './replica-binding'
import type { ReplicatedLayoutController } from './replicated-layout'
import {
  asIssueIdOrNull,
  type EngineState,
  type EngineStatics,
  initialEngineState,
  tabIsVisible,
  userFocus,
  workspaceUiSnapshot,
} from './state'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type Store,
  type StoreNotices,
  type StoreServerConfig,
  type UserFocus,
} from './types'
import {
  type CreateEngineOutbox,
  type CreateHub,
  createEngineHub,
  createEngineOutbox,
  type EngineOutbox,
  type OutboxKinds,
} from './wiring'

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
  /** Test seam: overrides SPAWN_CONFIRM_GRACE_MS (#263 review finding 4). */
  spawnConfirmGraceMs?: number
}

export class ClientRuntime<TApi extends PodiumClientApi = PodiumClientApi> {
  /** The one principal this runtime serves. Read-only for its whole lifetime. */
  readonly principal: ClientPrincipal
  readonly replica: Replica
  readonly hub: SocketHub
  readonly outbox: EngineOutbox
  readonly router: Router
  readonly ui: RoutedUiState
  readonly replicatedLayout: ReplicatedLayoutController
  /** This person's event-stream read positions (POD-1380) — its own family
   *  because a cursor merges monotonically, not last-writer-wins. */
  readonly readPosition: ReadPositionPort

  private readonly replicaBinding: ReplicaBinding
  private readonly routerUi: RouterUiState
  private readonly optimism: OptimismLedger<TApi>
  private readonly reactions: Reactions
  private readonly boot: BootFetches<TApi>

  private readonly api: TApi
  private readonly notices: StoreNotices
  private readonly onFatalError: (message: string) => void
  private readonly formatError: (error: unknown, fallback: string) => string
  private readonly httpOrigin: string

  private readonly state: EngineState
  private readonly subStore: SubscriptionStore<Store<TApi>>
  /** The action methods + constant handles, spread into every snapshot so their
   *  identities never change for the runtime's lifetime. */
  private readonly statics: EngineStatics<TApi>

  // ---- internal (non-snapshot) state ----
  /** Server truth for this principal's slice — the replica's rows, unpainted. */
  private baseSessions: EngineState['sessions'] = []
  private baseIssues: EngineState['issues'] = []
  private baseIssueProjections: EngineState['issueProjections'] = []
  private prevRoute: RouteState
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private offs: Array<() => void> = []
  private started = false
  /** Set by destroy(). The state choke point refuses everything after it, so a
   *  superseded principal's late callback cannot reach any consumer. */
  private destroyed = false
  private applyingHydratedUi = false
  /** True when this runtime runs on the wire-v2 feed (POD-1223). */
  private readonly onFeed: boolean
  /** One-time boot fetches (repos/pins/tab-orders/settings) — once per runtime,
   *  even across a StrictMode dispose/re-start cycle. */
  private booted = false

  constructor(init: ClientRuntimeInit<TApi>) {
    this.principal = init.principal
    this.api = init.api
    this.notices = init.notices ?? NOOP_NOTICES
    this.onFatalError = init.onFatalError
    this.formatError = init.formatError ?? defaultFormatError
    this.httpOrigin = init.config.httpOrigin
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
    this.replicaBinding = createReplicaBinding({ replica: this.replica })
    this.hub = createEngineHub({
      wsClientUrl: init.config.wsClientUrl,
      api: this.api,
      replica: this.replica,
      onFatalError: (m) => this.onFatalError(m),
      createHub: init.createHub,
      feed: init.feed,
    })
    this.onFeed = init.feed !== undefined
    this.outbox = (init.createOutboxFn ?? createEngineOutbox)({
      api: this.api,
      replica: this.replica,
      notices: { error: (m) => this.notices.error(m), info: (m, d) => this.notices.info(m, d) },
      // Overlay lifecycle (#263): drain success hands the entry's overlay to
      // the awaiting-truth stage; a poison drop repaints without it.
      onApplied: (entry) => this.onMutationApplied(entry),
      onDropped: (entry) => this.onMutationDropped(entry),
      // The queue-size subscription is not the dead-letter event: a definitive
      // refusal can park before start() installs that subscription. Publish the
      // recovery projection at the event's own boundary so a live park cannot
      // remain durable-but-invisible.
      onDeadLetter: () => this.apply({ outboxDeadLetters: this.outbox.deadLetters() }),
    })
    this.optimism = new OptimismLedger<TApi>({
      api: this.api,
      outbox: this.outbox,
      notices: this.notices,
      base: () => ({
        sessions: this.baseSessions,
        issues: this.baseIssues,
        issueProjections: this.baseIssueProjections,
      }),
      paintedIssues: () => this.state.issues,
      publish: (patch) => this.apply(patch),
      ...(init.spawnConfirmGraceMs !== undefined
        ? { spawnConfirmGraceMs: init.spawnConfirmGraceMs }
        : {}),
    })
    const localUi = this.replica.uiState()
    this.router = createUiStateRouter(localUi, init.routerWindow)
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
    // Hydrate-first FIRST snapshot (#262 review): the replica's collections
    // load synchronous storage at construction, so seed the entity slices from
    // them BEFORE any subscriber reads — an empty initial snapshot regressed
    // that into "not found" flashes until start() (a passive effect) ran.
    const replicaSeed = this.replicaBinding.snapshot()
    this.baseSessions = dedupeSessions(replicaSeed.sessions)
    this.baseIssues = replicaSeed.issues
    this.baseIssueProjections = replicaSeed.issueProjections
    this.reactions = new Reactions({
      state: () => this.state,
      publish: (patch) => this.apply(patch),
      hub: this.hub,
      notices: this.notices,
      markSessionRead: (sessionId) => void this.statics.markSessionRead(sessionId),
      markIssueRead: (issueId) => void this.statics.markIssueRead(issueId),
    })
    this.reactions.seedCwds(this.baseSessions)
    // Fold queued outbox entries over the seed (#263): after an offline reload
    // the durable queue still paints its optimism in the VERY FIRST snapshot.
    const seededSessionFold = this.optimism.foldSeed(
      'sessions',
      this.baseSessions,
      (s) => s.sessionId,
    )
    const seededIssueFold = this.optimism.foldSeed('issues', this.baseIssues, (i) => i.id)
    const seededProjectionFold = this.optimism.foldSeed(
      'issueProjections',
      this.baseIssueProjections,
      (i) => i.id,
    )
    this.state = initialEngineState({
      persisted,
      route,
      sessions: seededSessionFold.rows,
      issues: seededIssueFold.rows,
      issueProjections: seededProjectionFold.rows,
      conversations: replicaSeed.conversations,
      automations: replicaSeed.automations,
      automationRuns: replicaSeed.automationRuns,
      // Hydrate-first, like the entity slices: the outbox constructor has
      // already restored its durable recovery home, so the first Store snapshot
      // must expose it without waiting for start() or a queue notification.
      outboxDeadLetters: this.outbox.deadLetters(),
      recoverOutbox: {
        // Every one of these repaints through the outbox subscription, because
        // recovery changes queue membership and queue membership IS overlay
        // membership (#263).
        retry: (mutationId, satisfaction) => {
          this.outbox.retry(mutationId, satisfaction)
          this.apply({ outboxDeadLetters: this.outbox.deadLetters() })
        },
        edit: (mutationId, input) => {
          this.outbox.edit(mutationId, input)
          this.apply({ outboxDeadLetters: this.outbox.deadLetters() })
        },
        discard: (mutationId) => {
          this.outbox.discard(mutationId)
          this.apply({ outboxDeadLetters: this.outbox.deadLetters() })
        },
      },
    })
    this.statics = this.buildStatics(actions)
    this.subStore = createSubscriptionStore<Store<TApi>>(this.buildSnapshot())
  }

  // ------------------------------------------------------------------ read seam

  /** useSyncExternalStore-shaped subscription. Bound so it can be passed bare. */
  readonly subscribe = (listener: () => void): (() => void) => this.subStore.subscribe(listener)
  readonly getSnapshot = (): Store<TApi> => this.subStore.getSnapshot()

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

    // Outbox → snapshot; attach re-arms drain triggers after a dispose. Queue
    // membership IS overlay membership (#263), so any enqueue/drop repaints
    // the entity lists too (a no-op publish when nothing visible changed).
    offs.push(
      this.outbox.subscribe((size) => {
        this.apply({ outboxSize: size, outboxDeadLetters: this.outbox.deadLetters() })
        this.replicatedLayout.outboxChanged()
        this.optimism.recomputeAll()
      }),
    )
    this.outbox.attach()
    this.apply({ outboxSize: this.outbox.size(), outboxDeadLetters: this.outbox.deadLetters() })
    // Restored awaiting-truth entries need the TTL backstop armed even if no
    // replica change ever recomputes them.
    this.optimism.armAwaitingSweep()

    // Entity state, single-sourced. ReplicaBinding owns preload + row
    // subscriptions and publishes a coalesced slice; the runtime never hydrates
    // or reaches collection listeners directly.
    offs.push(
      this.replicaBinding.start({
        publish: (publication) => this.publishReplica(publication),
        hydrated: (snap) => {
          // Wire-v1 compatibility. The kernel feed's persisted slice is already
          // the first Store paint and must never be copied into v1 hub lists.
          if (
            !this.onFeed &&
            snap.sessions.length +
              snap.issues.length +
              snap.conversations.length +
              snap.automations.length +
              snap.automationRuns.length >
              0
          ) {
            this.hub.seedMetadata(snap)
          }
        },
      }),
    )

    // Hub events, via the P5a `on()` subscription seam. Only ephemeral state
    // (host metrics, machines, drafts) mirrors hub events into the snapshot.
    offs.push(this.hub.on('hostMetrics', (m) => this.apply({ hostMetrics: m })))
    offs.push(this.hub.on('approvals', (a) => this.apply({ approvals: a })))
    // Repos are only scannable through a connected daemon, so a machine coming
    // online (e.g. the split daemon reconnecting after a restart) can make
    // previously-empty repos available. Refetch when the online count climbs, so
    // the workspace isn't stuck on the "add a repo" empty state until a reload.
    let onlineMachines = 0
    offs.push(
      this.hub.on('machines', (m) => {
        this.apply({ machines: m })
        const online = m.reduce((n, x) => n + (x.online ? 1 : 0), 0)
        if (online > onlineMachines) void this.boot.refreshRepos().catch(() => {})
        onlineMachines = online
      }),
    )
    offs.push(
      this.hub.on('sessionDraft', (sessionId, text) => this.adoptSessionDraft(sessionId, text)),
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
        if (h.status === 'ok' && prevHealth !== 'ok') this.outbox.notifyConnected()
        prevHealth = h.status
      }),
    )
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    offs.push(
      this.hub.on('attention', (e) => {
        if (tabIsVisible()) return
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
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.reactions.onVisibilityChange)
      offs.push(() =>
        document.removeEventListener('visibilitychange', this.reactions.onVisibilityChange),
      )
    }
    this.reactions.onVisibilityChange()

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      try {
        this.hub.connect()
      } catch (e) {
        this.onFatalError(this.formatError(e, 'WebSocket connection failed'))
      }
    }, 0)

    if (!this.booted) {
      void this.replicatedLayout.hydrate().catch(() => {})
      void this.readPosition.hydrate().catch(() => {})
      this.booted = true
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

    // Normalize the URL through the same owner that hydrates and flushes state.
    this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
  }

  /** Tear down everything start() armed. Idempotent; the runtime can re-start
   *  (React StrictMode's dev double-mount). This is NOT the principal boundary
   *  — see {@link destroy}. */
  dispose(): void {
    this.started = false
    bindSwitchTraceUi(null)
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.reactions.dispose()
    this.optimism.dispose()
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
    this.destroyed = true
  }

  /** True once {@link destroy} has run. The provider asserts on this so a
   *  teardown that silently did not happen cannot pass as one that did. */
  get isDestroyed(): boolean {
    return this.destroyed
  }

  // ------------------------------------------------------------ state pipeline

  /** THE state choke point: shallow-merge `patch` (Object.is per key), publish a
   *  fresh snapshot when anything changed, then run the reactions that used to
   *  be per-field useEffects. Reactions may nest apply() — each nested call
   *  publishes + reacts for its own change set, and every reaction converges
   *  (guards compare against current state, so a re-run is a no-op).
   *
   *  A DESTROYED runtime accepts nothing. This single guard is what makes the
   *  principal boundary hold against every asynchronous path at once, rather
   *  than requiring each of them to remember to check. */
  private apply(patch: Partial<EngineState>): void {
    if (this.destroyed) return
    const changed = new Set<keyof EngineState>()
    for (const k of Object.keys(patch) as Array<keyof EngineState>) {
      const next = patch[k]
      if (!Object.is(this.state[k], next)) {
        ;(this.state as unknown as Record<string, unknown>)[k as string] = next
        changed.add(k)
      }
    }
    if (changed.size === 0) return
    this.subStore.publish(this.buildSnapshot())
    this.react(changed)
  }

  /** Effect → reaction table (#262): each old provider useEffect either lives
   *  here keyed by the slices it depended on, or in start() (mount-once). */
  private react(changed: ReadonlySet<keyof EngineState>): void {
    const any = (...keys: Array<keyof EngineState>): boolean => keys.some((k) => changed.has(k))
    // ONE persistence reaction; routing and serialization live in ui-state.ts.
    if (!this.applyingHydratedUi) this.routerUi.flush(workspaceUiSnapshot(this.state), changed)
    // Session-follows-view policy: diffs consecutive session snapshots.
    if (changed.has('sessions')) this.reactions.worktreeFollow()
    // Worktree fallback selection.
    if (any('sessions', 'repos', 'reposLoaded', 'selectedWorktree'))
      this.reactions.worktreeFallback()
    // State→URL mirror — the single URL writer.
    if (any('selectedWorktree', 'paneA'))
      this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
    // View-state report to the server.
    if (any('paneA', 'paneB', 'split', 'focusedPane', 'dockVisibleSession'))
      this.reactions.reportViewState()
    // Mark-the-viewed-session-read reaction.
    if (any('sessions', 'paneA', 'paneB', 'split', 'focusedPane'))
      this.reactions.updateMarkReadTimer()
    // …and the same for the issue the operator has in the foreground (POD-272).
    if (any('issues', 'sessions', 'view', 'selectedIssueId', 'openIssueId'))
      this.reactions.updateIssueMarkReadTimer()
  }

  private buildSnapshot(): Store<TApi> {
    return { ...this.state, ...this.statics }
  }

  private syncReplicatedUi(): void {
    const persisted = this.routerUi.hydrate()
    const patch: Partial<EngineState> = {}
    if (persisted.dockTab !== this.state.dockTab) patch.dockTab = persisted.dockTab
    if (persisted.superOpen !== this.state.superOpen) patch.superOpen = persisted.superOpen
    if (JSON.stringify(persisted.panelMode) !== JSON.stringify(this.state.panelMode)) {
      patch.panelMode = persisted.panelMode
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

  /**
   * URL ⇄ workspace pane state. While the workspace is the surface, the
   * selection mirrors into the query (replace — no history spam) so the URL
   * stays shareable; a route change carrying pane state (deep link,
   * back/forward) applies to the selection here.
   *
   * The URL→state direction only adopts a wt/pane VALUE THAT CHANGED in the
   * URL, and only a worktree that can actually be shown — an unknown ?wt=
   * settles deterministically: the URL is normalized to the fallback once.
   * Panes are adopted as-is — an unknown pane has no fallback↔adopt pair
   * (Workspace holds or clears it) so it cannot oscillate.
   *
   * NOTE (ADR 3 D7): the route is a VIEW selector and nothing more. No branch
   * here reads an identity from the URL — the principal arrives through the
   * provider, and a `?user=` in the address bar is inert by construction.
   */
  private onRouteChanged(route: RouteState): void {
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
      const canShow =
        !st.reposLoaded ||
        worktrees.some((w) => w.path === route.worktree) ||
        st.sessions.some((s) => s.cwd === route.worktree || s.cwd.startsWith(`${route.worktree}/`))
      if (canShow) patch.selectedWorktree = route.worktree
    }
    if (route.pane && route.pane !== prev?.pane && route.pane !== st.paneA) {
      patch.paneA = asSessionId(route.pane)
    }
    this.apply(patch)
    this.routerUi.mirrorWorkspaceRoute(workspaceUiSnapshot(this.state))
  }

  // ----------------------------------------------------------- replica ↔ state

  private publishReplica(publication: ReplicaPublication): void {
    if (this.destroyed) return
    const { snapshot, changed } = publication
    if (changed.has('sessions')) {
      this.baseSessions = dedupeSessions(snapshot.sessions)
      this.optimism.recomputeSessions()
    }
    if (changed.has('issues')) {
      this.baseIssues = snapshot.issues
      this.optimism.recomputeIssues()
    }
    if (changed.has('issueProjections')) {
      this.baseIssueProjections = snapshot.issueProjections
      this.optimism.recomputeIssueProjections()
    }
    const patch: Partial<EngineState> = {}
    if (changed.has('conversations')) patch.conversations = snapshot.conversations
    if (changed.has('automations')) patch.automations = snapshot.automations
    if (changed.has('automationRuns')) patch.automationRuns = snapshot.automationRuns
    this.apply(patch)
  }

  // -------------------------------------------------------------- outbox seams

  private onMutationApplied(entry: OutboxEntry): boolean {
    if (this.destroyed) return false
    const actionHold = this.reconcileActionState(entry, 'applied')
    if (actionHold !== null) return actionHold
    return this.optimism.mutationApplied(entry)
  }

  private onMutationDropped(entry: OutboxEntry): void {
    if (this.destroyed) return
    this.reconcileActionState(entry, 'dropped')
    this.optimism.mutationDropped(entry)
  }

  /** Kinds whose truth is a tRPC read rather than a replicated row: the drain
   *  outcome re-fetches instead of holding an overlay. Returns null for the
   *  kinds the overlay ledger owns. */
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

  private adoptSessionDraft(sessionId: SessionId, text: string): void {
    const d = this.state.drafts
    if (d[sessionId] === text) return
    this.apply({ drafts: { ...d, [sessionId]: text } })
  }

  private getUserFocus(): UserFocus {
    return userFocus(this.state)
  }

  // Land a just-opened file/artifact tab on screen (#101) — the file-tab twin of
  // navigateToSession: opening a tab from a non-workspace view (issues page,
  // peek overlay) must switch to the workspace through the router. Selecting
  // the tab's issue/worktree keeps fileTabsForWorkspace from dropping the tab
  // and bouncing the pane; an open peek overlay is closed so the tab is visible.
  private revealFileTab(args: { tabId: string; worktreePath?: string; issueId?: IssueId }): void {
    this.apply({
      ...(args.issueId ? { selectedIssueId: args.issueId } : {}),
      ...(args.worktreePath ? { selectedWorktree: args.worktreePath } : {}),
      ...(this.state.peekIssueId ? { peekIssueId: null } : {}),
      paneA: asSessionId(args.tabId),
      focusedPane: 'A',
    })
    this.router.navigate({
      ...routeDefaults('workspace'),
      ...(args.worktreePath ? { worktree: args.worktreePath } : {}),
      pane: args.tabId,
    })
  }

  // Remember an opened file for the "+"-menu Recent-files list (POD-149) —
  // strict issue scoping hides a tab from every other issue's strip, so this
  // list is how a closed-over file stays reachable across the checkout.
  private recordRecentFile(entry: Omit<RecentFileEntry, 'openedAt'>): void {
    const key = (e: Omit<RecentFileEntry, 'openedAt'>): string =>
      `${e.worktreePath}\u0000${e.path}\u0000${e.artifact?.artifactId ?? ''}`
    const k = key(entry)
    const rest = this.state.recentFiles.filter((e) => key(e) !== k)
    this.apply({ recentFiles: [{ ...entry, openedAt: Date.now() }, ...rest].slice(0, 30) })
  }

  private createActions(): EngineActions<TApi> {
    return createEngineActions({
      api: this.api,
      hub: this.hub,
      outbox: this.outbox,
      router: this.router,
      notices: this.notices,
      state: () => this.state,
      apply: (patch) => this.apply(patch),
      enqueueOverlayed: <K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]) => {
        void this.optimism.enqueueOverlayed(kind, input)
      },
      revealFileTab: (args) => this.revealFileTab(args),
      recordRecentFile: (entry) => this.recordRecentFile(entry),
      spawnDraftAgent: (args: {
        target: SpawnTarget
        agentKind: Parameters<OptimismLedger<TApi>['spawnDraftAgent']>[0]['agentKind']
        firstPrompt?: string
      }) => this.optimism.spawnDraftAgent(args),
      setSessionDraft: (sessionId, text) => {
        this.adoptSessionDraft(sessionId, text)
        this.hub.sendSessionDraft(sessionId, text)
      },
      refreshSuperThreads: () => this.boot.refreshSuperThreads(),
    })
  }

  private buildStatics(actions: EngineActions<TApi>): EngineStatics<TApi> {
    return {
      hub: this.hub,
      trpc: this.api,
      replica: this.replica,
      uiState: this.ui,
      readPosition: this.readPosition,
      httpOrigin: this.httpOrigin,
      getUserFocus: () => this.getUserFocus(),
      refreshRepos: () => this.boot.refreshRepos(),
      refreshSuperThreads: () => this.boot.refreshSuperThreads(),
      ...actions,
    } as EngineStatics<TApi>
  }
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
