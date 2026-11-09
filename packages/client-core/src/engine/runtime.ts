import { isMachinePathWithinRoot, machinePathsEqual } from '@podium/model'
import { bindStoreStatsOwner } from '../perf/store-stats'
import { LayoutAccess } from '../ui/layout-access'
import {
  AutoContinueDialogModel,
  PaletteViewModel,
  TranscriptRevealActions,
} from '../ui/view-models'

/**
 * THE CLIENT RUNTIME — the principal-scoped coordinator (POD-404).
 *
 * This file replaces `engine/engine.ts`, the 1,489-line god object the 6.1 split
 * (POD-328) exists to delete. What is left here is coordination and nothing
 * else: construct the collaborators, run one lifecycle over them, and own the
 * single state choke point they all write through.
 *
 *   ROOT             runtime-root/      (POD-6681) — replica, LiveStore, the
 *                                        connection and outbox services
 *   TRANSPORT        socket-transport/  (POD-400) — socket, planes, PTY epoch/seq
 *   COMMANDS         commands/          (POD-6682) — area modules over the write path
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
import type { IssueId, ReadPositionSnapshot, ReadPositionWire, SessionId } from '@podium/model'
import {
  type CheckoutRepository,
  readPositionRowId,
  repositoriesFromCheckouts,
  resolveUserPreferences,
  userPreferencesRowId,
} from '@podium/model'
import { isShortSessionIdentifier, type SessionIdentifierResolution } from '@podium/protocol'
import { action, actionBound, reaction, runInAction } from 'mobx'
import type { PodiumClientApi } from '../api'
import { type Commands, createCommands } from '../commands'
import type { ConversationCache, ConversationCacheOptions } from '../conversation/cache'
import { DraftStore } from '../conversation/draft-store'
import { createChatSends } from '../conversation/sends'
import { createNotices } from '../notices'
import { bindSwitchTraceUi } from '../perf/switch-trace'
import type { ClientPrincipal } from '../principal'
import { createReadPositionClient, type ReadPositionPort } from '../read-position'
import { createRecordsApi } from '../records'
import type { VisibilitySource } from '../runtime-root/connection/visibility'
import type { OutboxOutcome } from '../runtime-root/outbox/outbox-service'
import type { OutboxKinds } from '../runtime-root/outbox/wiring'
import { createRuntimeRoot, type RuntimeRoot, type RuntimeRootInit } from '../runtime-root/root'
import { createNotificationSounds, type SessionPhaseChange } from '../sound/notification-sounds'
import { openLegacyDeviceKeys } from '../ui/draft-storage'
import { createUiKeys } from '../ui/keys'
import { type NavigationIntent, planNavigation } from '../ui/navigation'
import { UiPersistence } from '../ui/persistence'
import { sessionLinkProblem, sessionLinkSelection } from '../ui/session-link'
import type { ScreenState } from '../ui/state'
import { UiStore } from '../ui/ui-store'
import { UrlMirror } from '../ui/url-mirror'
import {
  createRouter,
  type RoutedUiState,
  type Router,
  type RouterWindow,
  type RouteState,
} from '../ui-state'
import { allTabIds, closeTab, openTab, reposToViews, type WorkspaceKey } from '../values'
import { Reactions, WORKSPACE_PRUNE_GRACE_MS } from './reactions'
import {
  asIssueIdOrNull,
  type EngineState,
  type EngineStatics,
  focusedPaneSession,
  foregroundIssue,
  initialEngineState,
  NAVIGATION_LOADING,
  type NavigationProvider,
  type NavigationTopologySession,
  navigationSession,
  overlayState,
  resolvedWorkspaceKey,
  type WorkspacePatch,
  workspaceFor,
  workspaceKeyForState,
  workspaceMirrorPatch,
  workspacesPatch,
  workspaceWritePatch,
} from './state'
import { defaultFormatError, NOOP_NOTICES, type Store, type StoreNotices } from './types'

/**
 * The pool's transaction log as the runtime's actions reach it (POD-5432).
 * `write` paints the pool's rows in the caller's tick, then enqueues once into
 * the outbox. Its promise settles when the record is durable and rejects when
 * that commit fails.
 */
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

/**
 * What the old store is built from: the runtime root's init (POD-6681), with
 * the error formatting and notices optional, plus the old store's own seams.
 */
export interface ClientRuntimeInit<TApi extends PodiumClientApi>
  extends Omit<RuntimeRootInit<TApi>, 'formatError' | 'notices'> {
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: StoreNotices
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Test seam: overrides WORKSPACE_PRUNE_GRACE_MS (POD-710). */
  workspacePruneGraceMs?: number
  /** Test seam: overrides DRAFT_SEND_DEBOUNCE_MS (POD-2045). */
  draftSendDebounceMs?: number
  /** Test seam: overrides DRAFT_PERSIST_DEBOUNCE_MS (POD-2045). */
  draftPersistDebounceMs?: number
}

const log = createLogger('client-core:runtime')

export {
  DRAFT_KEEP_LIMIT,
  DRAFT_PERSIST_DEBOUNCE_MS,
  DRAFT_SEND_DEBOUNCE_MS,
  DRAFTS_UI_KEY,
} from '../conversation/draft-store'

export class ClientRuntime<TApi extends PodiumClientApi = PodiumClientApi> {
  /** The one principal this runtime serves. Read-only for its whole lifetime. */
  readonly principal: ClientPrincipal
  /**
   * THE RUNTIME ROOT (POD-6681): this user's replica, LiveStore, conversation
   * cache, connection and outbox. This old store drives its lifecycle and
   * forwards its plumbing members to it until POD-5803 deletes the store.
   */
  readonly root: RuntimeRoot<TApi>
  readonly router: Router
  readonly ui: UiStore
  readonly deviceState: RoutedUiState
  readonly layout: LayoutAccess
  /** This person's event-stream read positions (POD-1380) — its own family
   *  because a cursor merges monotonically, not last-writer-wins. */
  readonly readPosition: ReadPositionPort

  private readonly uiPersistence: UiPersistence
  private readonly urlMirror: UrlMirror
  private readonly reactions: Reactions

  private readonly api: TApi
  get spawnNotices(): StoreNotices {
    return this.notices
  }
  private readonly notices: StoreNotices
  private readonly onFatalError: (message: string) => void
  private readonly formatError: (error: unknown, fallback: string) => string

  /** Where this client learns whether it is on screen: the root's connection service owns it. */
  private get visibility(): VisibilitySource {
    return this.root.services.connection.visibility
  }
  readonly palette = new PaletteViewModel()
  readonly autoContinueDialog = new AutoContinueDialogModel()
  readonly transcriptReveals = new TranscriptRevealActions()

  private readonly state: EngineState & ScreenState
  private stopNavigationWatch: (() => void) | undefined
  private pendingNavigation: NavigationIntent | undefined
  private pendingSessionNavigation: string | undefined
  private navigationWakeQueued = false
  private pendingNavigationTopology = false
  private readonly pendingWorktreeMoves = new Map<string, NavigationTopologySession>()
  private pendingWorktreeFallback = false
  private statsReactionDepth = 0
  readonly services: EngineStatics<TApi>
  readonly access: Store<TApi>
  private stopTopologyWatch: (() => void) | undefined
  private prevRoute: RouteState | undefined = undefined
  /** Which workspace is on screen (POD-710). A change here is a TASK SWITCH, and
   *  the pane mirrors are re-derived from the workspace being switched to. */
  private workspaceKey: WorkspaceKey
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
  private pendingReactions = new Set<keyof (EngineState & ScreenState)>()
  readonly drafts: DraftStore
  private readonly networkEnabled: boolean
  /** One-time boot work, once per runtime, even across a StrictMode
   *  dispose/re-start cycle. */
  private booted = false

  constructor(init: ClientRuntimeInit<TApi>, root: RuntimeRoot<TApi>) {
    this.principal = init.principal
    this.root = root
    this.api = init.api
    this.notices = init.notices ?? NOOP_NOTICES
    this.onFatalError = init.onFatalError
    this.formatError = init.formatError ?? defaultFormatError
    this.networkEnabled = init.networkEnabled ?? true
    bindStoreStatsOwner(this.root.replica, this)
    const device = this.root.replica.deviceStorage()
    const localUi = openLegacyDeviceKeys(device)
    this.state = initialEngineState() as EngineState & ScreenState
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
      hub: this.root.services.connection.hub,
      notices: this.notices,
      keys: this.deviceState,
      router: this.router,
      repositories: () => this.repositories(),
      isVisible: () => this.visibility.isVisible(),
      revealTranscript: (sessionId, itemKey) => this.transcriptReveals.reveal(sessionId, itemKey),
      changed: (changed) => {
        if (this.reactions)
          this.runReactions(changed as ReadonlySet<keyof (EngineState & ScreenState)>)
      },
      watch: (keys, listener) => {
        return reaction(() => [this.ui.selectedIssueId, this.ui.navigation], listener)
      },
      navigate: (intent) => this.navigate(intent),
      waitForSessionNavigation: (identifier) => {
        this.dropPaneLink()
        this.pendingNavigation = undefined
        this.pendingSessionNavigation = identifier
        this.watchNavigation()
      },
    })
    this.uiPersistence = new UiPersistence(this.ui, device, localUi, this.visibility)
    // Only internal policy code uses this read port. Every value is a getter
    // into the MobX home; no device field is retained in EngineState.
    Object.defineProperties(
      this.state,
      Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(this.ui.screen))
          .filter(([key]) => !Object.hasOwn(this.state, key))
          .map(([key, descriptor]) => [key, { ...descriptor, enumerable: false }]),
      ),
    )
    Object.defineProperties(this.state, {
      paletteOpen: { enumerable: false, get: () => this.palette.open },
      autoContinuePromptSessionId: {
        enumerable: false,
        get: () => this.autoContinueDialog.sessionId,
      },
      issueVisitBaseline: {
        enumerable: false,
        get: () => this.reactions?.issueVisitBaseline ?? null,
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
      () => this.paneLink?.sessionId ?? this.pendingPaneLink,
    )
    this.reactions = new Reactions({
      state: () => this.state,
      publish: (patch) => this.apply(patch),
      hub: this.root.services.connection.hub,
      notices: this.notices,
      isVisible: () => this.visibility.isVisible(),
      markSessionRead: (sessionId, readAt) =>
        this.root.commands.sessions.markRead(sessionId, readAt),
      markIssueRead: (issueId, readAt) => this.root.commands.issues.markRead(issueId, readAt),
      ...(init.workspacePruneGraceMs !== undefined
        ? { pruneGraceMs: init.workspacePruneGraceMs }
        : {}),
      linkedWorktree: () => this.paneLink?.worktree ?? null,
      repositories: () => this.repositories(),
      // The checkouts are known once the replica holds a feed position (a saved
      // copy or a first bootstrap) or holds checkout records at all.
      checkoutsKnown: () =>
        this.root.replica.getCursor() !== null ||
        (this.root.replica.rowCount?.('checkouts') ?? 0) > 0,
    })
    this.paneLinkGraceMs = init.workspacePruneGraceMs ?? WORKSPACE_PRUNE_GRACE_MS
    this.workspaceKey = workspaceKeyForState(this.state)
    // Drafts are hydrate-first for the same reason the entity slices are, and
    // with more at stake: this is the person's own unsent writing, and a first
    // paint without it is an empty composer where a half-written message was.
    // It happens HERE rather than in start() because start() is a passive
    // effect — a frame late is a frame of blank box, and on a cold boot with no
    // server there is nothing else that would ever fill it in.
    this.drafts = new DraftStore({
      storage: this.deviceState,
      hub: this.root.services.connection.hub,
      onStorageError: (err) => log.warn('could not cache this device drafts', { err }),
      sendDebounceMs: init.draftSendDebounceMs,
      persistDebounceMs: init.draftPersistDebounceMs,
    })
    this.root.installCommands(
      this.createCommands(),
      createChatSends({
        outbox: this.root.services.outbox.queue,
        outboxSettlements: this.root.services.outbox.settlements,
        waitForSpawnConfirmed: (id) => this.requirePoolWriter().waitForSpawnConfirmed!(id),
      }),
    )
    this.services = this.buildStatics()
    this.access = Object.defineProperties(
      { ...this.services },
      {
        ...Object.getOwnPropertyDescriptors(this.ui.screen),
        paletteOpen: { enumerable: true, get: () => this.palette.open },
        autoContinuePromptSessionId: {
          enumerable: true,
          get: () => this.autoContinueDialog.sessionId,
        },
        issueVisitBaseline: { enumerable: true, get: () => this.reactions.issueVisitBaseline },
      },
    ) as Store<TApi>
    this.urlMirror.adoptCurrent()
  }

  /** The provider supplies addressed pool ports once, for this principal. */
  readonly ownConversations = (options: ConversationCacheOptions): ConversationCache => {
    if (this.destroyed) throw new Error('The conversation owner has changed')
    return this.root.ownConversations(options)
  }

  // ------------------------------------------------------------------ read seam

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
  @actionBound start(): void {
    if (this.started || this.destroyed) return
    this.started = true
    this.drafts.start()
    const offs = this.offs

    // Restartable cleanup drops a pending full-id link's grace timer. Re-arm
    // it before selection can mirror out, including StrictMode's second mount.
    if (!this.paneLink && !this.pendingPaneLink) this.followPaneLink(this.router.current())
    this.uiPersistence.start()
    this.urlMirror.start()
    // THE ROOT (POD-6681): the outbox service attaches the queue and publishes
    // its counts (PoolTransactions owns paint), the topics follow the server,
    // and the connection service arms its listeners and dials on the next
    // macrotask.
    this.root.start()
    void this.root.replica.hydrate().catch((error) => {
      if (!this.destroyed) this.onFatalError(this.formatError(error, 'Could not load local data'))
    })
    // My read positions are synced records the replica keeps (POD-6673): a
    // position moved on my other device arrives here, and a reload paints the
    // stored one before the network answers. No request reads them.
    const installReadPositions = (): void =>
      this.readPosition.replace(
        readPositionSnapshotFromRows(
          this.root.replica.rows('userReadPositions'),
          this.principal.userId,
        ),
      )
    installReadPositions()
    offs.push(this.root.replica.subscribeRows('userReadPositions', installReadPositions))

    // Machines, their access and their checkouts are replica records
    // (POD-6644): a moved checkout re-checks the selected worktree.
    const offCheckouts = this.root.replica.subscribeAddressedBatch?.((batch) => {
      if (batch.type === 'replace' || batch.rows.some((row) => row.kind === 'checkouts')) {
        this.heldRepositories = repositoriesFromCheckouts(this.root.replica.rows('checkouts'))
        if (!this.pendingNavigationTopology) this.worktreeFallback()
      }
    })
    // Held repositories are valid only while this subscription follows them:
    // derived here once, and again by each batch that moves a checkout.
    this.heldRepositories = repositoriesFromCheckouts(this.root.replica.rows('checkouts'))
    offs.push(() => {
      offCheckouts?.()
      this.heldRepositories = undefined
    })
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    offs.push(
      this.root.services.connection.hub.on('attention', (e) => {
        if (this.visibility.isVisible()) return
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        try {
          new Notification(e.title, { body: e.body, tag: e.sessionId })
        } catch {
          // some webviews throw on construction — never break the app over a toast
        }
      }),
    )

    this.sounds ??= createNotificationSounds({
      ui: this.deviceState,
      phases: () => this.sessionPhases?.() ?? [],
      visibleSessionIds: () => this.ui.getUserFocus().visibleSessionIds ?? [],
    })
    // The provider starts the runtime before attaching the pool. Wait for its
    // observable source; attachSessionPhases starts sounds when it arrives.
    if (this.sessionPhases) this.sounds.start()
    offs.push(() => this.sounds?.stop())

    // Presence feeds the server's smart router (skip mobile push while visible).
    // Re-report view-state too so hiding the tab clears it (and showing re-asserts).
    // The connection service owns the source and runs this before it
    // reconnects on the same change; it also reconnects when the network returns.
    offs.push(
      this.root.services.connection.onVisibilityChange(() => this.reactions.onVisibilityChange()),
    )
    this.reactions.onVisibilityChange()
    // A ghost tab restored from persistence needs no delta to be a ghost, so the
    // prune pass has to be armed at boot as well as reacted to — otherwise an
    // offline reload keeps showing (and re-persisting) a tab for a session that
    // is long gone. Idempotent: it re-arms its own timer.
    this.reactions.pruneWorkspaces()
    offs.push(
      reaction(
        () => [this.ui.workspaces, this.ui.fileTabList],
        () => this.reactions.pruneWorkspaces(),
      ),
    )

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
   *  — see {@link destroy}. */
  @actionBound dispose(): void {
    this.started = false
    bindSwitchTraceUi(null)
    this.reactions.dispose()
    this.dropPaneLink()
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
    this.root.stop()
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
  @actionBound destroy(options: { eraseUi?: boolean } = {}): void {
    if (this.destroyed) {
      this.dispose()
      return
    }
    this.root.releaseConversations()
    this.drafts.dispose()
    this.dispose()
    this.stopNavigationWatch?.()
    this.stopNavigationWatch = undefined
    this.stopTopologyWatch?.()
    this.stopTopologyWatch = undefined
    this.pendingNavigation = undefined
    this.pendingSessionNavigation = undefined
    this.pendingNavigationTopology = false
    this.pendingWorktreeMoves.clear()
    this.pendingWorktreeFallback = false
    if (options.eraseUi) this.uiPersistence.erase()
    this.destroyed = true
    this.poolWriter?.dispose?.()
    this.poolWriter = null
    // The root's sign-out: services, the frame queue and every reading.
    this.root.disposeNow()
    this.ui.dispose()
    this.transcriptReveals.dispose()
  }

  /** True once {@link destroy} has run. The provider asserts on this so a
   *  teardown that silently did not happen cannot pass as one that did. */
  get isDestroyed(): boolean {
    return this.destroyed
  }

  /** Each client's startup attachment supplies this read port. No fallback is
   * installed during loading or teardown. */
  @actionBound setNavigationProvider(provider: NavigationProvider): void {
    if (this.destroyed) return
    // Release observations against their owning pool before replacing it.
    if (provider !== this.state.navigation) this.reactions.leaveReadVisits()
    this.stopTopologyWatch?.()
    this.pendingWorktreeMoves.clear()
    this.stopTopologyWatch = provider.onTopology?.((delta) => {
      if (this.destroyed) return
      if (delta?.reset && provider.topologySession)
        for (const [id, previous] of this.pendingWorktreeMoves)
          this.pendingWorktreeMoves.set(id, { ...previous, after: provider.topologySession(id) })
      for (const change of delta?.sessions ?? []) {
        const previous = this.pendingWorktreeMoves.get(change.id)
        this.pendingWorktreeMoves.set(
          change.id,
          previous ? { id: change.id, before: previous.before, after: change.after } : change,
        )
      }
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
      !this.paneLink &&
      !this.pendingNavigation &&
      this.pendingWorktreeMoves.size === 0 &&
      !this.pendingWorktreeFallback &&
      !this.pendingNavigationTopology
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
          this.pendingNavigationTopology
            ? [...this.pendingWorktreeMoves.values()]
                .filter(
                  (change) =>
                    change.before && change.after && change.before.cwd !== change.after.cwd,
                )
                .map((change) => provider.worktreeSession?.(change.id))
            : undefined,
          (this.pendingNavigationTopology || this.pendingWorktreeFallback) &&
          provider.registeredWorktree
            ? st.selectedWorktree
              ? [
                  provider.registeredWorktree(st.selectedWorktree),
                  provider.hasWorktreeSession?.(st.selectedWorktree),
                ]
              : provider.firstWorktree?.()
            : undefined,
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
          this.paneLink ? provider.session(this.paneLink.sessionId) : undefined,
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
          if (this.pendingNavigationTopology) {
            const followed = this.reactions.worktreeFollow([...this.pendingWorktreeMoves.values()])
            if (followed) this.pendingWorktreeMoves.clear()
            if (
              followed &&
              this.reactions.worktreeFallback() &&
              this.reactions.sessionIssueFollow()
            ) {
              this.pendingNavigationTopology = false
              this.pendingWorktreeFallback = false
              this.reactions.pruneWorkspaces()
            }
          }
          if (
            !this.pendingNavigationTopology &&
            this.pendingWorktreeFallback &&
            this.reactions.worktreeFallback()
          )
            this.pendingWorktreeFallback = false
          if (
            this.paneLink &&
            !this.openLinkedSession(this.paneLink.sessionId, this.paneLink.worktree)
          )
            this.apply(this.openWorkspaceTab(this.paneLink.sessionId))
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
  /** Transfer the selection once; every legacy state read and write then
   * delegates to the always-on worklist. Detach takes it back when that view
   * disappears, before another principal or pool can attach. */
  private apply(patch: Partial<EngineState & ScreenState>): void {
    if (this.destroyed) return
    this.batch(() => {
      if (patch.paletteOpen !== undefined) this.palette.setOpen(patch.paletteOpen)
      if (patch.autoContinuePromptSessionId !== undefined) {
        if (patch.autoContinuePromptSessionId)
          this.autoContinueDialog.open(patch.autoContinuePromptSessionId)
        else this.autoContinueDialog.close()
      }
      if (patch.issueVisitBaseline !== undefined)
        this.reactions.setIssueVisitBaseline(patch.issueVisitBaseline)
      const screenPatch = Object.fromEntries(
        Object.entries(patch).filter(([key]) => Object.hasOwn(this.ui.screen, key)),
      )
      if (Object.keys(screenPatch).length) this.ui.patch(screenPatch)
      const changed = new Set<keyof (EngineState & ScreenState)>()
      for (const k of Object.keys(patch) as Array<keyof (EngineState & ScreenState)>) {
        if (
          Object.hasOwn(this.ui.screen, k) ||
          k === 'paletteOpen' ||
          k === 'autoContinuePromptSessionId' ||
          k === 'issueVisitBaseline'
        )
          continue
        const next = patch[k]
        if (!Object.is(this.state[k], next)) {
          ;(this.state as unknown as Record<string, unknown>)[k as string] = next
          changed.add(k)
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

  private runReactions(changed: ReadonlySet<keyof (EngineState & ScreenState)>): void {
    this.statsReactionDepth++
    try {
      this.react(changed)
    } finally {
      this.statsReactionDepth--
    }
  }

  /** Explicit batches defer reactions until all writes land, then publish the
   * changed local keys once. Finally restores the boundary if a reaction throws. */
  @action batch(fn: () => void): void {
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
      }
    }
  }

  /** Effect → reaction table (#262): each old provider useEffect either lives
   *  here keyed by the slices it depended on, or in start() (mount-once). */
  private react(changed: ReadonlySet<keyof (EngineState & ScreenState)>): void {
    const any = (...keys: Array<keyof (EngineState & ScreenState)>): boolean =>
      keys.some((k) => changed.has(k))

    // Worktree fallback selection.
    if (any('selectedWorktree') && !this.pendingNavigationTopology) this.worktreeFallback()
    // TASK SWITCH → restore that workspace's panes (POD-710). The layouts are
    // the truth; the pane scalars follow whichever workspace is now on screen.
    // Pool navigation invalidates the mission root when issue topology moves.
    if (any('selectedIssueId', 'selectedWorktree', 'navigation')) this.syncWorkspaceSelection()
    // A tab whose session or file is GONE (POD-710). Nothing else can remove it
    // — it renders nothing, so there is no ✕ to click — and it is persisted, so
    // it comes back on every reload until this drops it.
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
    if (any('view', 'paneA', 'paneB', 'split', 'focusedPane', 'workspaces', 'navigation'))
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
      ([key, value]) => !Object.is(this.state[key as keyof (EngineState & ScreenState)], value),
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
    const patch: Partial<EngineState & ScreenState> = {
      view: route.view,
      settingsTab: route.settingsTab,
      openIssueId: asIssueIdOrNull(route.issueId),
    }
    if (
      route.worktree &&
      route.worktree !== prev?.worktree &&
      route.worktree !== st.selectedWorktree
    ) {
      let canShow = this.root.replica.getCursor() === null
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
    if (route.pane !== prev?.pane) this.dropPaneLink()
    const linked = !!route.pane && route.pane !== prev?.pane && route.pane !== st.paneA
    if (!linked && route.pane !== prev?.pane) this.resolvePaneLink(route.pane)
    this.apply(patch)
    if (linked) this.followPaneLink(route)
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
    this.watchNavigation()
  }

  /** Open a linked session this replica holds; false when it holds none. */
  private openLinkedSession(sessionId: string, worktree: string | null): boolean {
    const meta = navigationSession(this.state, sessionId)
    if (!meta) return false
    this.dropPaneLink()
    const selection = sessionLinkSelection(this.state, this.repositories(), meta, worktree)
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

  /** Per-entry outbox outcomes (POD-4554), from the root's outbox service.
   *  See {@link OutboxOutcome}. Bound so it can be passed bare. */
  readonly subscribeOutboxOutcomes = (listener: (outcome: OutboxOutcome) => void): (() => void) =>
    this.root.services.outbox.subscribeOutcomes(listener)

  // ------------------------------------------------------------------- actions

  /** Preserve the last keystroke and wait only for local queue durability.
   * Delivery and awaiting-truth entries are already durable and resume after reload. */
  readonly prepareReload = async (): Promise<void> => {
    if (this.destroyed) throw new Error('The draft owner changed; please retry reloading.')
    await this.reactions.flushReadAcknowledgements()
    this.drafts.persist(true)
    await this.uiPersistence.flush()
    await this.root.services.outbox.queue.flushLocalWrites?.()
    // Typing can continue while an IndexedDB enqueue commits.
    if (this.destroyed) throw new Error('The draft owner changed; please retry reloading.')
    this.drafts.persist(true)
    await this.uiPersistence.flush()
    await this.root.replica.flush()
    await this.root.services.outbox.queue.flushLocalWrites?.()
    this.drafts.persist(true)
    await this.uiPersistence.flush()
  }

  private requirePoolWriter(): PoolWriter {
    if (!this.poolWriter || this.destroyed) throw new Error('Pool transactions are not attached')
    return this.poolWriter
  }

  /** The registered repositories and their worktrees, from the replica's
   *  `checkout` records (POD-6644). Memoized by the replica's answer. */
  private repositories(): readonly CheckoutRepository[] {
    // Held between checkout changes (dropped by the batch that moves one), so
    // navigation and session switches read no replica list.
    this.heldRepositories ??= repositoriesFromCheckouts(this.root.replica.rows('checkouts'))
    return this.heldRepositories
  }
  private heldRepositories: readonly CheckoutRepository[] | undefined

  /** Keep the selected worktree valid against the registered worktrees. */
  private worktreeFallback(): void {
    if (!this.reactions.worktreeFallback() && this.state.navigation) {
      this.pendingWorktreeFallback = true
      this.queueNavigationWake(this.state.navigation)
    }
  }

  private createCommands(): Commands<TApi> {
    return createCommands({
      autoContinueDialog: this.autoContinueDialog,
      api: this.api,
      outbox: this.root.services.outbox.queue,
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
      sessionRevision: (sessionId) => this.root.replica.row?.('sessions', sessionId)?.revision,
      // My settings as the replica holds them (POD-6673): a record never
      // written resolves to the defaults.
      preferences: () =>
        resolveUserPreferences(
          this.root.replica.row?.('userPreferences', userPreferencesRowId(this.principal.userId)),
          this.principal.userId,
        ),
      dismissLaunch: (sessionId) => this.poolWriter?.dismissLaunch?.(sessionId) ?? false,
      launchPainted: (sessionId) => this.poolWriter?.launchPainted?.(sessionId) ?? false,
    })
  }

  private buildStatics(): EngineStatics<TApi> {
    return {
      // Remaining UI and discovery seams, until the façade retires (POD-5803).
      uiState: this.deviceState,
      readPosition: this.readPosition,
      batchGesture: (fn: () => void) => this.batch(fn),
      setPaletteOpen: this.palette.setOpen,
      closeAutoContinuePrompt: this.autoContinueDialog.close,
      navigateWorkspace: this.ui.navigateWorkspace,
      setView: this.ui.setView,
      setSettingsTab: this.ui.setSettingsTab,
      setOpenIssueId: this.ui.setOpenIssueId,
      setSuperThreadId: this.ui.setSuperThreadId,
      setSuperOpen: this.ui.setSuperOpen,
      setDockTab: this.ui.setDockTab,
      clearAttachedSession: this.ui.clearAttachedSession,
      setSelectedWorktree: this.ui.setSelectedWorktree,
      setSelectedIssueId: this.ui.setSelectedIssueId,
      setPane: this.ui.setPane,
      openSessionTab: this.ui.openSessionTab,
      openSessionAtTranscript: this.ui.openSessionAtTranscript,
      openTabInWorkspace: this.ui.openTabInWorkspace,
      promoteWorkspaceTab: this.ui.promoteWorkspaceTab,
      activateWorkspaceTab: this.ui.activateWorkspaceTab,
      closeWorkspaceTab: this.ui.closeWorkspaceTab,
      moveWorkspaceTab: this.ui.moveWorkspaceTab,
      splitWorkspacePane: this.ui.splitWorkspacePane,
      closeWorkspacePane: this.ui.closeWorkspacePane,
      focusWorkspacePane: this.ui.focusWorkspacePane,
      resizeWorkspaceSplit: this.ui.resizeWorkspaceSplit,
      setFocusedPane: this.ui.setFocusedPane,
      focusIssueSession: this.ui.focusIssueSession,
      setPanelMode: this.ui.setPanelMode,
      preferPanelMode: this.ui.preferPanelMode,
      setDockVisibleSession: this.ui.setDockVisibleSession,
      setDockShell: this.ui.setDockShell,
      toggleSplit: this.ui.toggleSplit,
      openFile: this.ui.openFile,
      openFileInWorktree: this.ui.openFileInWorktree,
      openArtifact: this.ui.openArtifact,
      closeFileTab: this.ui.closeFileTab,
      navigateToSession: this.ui.navigateToSession,
      getUserFocus: this.ui.getUserFocus,
      workspaceKey: this.ui.workspaceKey,
    } as EngineStatics<TApi>
  }
}

/** Persisted layout ROWS → the controller's snapshot shape. The rows are already
 *  this principal's (the replica is principal-scoped and the feed is per-user),
 *  so the key/value pair is all the controller needs back. */
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
  // The runtime root first (POD-6681): the replica, the LiveStore, the socket
  // and the queue, in that order, exactly as this store used to build them.
  // Both in the one action the store was always built in.
  let runtime: ClientRuntime<TApi>
  const notices = createNotices(() => runtime.ui, init.notices)
  return runInAction(() => {
    const root = createRuntimeRoot<TApi>({
      ...init,
      formatError: init.formatError ?? defaultFormatError,
      notices: { error: (m) => notices.error(m), info: (m, d) => notices.info(m, d) },
    })
    runtime = new ClientRuntime({ ...init, notices }, root)
    return runtime
  })
}
