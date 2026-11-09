/** One principal-scoped client root: replica, pool, live and UI stores,
 * conversations and services. start/stop are reversible for React; dispose
 * is the irreversible sign-out boundary. The platform ReplicaAssembly owns
 * closing persistent storage, including during same-principal rebuilds. */

import { createLogger } from '@podium/logger'
import type { IssueId, ReadPositionSnapshot, ReadPositionWire, SessionId } from '@podium/model'
import {
  type CheckoutRepository,
  isMachinePathWithinRoot,
  machinePathsEqual,
  readPositionRowId,
  repositoriesFromCheckouts,
  resolveUserPreferences,
  userPreferencesRowId,
} from '@podium/model'
import { actionBound, observableRef, reaction, runInAction } from 'mobx'
import type { PodiumClientApi } from '../api'
import { type Commands, createCommands } from '../commands'
import { ConversationCache, type ConversationCacheOptions } from '../conversation/cache'
import { DraftStore } from '../conversation/draft-store'
import { createChatSends } from '../conversation/sends'
import { LiveFrameQueue } from '../live/frame-queue'
import { LiveFeed } from '../live/live-feed'
import { LiveStore } from '../live/live-store'
import { createNotices, NOOP_NOTICES, type NoticeSink } from '../notices'
import type { OnlineEvents } from '../outbox'
import { bindStoreStatsOwner } from '../perf/store-stats'
import { bindSwitchTraceUi } from '../perf/switch-trace'
import { type ClientPrincipal, memberFencedSocketUrl } from '../principal'
import { createReadPositionClient, type ReadPositionPort } from '../read-position'
import { createRecordsApi } from '../records'
import type { Replica } from '../replica/kernel/facade'
import type { VisibilitySource } from '../runtime-root/connection/visibility'
import type { OutboxOutcome } from '../runtime-root/outbox/outbox-service'
import type { OutboxKinds } from '../runtime-root/outbox/wiring'
import { DraftResendService } from '../runtime-root/services/draft-resend-service'
import { FollowService } from '../runtime-root/services/follow-service'
import { MarkReadService } from '../runtime-root/services/mark-read-service'
import { NotificationService } from '../runtime-root/services/notification-service'
import { PaneLinkService } from '../runtime-root/services/pane-link-service'
import { TabPruningService } from '../runtime-root/services/tab-pruning-service'
import { ViewStateService } from '../runtime-root/services/view-state-service'
import type { FeedSinkPort, SocketHubOptions } from '../socket-transport'
import { createNotificationSounds, type SessionPhaseChange } from '../sound/notification-sounds'
import { openLegacyDeviceKeys } from '../ui/draft-storage'
import { createUiKeys } from '../ui/keys'
import { LayoutAccess } from '../ui/layout-access'
import { type NavigationIntent, planNavigation } from '../ui/navigation'
import { UiPersistence } from '../ui/persistence'
import type { ScreenState } from '../ui/state'
import {
  asIssueIdOrNull,
  NAVIGATION_LOADING,
  type NavigationProvider,
  overlayState,
  resolvedWorkspaceKey,
  type WorkspacePatch,
  workspaceFor,
  workspaceWritePatch,
} from '../ui/state'
import { UiStore } from '../ui/ui-store'
import { UrlMirror } from '../ui/url-mirror'
import {
  AutoContinueDialogModel,
  PaletteViewModel,
  TranscriptRevealActions,
} from '../ui/view-models'
import {
  createRouter,
  type RoutedUiState,
  type Router,
  type RouterWindow,
  type RouteState,
} from '../ui-state'
import { openTab, reposToViews } from '../values'
import { ConnectionService } from './connection/connection-service'
import type { CreateHub } from './connection/hub'
import { OutboxService } from './outbox/outbox-service'
import type { CreateEngineOutbox } from './outbox/wiring'
import { defaultFormatError, type ServerConfig } from './types'

export interface PoolWriter {
  spawnDraftAgent?: Commands['sessions']['spawnDraftAgent']
  launchSession?: Commands['sessions']['launch']
  startIssueSession?: Commands['sessions']['startIssueSession']
  spawnIssueAgent?: Commands['sessions']['spawnIssueAgent']
  waitForSpawnConfirmed?: (id: SessionId) => Promise<void>
  /** A failed draft start's Remove (POD-6408). */
  dismissLaunch?: (id: SessionId) => boolean
  /** A start the pool paints, with no session row yet (POD-6622). */
  launchPainted?: (id: SessionId) => boolean
  dispose?: () => void
  write<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): Promise<void>
}

export type CreateReplicaForPrincipal = (principal: ClientPrincipal) => Replica

export interface ClientRuntimeInit<TApi extends PodiumClientApi = PodiumClientApi> {
  /**
   * WHOSE CLIENT THIS IS. Supplied by the provider from the authenticated
   * transport (ADR 3 D7) — never from the URL, storage, a payload or a name the
   * user typed. See `src/principal.ts`.
   */
  routerWindow?: RouterWindow
  workspacePruneGraceMs?: number
  draftSendDebounceMs?: number
  draftPersistDebounceMs?: number
  principal: ClientPrincipal
  config: ServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). */
  notices?: NoticeSink
  /**
   * Replica factory — mobile injects the AsyncStorage-backed one, web the
   * IndexedDB kernel assembly. Called ONCE, with this root's principal.
   *
   * REQUIRED since POD-1239: a client that can build its own replica is a
   * construction site outside every composition root, and the flag-off browser
   * client used to adopt whatever ambient `localStorage` held.
   */
  createReplicaFn: CreateReplicaForPrincipal
  /** Test seam: replaces SocketHub construction (unit tests inject a fake). */
  createHub?: CreateHub
  /**
   * WIRE v2 / kernel replica (POD-1223). Supplied together with a
   * `createReplicaFn` that returns the kernel-backed facade: the platform layer
   * builds the whole assembly (store, kernel Replica, feed sink) for ONE
   * principal and hands the root its two ends. Absent ⇒ the shipped v1 path.
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
  makeSocket?: SocketHubOptions['makeSocket']
  /** Open the local runtime without contacting the configured authority. */
  networkEnabled?: boolean
}

export interface ClientServices {
  readonly follow: import('./services/follow-service').FollowService
  readonly paneLinks: import('./services/pane-link-service').PaneLinkService
  readonly tabPruning: import('./services/tab-pruning-service').TabPruningService
  readonly markRead: import('./services/mark-read-service').MarkReadService
  readonly viewState: import('./services/view-state-service').ViewStateService
  readonly notifications: import('./services/notification-service').NotificationService
  readonly draftResend: import('./services/draft-resend-service').DraftResendService
}

/** The root's services. None of them is visible to components. */
export interface RuntimeServices extends ClientServices {
  readonly connection: ConnectionService
  readonly outbox: OutboxService
  readonly topics: LiveFeed
}

const log = createLogger('client-core:runtime')

export class ClientRuntime<TApi extends PodiumClientApi = PodiumClientApi> {
  /** The one principal this root serves. Read-only for its whole lifetime. */
  readonly principal: ClientPrincipal
  /** The app's typed tRPC client. */
  readonly api: TApi
  readonly httpOrigin: string
  /** The replica opened for {@link principal}. */
  readonly replica: Replica
  /**
   * THE LIVESTORE (POD-5798): this user's conditions (connection, machine online
   * and load, quota and usage, unsent writes). Never saved; disposed at
   * sign-out. Models and screens read it; only the services write it.
   */
  readonly live: LiveStore
  readonly services: RuntimeServices

  private readonly frames: LiveFrameQueue
  private readonly networkEnabled: boolean
  private conversationCache: ConversationCache | undefined
  readonly commands: Commands<TApi>
  readonly chatSends: import('../conversation/sends').ChatCommands
  private readonly clientServices: ClientServices
  private started = false
  private disposed = false

  readonly router: Router
  readonly ui: UiStore
  readonly deviceState: RoutedUiState
  readonly layout: LayoutAccess
  /** This person's event-stream read positions (POD-1380) — its own family
   *  because a cursor merges monotonically, not last-writer-wins. */
  readonly readPosition: ReadPositionPort

  private readonly uiPersistence: UiPersistence
  private readonly urlMirror: UrlMirror
  private readonly follow: FollowService
  private readonly markRead: MarkReadService
  private readonly paneLinks: PaneLinkService

  readonly notices: NoticeSink
  private readonly onFatalError: (message: string) => void
  private readonly formatError: (error: unknown, fallback: string) => string

  /** Where this client learns whether it is on screen: the root's connection service owns it. */
  private get visibility(): VisibilitySource {
    return this.services.connection.visibility
  }
  readonly palette = new PaletteViewModel()
  readonly autoContinueDialog = new AutoContinueDialogModel()
  readonly transcriptReveals = new TranscriptRevealActions()

  private pendingNavigation: NavigationIntent | undefined
  private pendingSessionNavigation: string | undefined
  private prevRoute: RouteState | undefined = undefined
  private offs: Array<() => void> = []
  private sessionPhases: (() => readonly SessionPhaseChange[]) | undefined
  private sounds: ReturnType<typeof createNotificationSounds> | undefined

  /** The pool supplies only addressed phase edges; runtime owns the reaction. */
  readonly attachSessionPhases = (read: () => readonly SessionPhaseChange[]): (() => void) => {
    if (this.sessionPhases) throw new Error('Session phases already attached')
    this.sounds?.stop()
    this.sessionPhases = read
    if (this.started) this.sounds?.start()
    return () => {
      if (this.sessionPhases !== read) return
      this.sounds?.stop()
      this.sessionPhases = undefined
    }
  }
  readonly drafts: DraftStore
  /** One-time boot work, once per runtime, even across a StrictMode
   *  stop/re-start cycle. */
  private booted = false

  constructor(init: ClientRuntimeInit<TApi>) {
    this.principal = init.principal
    this.api = init.api
    this.httpOrigin = init.config.httpOrigin
    this.networkEnabled = init.networkEnabled ?? true
    this.notices = init.notices ?? NOOP_NOTICES
    this.onFatalError = init.onFatalError
    this.formatError = init.formatError ?? defaultFormatError
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
    this.frames = new LiveFrameQueue()
    // The store's metrics demand reaches the feed it was built before.
    let topics: LiveFeed | undefined
    this.live = new LiveStore({
      onMetricsDemand: (id, watched) => topics?.watchMetrics(id, watched),
      onUsageDemand: (watched) => topics?.watchUsage(watched),
    })
    const connection = new ConnectionService({
      // The member fence (POD-6292): this socket is this principal's, and the
      // server refuses it if the shared cookie jar now holds someone else's.
      wsClientUrl: memberFencedSocketUrl(init.config.wsClientUrl, init.principal.userId),
      api: init.api,
      replica: this.replica,
      live: this.live,
      frames: this.frames,
      onFatalError: (m) => init.onFatalError(m),
      formatError: (e, f) => this.formatError(e, f),
      networkEnabled: this.networkEnabled,
      ...(init.visibility !== undefined ? { visibility: init.visibility } : {}),
      ...(init.createHub !== undefined ? { createHub: init.createHub } : {}),
      ...(init.feed !== undefined ? { feed: init.feed } : {}),
      ...(init.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: init.heartbeatIntervalMs }
        : {}),
      ...(init.makeSocket !== undefined ? { makeSocket: init.makeSocket } : {}),
    })
    const replica = this.replica
    topics = new LiveFeed({
      hub: connection.hub,
      // The machines whose condition is held: the `machine` records (POD-6644).
      machines: {
        ids: () => replica.rows('machines').map((machine) => String(machine.id)),
        subscribe: (changed) =>
          replica.subscribeAddressedBatch?.((batch) => {
            if (batch.type === 'replace' || batch.rows.some((row) => row.kind === 'machines')) {
              changed()
            }
          }) ?? (() => {}),
      },
      live: this.live,
      userId: init.principal.userId,
      frames: this.frames,
    })
    const outbox = new OutboxService({
      api: init.api,
      replica: this.replica,
      live: this.live,
      frames: this.frames,
      notices: this.notices,
      connection,
      networkEnabled: this.networkEnabled,
      ...(init.createOutboxFn !== undefined ? { createOutboxFn: init.createOutboxFn } : {}),
      ...(init.onlineEvents !== undefined ? { onlineEvents: init.onlineEvents } : {}),
      ...(init.isOnline !== undefined ? { isOnline: init.isOnline } : {}),
    })
    this.services = { connection, outbox, topics } as RuntimeServices
    bindStoreStatsOwner(this.replica, this)
    const device = this.replica.deviceStorage()
    const localUi = openLegacyDeviceKeys(device)
    this.router = createRouter({ win: init.routerWindow, fallbackView: 'workspace' })
    // Synced layout is a pool handle. Device state loads below, independently.
    this.layout = new LayoutAccess(
      this.principal.userId,
      createRecordsApi((kind, input) => this.requirePoolWriter().write(kind, input)),
      (error) => this.notices.error(this.formatError(error, 'Could not save view options')),
    )
    // An advance is a queued edit of my `userReadPosition` record (POD-6673):
    // painted at once, kept offline, retired by its receipt.
    const readPositionRecords = createRecordsApi((kind, input) =>
      this.poolWriter !== null
        ? this.poolWriter.write(kind, input)
        : Promise.reject(new Error('Pool transactions are not attached')),
    )
    this.readPosition = createReadPositionClient({
      write: async (streamId, value) =>
        await readPositionRecords.edit(
          { kind: 'userReadPosition', id: readPositionRowId(this.principal.userId, streamId) },
          { lastEventId: value.lastEventId, seenAt: value.seenAt },
        ),
      local: localUi,
      onError: (message) => this.notices.error(message),
    })
    this.deviceState = createUiKeys(() => this.ui, localUi, this.layout)
    this.ui = new UiStore({
      api: this.api,
      hub: this.services.connection.hub,
      notices: this.notices,
      keys: this.deviceState,
      router: this.router,
      repositories: () => this.repositories(),
      isVisible: () => this.visibility.isVisible(),
      revealTranscript: (sessionId, itemKey) => this.transcriptReveals.reveal(sessionId, itemKey),
      watch: (_keys, listener) => {
        return reaction(() => [this.ui.selectedIssueId, this.ui.navigation], listener)
      },
      navigate: (intent) => this.navigate(intent),
      waitForSessionNavigation: (identifier) => {
        this.paneLinks.cancel()
        this.pendingNavigation = undefined
        this.pendingSessionNavigation = identifier
        this.follow.refreshWatch()
      },
    })
    this.uiPersistence = new UiPersistence(this.ui, device, localUi, this.visibility)
    // Planners read UiStore directly.
    Object.defineProperties(this.ui.screen, {
      paletteOpen: { enumerable: false, get: () => this.palette.open },
      autoContinuePromptSessionId: {
        enumerable: false,
        get: () => this.autoContinueDialog.sessionId,
      },
    })
    bindSwitchTraceUi(this.deviceState)
    const parsed = this.router.current()
    const emptyPath = !init.routerWindow
      ? typeof window === 'undefined' || /^\/(?:w\/[^/]+\/?)?$/.test(window.location.pathname)
      : /^\/(?:w\/[^/]+\/?)?$/.test(init.routerWindow.location.pathname)
    if (emptyPath && !parsed.pane && !parsed.worktree)
      this.router.replace({
        ...parsed,
        view: this.ui.view,
        settingsTab: this.ui.settingsTab,
        issueId: this.ui.openIssueId,
        worktree: this.ui.selectedWorktree,
        pane: this.ui.paneA,
      })
    else
      this.ui.patch({
        view: parsed.view,
        settingsTab: parsed.settingsTab,
        openIssueId: parsed.issueId,
        ...(parsed.worktree ? { selectedWorktree: parsed.worktree } : {}),
      })
    this.urlMirror = new UrlMirror(
      this.ui,
      this.router,
      (route) => this.onRouteChanged(route),
      () => this.paneLinks?.pendingPane ?? null,
    )
    this.follow = new FollowService({
      state: () => this.ui.screen,
      publish: (patch) => this.ui.patch(patch),
      notices: this.notices,
      isVisible: () => this.visibility.isVisible(),
      linkedWorktree: () => this.paneLinks?.linkedWorktree ?? null,
      repositories: () => this.repositories(),
      checkoutsKnown: () =>
        this.replica.getCursor() !== null || (this.replica.rowCount?.('checkouts') ?? 0) > 0,
      subscribeCheckouts: (changed) => {
        const off = this.replica.subscribeAddressedBatch?.((batch) => {
          if (batch.type === 'replace' || batch.rows.some((row) => row.kind === 'checkouts')) {
            this.heldRepositories = repositoriesFromCheckouts(this.replica.rows('checkouts'))
            changed()
          }
        })
        this.heldRepositories = repositoriesFromCheckouts(this.replica.rows('checkouts'))
        return () => {
          off?.()
          this.heldRepositories = undefined
        }
      },
      readPending: () => {
        const pending = this.pendingNavigation
        const session = this.pendingSessionNavigation
          ? this.ui.screen.navigation.session(this.pendingSessionNavigation)
          : undefined
        return [
          session && session !== NAVIGATION_LOADING
            ? [session.sessionId, session.issueId, session.cwd]
            : session,
          pending
            ? resolvedWorkspaceKey(
                overlayState(this.ui.screen, {
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
      retryPending: () => {
        if (this.pendingSessionNavigation) this.ui.navigateToSession(this.pendingSessionNavigation)
        if (this.pendingNavigation) this.navigate(this.pendingNavigation)
      },
    })
    this.markRead = new MarkReadService({
      state: () => this.ui.screen,
      publishBaseline: (baseline) => this.ui.setIssueVisitBaseline(baseline),
      isVisible: () => this.visibility.isVisible(),
      connection: this.services.connection,
      markSessionRead: (id, at) => this.commands.sessions.markRead(id, at),
      markIssueRead: (id, at) => this.commands.issues.markRead(id, at),
    })
    this.paneLinks = new PaneLinkService({
      state: () => this.ui.screen,
      publish: (patch) => this.ui.patch(patch),
      router: this.router,
      notices: this.notices,
      resolve: (identifier) => this.api.sessions.resolve.query({ identifier }),
      repositories: () => this.repositories(),
      navigate: (intent) => this.navigate(intent),
      openWorkspaceTab: (id) => this.openWorkspaceTab(id),
      fallback: () => this.follow.refreshFallback(),
      graceMs: init.workspacePruneGraceMs,
    })
    // Drafts are hydrate-first for the same reason the entity slices are, and
    // with more at stake: this is the person's own unsent writing, and a first
    // paint without it is an empty composer where a half-written message was.
    // It happens HERE rather than in start() because start() is a passive
    // effect — a frame late is a frame of blank box, and on a cold boot with no
    // server there is nothing else that would ever fill it in.
    this.drafts = new DraftStore({
      storage: this.deviceState,
      hub: this.services.connection.hub,
      onStorageError: (err) => log.warn('could not cache this device drafts', { err }),
      sendDebounceMs: init.draftSendDebounceMs,
      persistDebounceMs: init.draftPersistDebounceMs,
    })
    this.commands = this.createCommands()
    this.chatSends = createChatSends({
      outbox: this.services.outbox.queue,
      outboxSettlements: this.services.outbox.settlements,
      waitForSpawnConfirmed: (id) => this.requirePoolWriter().waitForSpawnConfirmed!(id),
    })
    this.clientServices = {
      follow: this.follow,
      paneLinks: this.paneLinks,
      tabPruning: new TabPruningService({
        state: () => this.ui.screen,
        publish: (patch) => this.ui.patch(patch),
        pruneGraceMs: init.workspacePruneGraceMs,
        ready: () => !this.follow.pendingTopology,
      }),
      markRead: this.markRead,
      viewState: new ViewStateService({
        state: () => this.ui.screen,
        hub: this.services.connection.hub,
        connection: this.services.connection,
      }),
      notifications: new NotificationService(this.services.connection.hub, this.visibility),
      draftResend: new DraftResendService(this.drafts, this.services.connection),
    }
    Object.assign(this.services, this.clientServices)
    this.urlMirror.adoptCurrent()
  }

  get conversations(): ConversationCache | undefined {
    return this.conversationCache
  }

  readonly ownConversations = (options: ConversationCacheOptions): ConversationCache => {
    if (this.disposed) throw new Error('The conversation owner has changed')
    this.conversationCache ??= new ConversationCache(options)
    return this.conversationCache
  }

  private releaseConversations(): void {
    this.conversationCache?.dispose()
    this.conversationCache = undefined
  }

  private readonly disposals = new Set<() => void>()

  /** Register the platform's data attachment while it is active. */
  onDispose(dispose: () => void): () => void {
    if (this.disposed) {
      dispose()
      return () => {}
    }
    this.disposals.add(dispose)
    return () => this.disposals.delete(dispose)
  }

  /** A port avoids a client-core dependency on client-graph. The graph owns its
   * concrete DataStore type; this root owns its principal lifetime. */
  @observableRef accessor pool: object | undefined = undefined
  private poolAttachment: { dispose(): void } | undefined

  attachPool(pool: object, dispose: () => void): () => void {
    if (this.disposed) throw new Error('The pool owner has changed')
    if (this.poolAttachment) throw new Error('A pool is already attached')
    const attachment = { dispose }
    this.poolAttachment = attachment
    runInAction(() => {
      this.pool = pool
    })
    return () => {
      if (this.poolAttachment !== attachment) return
      this.poolAttachment = undefined
      runInAction(() => {
        this.pool = undefined
      })
      dispose()
    }
  }

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
   *  run the boot fetches. Idempotent while started; re-arms after stop().
   *  A DESTROYED runtime never re-arms — its principal is gone. */
  @actionBound start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.drafts.start()
    const offs = this.offs

    this.uiPersistence.start()
    // THE ROOT (POD-6681): the outbox service attaches the queue and publishes
    // its counts (PoolTransactions owns paint), the topics follow the server,
    // and the connection service arms its listeners and dials on the next
    // macrotask.
    const { connection, outbox, topics } = this.services
    outbox.start()
    if (this.networkEnabled) topics.start()
    for (const service of Object.values(this.clientServices)) service.start()
    connection.start()
    this.urlMirror.start()
    void this.replica.hydrate().catch((error) => {
      if (!this.disposed) this.onFatalError(this.formatError(error, 'Could not load local data'))
    })
    // My read positions are synced records the replica keeps (POD-6673): a
    // position moved on my other device arrives here, and a reload paints the
    // stored one before the network answers. No request reads them.
    const installReadPositions = (): void =>
      this.readPosition.replace(
        readPositionSnapshotFromRows(this.replica.rows('userReadPositions'), this.principal.userId),
      )
    installReadPositions()
    offs.push(this.replica.subscribeRows('userReadPositions', installReadPositions))

    this.sounds ??= createNotificationSounds({
      ui: this.deviceState,
      phases: () => this.sessionPhases?.() ?? [],
      visibleSessionIds: () => this.ui.getUserFocus().visibleSessionIds ?? [],
    })
    // The provider starts the runtime before attaching the pool. Wait for its
    // observable source; attachSessionPhases starts sounds when it arrives.
    if (this.sessionPhases) this.sounds.start()
    offs.push(() => this.sounds?.stop())

    if (!this.booted) {
      this.booted = true
      if (this.networkEnabled) {
        this.readPosition.drainLegacy()
        // Nothing is fetched at boot: superagent threads (POD-6675), machines
        // and repositories (POD-6644) are synced records the replica holds.
      }
    }
  }

  /** Tear down everything start() armed. Idempotent; the runtime can re-start
   *  (React StrictMode's dev double-mount). This is NOT the principal boundary
   *  — see {@link dispose}. */
  @actionBound stop(): void {
    this.started = false
    bindSwitchTraceUi(null)
    this.paneLinks.cancel()
    this.drafts.stop()
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        // teardown is best-effort
      }
    }
    this.urlMirror.stopMirroring()
    this.uiPersistence.stopSaving()
    // Topics, the queue's drain and the socket, as before: last.
    const { connection, outbox, topics } = this.services
    for (const service of Object.values(this.clientServices).reverse()) service.stop()
    topics.stop()
    outbox.stop()
    connection.stop()
  }

  /** Sign-out releases all objects owned by this principal. Persistent replica
   * storage belongs to the platform ReplicaAssembly, which may be reused by a
   * same-principal provider rebuild and closes at the platform account boundary. */
  @actionBound dispose(options: { eraseUi?: boolean } = {}): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.releaseConversations()
    this.drafts.dispose()
    this.stop()
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    if (options.eraseUi) this.uiPersistence.erase()
    for (const dispose of [...this.disposals]) dispose()
    this.disposals.clear()
    // The root's sign-out: services, the frame queue and every reading.
    const pool = this.poolAttachment
    this.poolAttachment = undefined
    this.pool = undefined
    pool?.dispose()
    this.poolWriter?.dispose?.()
    this.poolWriter = null
    const { connection, outbox, topics } = this.services
    for (const service of Object.values(this.clientServices).reverse()) service.dispose()
    outbox.dispose()
    topics.dispose()
    connection.dispose()
    this.frames.dispose()
    this.live.dispose()
    this.ui.dispose()
    this.palette.dispose()
    this.autoContinueDialog.dispose()
    this.transcriptReveals.dispose()
  }

  /** An account that has signed out can never start again. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Each client's startup attachment supplies this read port. No fallback is
   * installed during loading or teardown. */
  @actionBound setNavigationProvider(provider: NavigationProvider): void {
    if (this.disposed) return
    this.ui.setNavigation(provider)
    if (this.pendingSessionNavigation) this.ui.navigateToSession(this.pendingSessionNavigation)
    if (this.pendingNavigation) this.navigate(this.pendingNavigation)
  }

  /** Open a tab in the workspace a navigation is landing in — `selection` is the
   *  selected issue/worktree AFTER the navigation, which may not be the one on
   *  screen yet. */
  private openWorkspaceTab(
    tabId: string,
    selection?: { selectedIssueId?: IssueId | null; selectedWorktree?: string | null },
    permanent = true,
  ): WorkspacePatch {
    const st = overlayState(this.ui.screen, selection ?? {})
    const key = resolvedWorkspaceKey(st)
    if (key === NAVIGATION_LOADING) return {}
    const next = openTab(workspaceFor(st, key), tabId, { permanent })
    return workspaceWritePatch(st, key, next)
  }

  // ------------------------------------------------------------------- routing

  private committingNavigation = false

  private navigate(intent: NavigationIntent): boolean {
    if (this.disposed) return false
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    // Any navigation supersedes a link still waiting for its session, so a late
    // row never yanks the operator off where they went since (POD-4642).
    this.paneLinks.cancel()
    const plan = planNavigation(this.ui.screen, this.router.current(), intent, {
      visible: this.visibility.isVisible(),
      now: new Date().toISOString(),
    })
    if (plan.pending) {
      this.pendingNavigation = intent
      this.follow.refreshWatch()
      return false
    }
    const patch = plan.patch
    // Compare the navigation fields only. Never enumerate the screen or copy a
    // whole state document to decide whether this one selection changed.
    const changed =
      this.ui.view !== patch.view ||
      this.ui.settingsTab !== patch.settingsTab ||
      this.ui.openIssueId !== patch.openIssueId ||
      (patch.selectedIssueId !== undefined && this.ui.selectedIssueId !== patch.selectedIssueId) ||
      (patch.selectedWorktree !== undefined &&
        this.ui.selectedWorktree !== patch.selectedWorktree) ||
      (patch.workspaces !== undefined && this.ui.workspaces !== patch.workspaces) ||
      (patch.fileTabs !== undefined && this.ui.fileTabList !== patch.fileTabs) ||
      (patch.recentFiles !== undefined && this.ui.recentFiles !== patch.recentFiles) ||
      (patch.focusedPane !== undefined && this.ui.focusedPane !== patch.focusedPane)
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
    this.ui.patch(plan.patch)
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
   * retires it after its grace period (`TabPruningService.pruneWorkspaces`). It is NOT
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
    const st = this.ui.screen
    const patch: Partial<ScreenState> = {
      view: route.view,
      settingsTab: route.settingsTab,
      openIssueId: asIssueIdOrNull(route.issueId),
    }
    if (
      route.worktree &&
      route.worktree !== prev?.worktree &&
      route.worktree !== st.selectedWorktree
    ) {
      let canShow = this.replica.getCursor() === null
      if (!canShow && st.navigation.registeredWorktree && st.navigation.hasWorktreeSession) {
        const known = st.navigation.registeredWorktree(route.worktree)
        const anchored = known === true ? false : st.navigation.hasWorktreeSession(route.worktree)
        canShow =
          known === true ||
          anchored === true ||
          known === NAVIGATION_LOADING ||
          anchored === NAVIGATION_LOADING
      } else if (!canShow) {
        const worktree = route.worktree
        const worktrees = reposToViews(this.repositories()).flatMap((repo) => repo.worktrees)
        const crew = st.navigation.worktreeSessions?.()
        canShow =
          worktrees.some((w) => machinePathsEqual(w.path, worktree)) ||
          crew === NAVIGATION_LOADING ||
          (crew ?? []).some((s) => isMachinePathWithinRoot(worktree, s.cwd))
      }
      if (canShow) patch.selectedWorktree = route.worktree
    }
    // A pane the state is not already showing is a LINK (deep link, back/forward),
    // not this runtime's own mirror write.
    if (route.pane !== prev?.pane) this.paneLinks.cancel()
    const linked = !!route.pane && route.pane !== prev?.pane && route.pane !== st.paneA
    if (!linked && route.pane !== prev?.pane) this.paneLinks.resolve(route.pane)
    this.ui.patch(patch)
    if (linked) this.paneLinks.follow(route)
  }

  // -------------------------------------------------------------- outbox seams

  /** Per-entry outbox outcomes (POD-4554), from the root's outbox service.
   *  See {@link OutboxOutcome}. Bound so it can be passed bare. */
  readonly subscribeOutboxOutcomes = (listener: (outcome: OutboxOutcome) => void): (() => void) =>
    this.services.outbox.subscribeOutcomes(listener)

  // ------------------------------------------------------------------- actions

  /** Preserve the last keystroke and wait only for local queue durability.
   * Delivery and awaiting-truth entries are already durable and resume after reload. */
  readonly prepareReload = async (): Promise<void> => {
    if (this.disposed) throw new Error('The draft owner changed; please retry reloading.')
    await this.markRead.flushReadAcknowledgements()
    this.drafts.persist(true)
    await this.uiPersistence.flush()
    await this.services.outbox.queue.flushLocalWrites?.()
    // Typing can continue while an IndexedDB enqueue commits.
    if (this.disposed) throw new Error('The draft owner changed; please retry reloading.')
    this.drafts.persist(true)
    await this.uiPersistence.flush()
    await this.replica.flush()
    await this.services.outbox.queue.flushLocalWrites?.()
    this.drafts.persist(true)
    await this.uiPersistence.flush()
  }

  private requirePoolWriter(): PoolWriter {
    if (!this.poolWriter || this.disposed) throw new Error('Pool transactions are not attached')
    return this.poolWriter
  }

  /** The registered repositories and their worktrees, from the replica's
   *  `checkout` records (POD-6644). Memoized by the replica's answer. */
  private repositories(): readonly CheckoutRepository[] {
    // Held between checkout changes (dropped by the batch that moves one), so
    // navigation and session switches read no replica list.
    this.heldRepositories ??= repositoriesFromCheckouts(this.replica.rows('checkouts'))
    return this.heldRepositories
  }
  private heldRepositories: readonly CheckoutRepository[] | undefined

  private createCommands(): Commands<TApi> {
    return createCommands({
      autoContinueDialog: this.autoContinueDialog,
      api: this.api,
      outbox: this.services.outbox.queue,
      userId: this.principal.userId,
      router: this.router,
      notices: this.notices,
      ui: this.ui,
      write: <K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]) =>
        this.poolWriter !== null
          ? this.poolWriter.write(kind, input)
          : Promise.reject(new Error('Pool transactions are not attached')),
      spawnDraftAgent: (args: Parameters<Commands<TApi>['sessions']['spawnDraftAgent']>[0]) =>
        this.requirePoolWriter().spawnDraftAgent!(args),
      launchSession: (args: Parameters<Commands<TApi>['sessions']['launch']>[0]) =>
        this.requirePoolWriter().launchSession!(args),
      startIssueSession: (args: Parameters<Commands<TApi>['sessions']['startIssueSession']>[0]) =>
        this.requirePoolWriter().startIssueSession!(args),
      spawnIssueAgent: (args: Parameters<Commands<TApi>['sessions']['spawnIssueAgent']>[0]) =>
        this.requirePoolWriter().spawnIssueAgent!(args),
      // ONE KEYSTROKE. The store write is synchronous and unconditional — it is
      // what the caret is attached to. Everything else about this edit (when it
      // goes out, whether it went out, when it is written to disk) is a
      // consequence, and none of it can hold the typing up.
      setSessionDraft: (sessionId, text) => this.drafts.set(sessionId, text),
      // One row by id; a replica without the by-id read answers "unknown" (1),
      // and the outbox's own queued edits still raise it.
      sessionRevision: (sessionId) => this.replica.row?.('sessions', sessionId)?.revision,
      // My settings as the replica holds them (POD-6673): a record never
      // written resolves to the defaults.
      preferences: () =>
        resolveUserPreferences(
          this.replica.row?.('userPreferences', userPreferencesRowId(this.principal.userId)),
          this.principal.userId,
        ),
      dismissLaunch: (sessionId) => this.poolWriter?.dismissLaunch?.(sessionId) ?? false,
      launchPainted: (sessionId) => this.poolWriter?.launchPainted?.(sessionId) ?? false,
    })
  }
}

/** The principal's read positions, by stream, from the replica's rows. */
function readPositionSnapshotFromRows(
  rows: readonly ReadPositionWire[],
  userId: string,
): ReadPositionSnapshot {
  const out: Record<string, { lastEventId: number; seenAt: string | null }> = {}
  for (const row of rows) {
    if (row.userId === userId)
      out[row.streamId] = { lastEventId: row.lastEventId, seenAt: row.seenAt }
  }
  return out as ReadPositionSnapshot
}

/** The provider constructs one root for each authenticated principal. */
export function createClientRuntime<TApi extends PodiumClientApi = PodiumClientApi>(
  init: ClientRuntimeInit<TApi>,
): ClientRuntime<TApi> {
  let runtime: ClientRuntime<TApi>
  const notices = createNotices(() => runtime.ui, init.notices)
  return runInAction(() => {
    runtime = new ClientRuntime({ ...init, notices })
    return runtime
  })
}
