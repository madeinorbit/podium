/**
 * The Podium client engine (#262 [spec:SP-3fe2]): the non-React core that used
 * to live inside react/provider.tsx as ~20 useEffects and a per-render value
 * object. It owns:
 *
 *  - SocketHub lifecycle + subscription wiring (via the P5a `on()` seam),
 *  - replica hydration + hydrate-first paint (seedMetadata),
 *  - the outbox (durable offline writes) + drain-on-reconnect — whose pending
 *    entries double as THE optimistic overlay (#263, see overlay.ts: replica =
 *    server truth only, snapshots fold rows + pending mutations' patches),
 *  - the router, as the SINGLE URL writer (see mirrorUrl),
 *  - view-state reporting + the worktree-follow policy,
 *  - every imperative store action (the old trpc.* closures, verbatim).
 *
 * Lifecycle is explicit: `start()` arms subscriptions/listeners and kicks the
 * boot fetches; `dispose()` tears everything down; both are idempotent and a
 * disposed engine can be re-started (React StrictMode's dev double-mount).
 * The read seam is `subscribe(listener)` / `getSnapshot()` — designed for
 * useSyncExternalStore but with zero React dependency. Snapshot identity is
 * stable until a slice actually changes (publish shallow-compares).
 */

import type {
  AgentKind,
  ConversationSummaryWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HostMetricsWire,
  IssueWire,
  MachineWire,
  SessionMeta,
  WorkState,
} from '@podium/protocol'
import { type Sidebar as SidebarSettings, shouldPromptAutoContinue } from '@podium/runtime'
import type { SocketHub } from '@podium/terminal-client'
import type { PodiumClientApi } from '../api'
import type { Outbox, OutboxEntry } from '../outbox'
import { createReplica, type Replica, type UiState } from '../replica/replica'
import {
  createRouter,
  type MainView,
  type Router,
  type RouterWindow,
  type RouteState,
  routeDefaults,
} from '../router'
import { createDraftAgent, type SpawnTarget } from '../spawn-agent'
import { createSubscriptionStore, type SubscriptionStore } from '../store'
import {
  type DockTab,
  dedupeSessionsByResume,
  EMPTY_PINS,
  type FileScope,
  type FileTab,
  optimisticDraftIssue,
  optimisticStartingSession,
  type PinKind,
  type PinState,
  planWorktreeMoves,
  readStoredDockTab,
  reposToViews,
  tabIdFor,
} from '../viewmodels'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  insertOverlay,
  type OverlayEntity,
  overlayForOutboxEntry,
  type PendingOverlay,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'
import {
  DOCK_TAB_KEY,
  ISSUE_SEL_KEY,
  PANE_A_KEY,
  PANE_B_KEY,
  PANEL_MODE_KEY,
  readStoredPanelModes,
  readStoredView,
  SPLIT_KEY,
  SUPER_OPEN_KEY,
  VIEW_KEY,
  WT_KEY,
} from './persistence'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type Store,
  type StoreNotices,
  type StoreServerConfig,
  type UserFocus,
} from './types'
import { type CreateHub, createEngineHub, createEngineOutbox, type OutboxKinds } from './wiring'

/** Default trailing debounce (ms) before a viewed session is marked read. Long
 *  enough that a streaming session settles first (so we mark read once, not on
 *  every frame), short enough that a glance clears the nag promptly. */
export const MARK_READ_ON_VIEW_MS = 1200

/** How long a FAILED spawn create waits for the session broadcast before it is
 *  treated as definitive (#263 review finding 4): the create can reach the
 *  server and mint the row while the HTTP response is lost — rolling back /
 *  toasting on such a rejection cries wolf over a session that exists. */
export const SPAWN_CONFIRM_GRACE_MS = 2000

const tabIsVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

export interface EngineInit<TApi extends PodiumClientApi> {
  config: StoreServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: StoreNotices
  /** Replica factory — mobile injects the AsyncStorage-backed one. Called once. */
  createReplicaFn?: () => Replica
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Test seam: replaces SocketHub construction (engine unit tests inject a fake). */
  createHub?: CreateHub
  /** Test seam: overrides SPAWN_CONFIRM_GRACE_MS (#263 review finding 4). */
  spawnConfirmGraceMs?: number
}

/** The engine's mutable data slices — exactly the non-function fields of Store
 *  that change over time (constants like hub/trpc/replica live outside it). */
interface EngineState {
  repos: GitRepositoryWire[]
  reposLoading: boolean
  reposLoaded: boolean
  repoDiagnostics: GitDiscoveryDiagnosticWire[]
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  pendingSpawnIds: ReadonlySet<string>
  hostMetrics: HostMetricsWire[]
  machines: MachineWire[]
  pins: PinState
  tabOrders: Record<string, string[]>
  view: MainView
  settingsTab: string | null
  searchOpen: boolean
  openIssueId: string | null
  superThreadId: string
  superOpen: boolean
  dockTab: DockTab
  superRefreshKey: number
  paletteOpen: boolean
  selectedWorktree: string | null
  selectedIssueId: string | null
  paneA: string | null
  paneB: string | null
  split: boolean
  focusedPane: 'A' | 'B'
  panelMode: Record<string, 'chat' | 'native'>
  autoContinuePromptSessionId: string | null
  drafts: Record<string, string>
  sidebarSettings: SidebarSettings
  fileTabs: FileTab[]
  outboxSize: number
}

export class Engine<TApi extends PodiumClientApi = PodiumClientApi> {
  readonly replica: Replica
  readonly hub: SocketHub
  readonly outbox: Outbox<OutboxKinds>
  readonly router: Router
  readonly ui: UiState

  private readonly api: TApi
  private readonly notices: StoreNotices
  private readonly onFatalError: (message: string) => void
  private readonly formatError: (error: unknown, fallback: string) => string
  private readonly httpOrigin: string

  private readonly state: EngineState
  private readonly subStore: SubscriptionStore<Store<TApi>>
  /** The action methods + constant handles, spread into every snapshot so their
   *  identities never change for the engine's lifetime. */
  private readonly statics: Omit<Store<TApi>, keyof EngineState>

  // ---- internal (non-snapshot) state ----
  private baseSessions: SessionMeta[] = []
  private baseIssues: IssueWire[] = []
  /** ONE optimistic mechanism (#263, overlay.ts): the QUEUED overlays are the
   *  outbox itself (derived per recompute — no second copy of that state);
   *  these two hold the rest of the lifecycle. `spawnOverlays` are the #119
   *  placeholder inserts (transport = direct tRPC, bookkeeping = unified);
   *  `awaitingTruth` are resolved patches whose covering server truth hasn't
   *  landed in the replica yet (retirement rule (a)). */
  private spawnOverlays: PendingOverlay[] = []
  private awaitingTruth: AwaitingTruth[] = []
  /** TTL sweep for the awaiting-truth stage (#263 review finding 3): prunes run
   *  on recomputes, which only fire on replica/outbox changes — a row that
   *  never changes again would otherwise keep a stuck entry painted forever. */
  private awaitingSweepTimer: ReturnType<typeof setTimeout> | null = null
  private readonly spawnConfirmGraceMs: number
  /** Effective rendered mode per session (what AgentPanel actually shows),
   *  reported up the viewState channel. Not in the snapshot — only the setter
   *  is public — and not persisted (re-reported on mount from live state). */
  private panelRenderModes: Record<string, 'chat' | 'native'> = {}
  private prevRoute: RouteState
  private prevCwds: Record<string, string> = {}
  private markReadKey: string | null = null
  private markReadTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private offs: Array<() => void> = []
  private started = false
  /** One-time boot fetches (repos/pins/tab-orders/settings) — once per engine,
   *  even across a StrictMode dispose/re-start cycle (matches the old provider's
   *  `started` ref). */
  private booted = false

  constructor(init: EngineInit<TApi>) {
    this.api = init.api
    this.notices = init.notices ?? NOOP_NOTICES
    this.onFatalError = init.onFatalError
    this.formatError = init.formatError ?? defaultFormatError
    this.httpOrigin = init.config.httpOrigin
    this.spawnConfirmGraceMs = init.spawnConfirmGraceMs ?? SPAWN_CONFIRM_GRACE_MS
    // Persistent local replica (docs/spec/thin-client-replica.md). Constructed
    // synchronously so its persisted cursor can seed the hub's first
    // changesSince; entity hydration happens async in start().
    this.replica = init.createReplicaFn ? init.createReplicaFn() : createReplica()
    this.ui = this.replica.uiState()
    this.hub = createEngineHub({
      wsClientUrl: init.config.wsClientUrl,
      api: this.api,
      replica: this.replica,
      onFatalError: (m) => this.onFatalError(m),
      createHub: init.createHub,
    })
    this.outbox = createEngineOutbox({
      api: this.api,
      replica: this.replica,
      notices: { error: (m) => this.notices.error(m), info: (m, d) => this.notices.info(m, d) },
      // Overlay lifecycle (#263): drain success hands the entry's overlay to
      // the awaiting-truth stage; a poison drop repaints without it.
      onApplied: (entry) => this.onMutationApplied(entry),
      onDropped: (entry) => this.onMutationDropped(entry),
    })
    // Restore the DURABLE awaiting-truth stage (#263 review finding 1): a
    // reload inside the resolution→covering-truth window must keep painting
    // resolved overlays — the retirement check against hydrated replica rows
    // (retireCovered, on the first recompute) drops the ones whose truth
    // already landed. Unprojectable leftovers have nothing to await: retire.
    const restoredAwaiting: AwaitingTruth[] = []
    for (const e of this.outbox.awaiting()) {
      const overlay = overlayForOutboxEntry(e)
      if (overlay?.op === 'patch') {
        restoredAwaiting.push({
          overlay,
          baseline: e.baseline,
          resolvedAt: e.resolvedAt ?? Date.now(),
        })
      } else {
        this.outbox.retireAwaiting(e.mutationId)
      }
    }
    this.awaitingTruth = restoredAwaiting
    // URL router (issue #15 Phase 4): the main surface is the URL. A plain '/'
    // start restores the persisted view; unknown URLs fall back to home.
    this.router = createRouter({ fallbackView: readStoredView(this.ui), win: init.routerWindow })
    const route = this.router.current()
    this.prevRoute = route
    // Hydrate-first FIRST snapshot (#262 review): the replica's collections
    // load synchronous storage at construction, so seed the entity slices from
    // them BEFORE any subscriber reads — the old useReplicaRows path exposed
    // persisted rows at the very first render, and an empty initial snapshot
    // regressed that into "not found" flashes until start() (a passive effect)
    // ran. start() stays network/subscription arming only. (The async
    // `hydrate()` in start() still covers storages that load asynchronously.)
    const seedSessions = this.replica.rows('sessions')
    this.baseSessions =
      seedSessions.length === 0 ? seedSessions : dedupeSessionsByResume(seedSessions)
    this.baseIssues = this.replica.rows('issues')
    // Baseline for the worktree-follow diff: the seeded rows are "first sight",
    // not moves (matches the old effect's first observed sessions snapshot).
    this.prevCwds = Object.fromEntries(this.baseSessions.map((s) => [s.sessionId, s.cwd]))
    // Fold queued outbox entries over the seed (#263): after an offline reload
    // the durable queue still paints its optimism in the VERY FIRST snapshot
    // (the old direct-replica patching survived reloads the same way).
    const seededSessionFold = foldOverlays(
      this.baseSessions,
      this.overlaysFor('sessions'),
      (s) => s.sessionId,
    )
    const seededIssueFold = foldOverlays(this.baseIssues, this.overlaysFor('issues'), (i) => i.id)
    this.state = {
      repos: [],
      reposLoading: false,
      reposLoaded: false,
      repoDiagnostics: [],
      sessions: seededSessionFold.rows,
      issues: seededIssueFold.rows,
      conversations: this.replica.rows('conversations'),
      pendingSpawnIds: EMPTY_ID_SET,
      hostMetrics: [],
      machines: [],
      pins: EMPTY_PINS,
      tabOrders: {},
      view: route.view,
      settingsTab: route.settingsTab,
      searchOpen: route.searchOpen,
      openIssueId: route.issueId,
      superThreadId: 'global',
      superOpen: this.ui.get(SUPER_OPEN_KEY) === '1',
      dockTab: readStoredDockTab(this.ui.get(DOCK_TAB_KEY)),
      superRefreshKey: 0,
      paletteOpen: false,
      // Workspace pane state: a deep-linked ?wt= wins over the persisted selection.
      selectedWorktree: route.worktree ?? this.ui.get(WT_KEY),
      selectedIssueId: this.ui.get(ISSUE_SEL_KEY),
      paneA: route.pane ?? this.ui.get(PANE_A_KEY),
      paneB: this.ui.get(PANE_B_KEY),
      split: this.ui.get(SPLIT_KEY) === '1',
      // Which pane has input focus. Not persisted — it resets to A on reload,
      // which is the right default (A is always the shown pane when split is off).
      focusedPane: 'A',
      panelMode: readStoredPanelModes(this.ui),
      autoContinuePromptSessionId: null,
      drafts: {},
      sidebarSettings: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
      fileTabs: [],
      outboxSize: 0,
    }
    this.statics = this.buildStatics()
    this.subStore = createSubscriptionStore<Store<TApi>>(this.buildSnapshot())
  }

  // ------------------------------------------------------------------ read seam

  /** useSyncExternalStore-shaped subscription. Bound so it can be passed bare. */
  readonly subscribe = (listener: () => void): (() => void) => this.subStore.subscribe(listener)
  readonly getSnapshot = (): Store<TApi> => this.subStore.getSnapshot()

  // ------------------------------------------------------------------ lifecycle

  /** Arm all subscriptions/listeners, hydrate, connect, and (once per engine)
   *  run the boot fetches. Idempotent while started; re-arms after dispose(). */
  start(): void {
    if (this.started) return
    this.started = true
    const offs = this.offs

    // Router: route changes (navigation actions, back/forward) fan in through
    // this ONE subscription; the URL is only ever WRITTEN by engine methods
    // (navigation actions + mirrorUrl) — see the invariant on mirrorUrl().
    offs.push(this.router.subscribe((r) => this.onRouteChanged(r)))
    this.router.attach()
    // A route may have changed between dispose() and a re-start (StrictMode).
    const cur = this.router.current()
    if (cur !== this.prevRoute) this.onRouteChanged(cur)

    // Outbox → snapshot; attach re-arms drain triggers after a dispose. Queue
    // membership IS overlay membership (#263), so any enqueue/drop repaints
    // the entity lists too (a no-op publish when nothing visible changed).
    offs.push(
      this.outbox.subscribe((size) => {
        this.apply({ outboxSize: size })
        this.recomputeSessions()
        this.recomputeIssues()
      }),
    )
    this.outbox.attach()
    this.apply({ outboxSize: this.outbox.size() })
    // Restored awaiting-truth entries (see constructor) need the TTL backstop
    // armed even if no replica change ever recomputes them.
    this.armAwaitingSweep()

    // Entity state, single-sourced: the hub writes ONLY into the replica
    // (onMetadataApplied) and the engine re-reads rows on collection changes.
    // In private browsing the same collections run in memory, so there is no
    // parallel entity path.
    offs.push(this.replica.subscribeRows('sessions', () => this.refreshSessionRows()))
    offs.push(this.replica.subscribeRows('issues', () => this.refreshIssueRows()))
    offs.push(this.replica.subscribeRows('conversations', () => this.refreshConversationRows()))
    this.refreshAllRows()

    // Hub events, via the P5a `on()` subscription seam. Only ephemeral state
    // (host metrics, machines, drafts) mirrors hub events into the snapshot.
    offs.push(this.hub.on('hostMetrics', (m) => this.apply({ hostMetrics: m })))
    // Repos are only scannable through a connected daemon, so a machine coming
    // online (e.g. the split daemon reconnecting after a restart) can make
    // previously-empty repos available. Refetch when the online count climbs, so
    // the workspace isn't stuck on the "add a repo" empty state until a reload.
    let onlineMachines = 0
    offs.push(
      this.hub.on('machines', (m) => {
        this.apply({ machines: m })
        const online = m.reduce((n, x) => n + (x.online ? 1 : 0), 0)
        if (online > onlineMachines) void this.refreshRepos()
        onlineMachines = online
      }),
    )
    offs.push(
      this.hub.on('sessionDraft', (sessionId, text) => this.adoptSessionDraft(sessionId, text)),
    )
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

    // Presence feeds the server's smart router (skip mobile push while visible).
    // Re-report view-state too so hiding the tab clears it (and showing re-asserts).
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
      offs.push(() => document.removeEventListener('visibilitychange', this.onVisibilityChange))
    }
    this.onVisibilityChange()

    // Hydrate-first paint (docs/spec/thin-client-replica.md §2.2): seed the hub's
    // entity lists from the persisted replica so last-known data shows before
    // (or without) the network answering. The hydrate microtask resolves before
    // the deferred connect below, and `seedMetadata` refuses to clobber server
    // truth if a heal somehow lands first. `hydrate` never throws (a poisoned
    // replica clears itself and cold-starts).
    void this.replica.hydrate().then((snap) => {
      if (snap.sessions.length + snap.issues.length + snap.conversations.length > 0) {
        this.hub.seedMetadata(snap)
      }
      // Re-read rows after preload — belt-and-braces for a collection whose
      // load didn't emit change events.
      this.refreshAllRows()
    })
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      try {
        this.hub.connect()
      } catch (e) {
        this.onFatalError(this.formatError(e, 'WebSocket connection failed'))
      }
    }, 0)

    if (!this.booted) {
      this.booted = true
      // Sidebar prefs load out of band so boot fans out only repos + pins + tab
      // orders (never gated on settings or a conversation scan).
      void this.api.settings.get
        .query()
        .then((s) => this.apply({ sidebarSettings: s.sidebar }))
        .catch(() => {})
      void Promise.all([this.refreshRepos(), this.refreshPins(), this.refreshTabOrders()]).catch(
        (e) => {
          this.onFatalError(this.formatError(e, 'Could not load Podium data'))
        },
      )
    }

    // Initial persist + URL normalization (the old per-field effects and the
    // state→URL mirror each ran once on mount).
    this.persistAll()
    this.mirrorUrl()
  }

  /** Tear down everything start() armed. Idempotent; the engine can re-start. */
  dispose(): void {
    this.started = false
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.markReadTimer !== null) {
      clearTimeout(this.markReadTimer)
      this.markReadTimer = null
    }
    if (this.awaitingSweepTimer !== null) {
      clearTimeout(this.awaitingSweepTimer)
      this.awaitingSweepTimer = null
    }
    this.markReadKey = null
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

  // ------------------------------------------------------------ state pipeline

  /** THE state choke point: shallow-merge `patch` (Object.is per key), publish a
   *  fresh snapshot when anything changed, then run the reactions that used to
   *  be per-field useEffects. Reactions may nest apply() — each nested call
   *  publishes + reacts for its own change set, and every reaction converges
   *  (guards compare against current state, so a re-run is a no-op). */
  private apply(patch: Partial<EngineState>): void {
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
    // Persist the "where am I" state for next load (old lines 1179-1186).
    if (changed.has('view')) this.ui.set(VIEW_KEY, this.state.view)
    if (changed.has('selectedWorktree')) this.ui.set(WT_KEY, this.state.selectedWorktree)
    if (changed.has('selectedIssueId')) this.ui.set(ISSUE_SEL_KEY, this.state.selectedIssueId)
    if (changed.has('paneA')) this.ui.set(PANE_A_KEY, this.state.paneA)
    if (changed.has('paneB')) this.ui.set(PANE_B_KEY, this.state.paneB)
    if (changed.has('split')) this.ui.set(SPLIT_KEY, this.state.split ? '1' : '0')
    if (changed.has('superOpen')) this.ui.set(SUPER_OPEN_KEY, this.state.superOpen ? '1' : '0')
    if (changed.has('panelMode')) this.ui.set(PANEL_MODE_KEY, JSON.stringify(this.state.panelMode))
    if (changed.has('dockTab')) this.ui.set(DOCK_TAB_KEY, this.state.dockTab)
    // Session-follows-view policy (old lines 1113-1136): diffs consecutive
    // session snapshots, so it reacts to sessions only.
    if (changed.has('sessions')) this.reactWorktreeFollow()
    // Worktree fallback selection (old lines 1083-1105).
    if (any('sessions', 'repos', 'reposLoaded', 'selectedWorktree')) this.reactWorktreeFallback()
    // State→URL mirror — the single URL writer (old lines 1172-1176).
    if (any('selectedWorktree', 'paneA')) this.mirrorUrl()
    // View-state report to the server (old lines 1038-1060).
    if (any('paneA', 'paneB', 'split', 'focusedPane')) this.reportViewState()
    // Mark-the-viewed-session-read debounce (old useMarkReadOnView call).
    if (any('sessions', 'paneA', 'paneB', 'split', 'focusedPane')) this.updateMarkReadTimer()
  }

  private buildSnapshot(): Store<TApi> {
    return { ...this.state, ...this.statics }
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
   */
  private onRouteChanged(route: RouteState): void {
    const prev = this.prevRoute
    this.prevRoute = route
    const st = this.state
    const patch: Partial<EngineState> = {
      view: route.view,
      settingsTab: route.settingsTab,
      searchOpen: route.searchOpen,
      openIssueId: route.issueId,
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
      patch.paneA = route.pane
    }
    this.apply(patch)
    this.mirrorUrl()
  }

  /**
   * INVARIANT (#262, replaces the provider's React-#185 hazard): the engine's
   * router is the ONLY writer of the URL. Every surface navigates through
   * engine actions (setView / setOpenIssueId / setSettingsTab / setSearchOpen)
   * or this mirror; nothing else touches history. The old unbounded update
   * loop ("Podium crashed") needed two independent effect writers re-triggering
   * each other across React commits — with one imperative writer the cycle
   * route→adopt→mirror terminates: the second pass compares equal (URL and
   * state agree) and writes nothing.
   */
  private mirrorUrl(): void {
    const route = this.router.current()
    if (route.view !== 'workspace') return
    const { selectedWorktree, paneA } = this.state
    if (route.worktree === selectedWorktree && route.pane === paneA) return
    this.router.replace({ ...route, worktree: selectedWorktree, pane: paneA })
  }

  // ----------------------------------------------------------------- reactions

  /** When a session the user is LOOKING AT (in a visible pane) moves out of the
   *  selected worktree, switch the whole view to where it went — otherwise it
   *  silently disappears from the tab strip mid-conversation. A background
   *  session's move never yanks the view; it gets a toast so the user knows
   *  where it now lives in the sidebar. */
  private reactWorktreeFollow(): void {
    const st = this.state
    const prevCwds = this.prevCwds
    this.prevCwds = Object.fromEntries(st.sessions.map((s) => [s.sessionId, s.cwd]))
    const plan = planWorktreeMoves({
      prevCwds,
      sessions: st.sessions,
      worktreePaths: reposToViews(st.repos).flatMap((r) => r.worktrees.map((w) => w.path)),
      selectedWorktree: st.selectedWorktree,
      visiblePanes: tabIsVisible()
        ? [st.paneA, st.split ? st.paneB : null].filter((x) => x != null)
        : [],
    })
    if (plan.follow) this.apply({ selectedWorktree: plan.follow })
    for (const move of plan.moved) {
      const s = st.sessions.find((x) => x.sessionId === move.sessionId)
      const dest = move.to ?? s?.cwd
      this.notices.info(
        `${s?.name || s?.title || 'A session'} moved to ${dest?.split('/').pop() ?? '?'}`,
        dest,
      )
    }
  }

  /** Keep the selected worktree valid: wait for the first repo load (otherwise a
   *  persisted selection would be wiped against a still-empty repo list), keep
   *  an explicit selection alive when it's a registered worktree OR a session
   *  actually runs there (containment, not equality — a session stamped with a
   *  subdirectory still anchors the selection), else fall back to the first
   *  known worktree. */
  private reactWorktreeFallback(): void {
    const st = this.state
    if (!st.reposLoaded) return
    const worktrees = reposToViews(st.repos).flatMap((repo) => repo.worktrees)
    if (!st.selectedWorktree) {
      this.apply({ selectedWorktree: worktrees[0]?.path ?? null })
      return
    }
    const known = worktrees.some((w) => w.path === st.selectedWorktree)
    const hasSession = st.sessions.some(
      (s) => s.cwd === st.selectedWorktree || s.cwd.startsWith(`${st.selectedWorktree}/`),
    )
    if (known || hasSession) return
    this.apply({ selectedWorktree: worktrees[0]?.path ?? null })
  }

  /** Report which sessions this client renders (`visible`) and which one has
   *  input focus (`focused`) so the server can prioritize PTY relay for them.
   *  While the tab is hidden we report nothing — a backgrounded client isn't
   *  watching anything. `focusedPane` clamps to A when split is off. */
  private reportViewState(): void {
    const st = this.state
    const tabVisible = tabIsVisible()
    const effectivePane: 'A' | 'B' = st.split ? st.focusedPane : 'A'
    const visible = tabVisible
      ? [st.paneA, st.split ? st.paneB : null].filter((x): x is string => x != null)
      : []
    const focused = tabVisible ? (effectivePane === 'A' ? st.paneA : st.paneB) : null
    // Rendered mode (native/chat) for each visible session — default 'native'
    // until its AgentPanel reports its effective mode.
    const modes: Record<string, 'native' | 'chat'> = {}
    for (const sid of visible) modes[sid] = this.panelRenderModes[sid] ?? 'native'
    this.hub.setViewState(visible, focused, modes)
  }

  private readonly onVisibilityChange = (): void => {
    this.hub.setVisible(tabIsVisible())
    this.reportViewState()
  }

  /** Mark the session the operator is LOOKING AT read on view (#138): a trailing
   *  debounce keyed on the focused session's id + activity, so a streaming
   *  session settles first. `unread` + visibility are re-checked at fire time so
   *  a mid-flight manual mark-unread is respected. (The old useMarkReadOnView
   *  hook, as an engine reaction.) */
  private updateMarkReadTimer(): void {
    const st = this.state
    const focusedId = st.split ? (st.focusedPane === 'A' ? st.paneA : st.paneB) : st.paneA
    const session = focusedId ? st.sessions.find((s) => s.sessionId === focusedId) : undefined
    const key = session ? `${session.sessionId}\n${session.lastActiveAt}` : null
    if (key === this.markReadKey) return
    this.markReadKey = key
    if (this.markReadTimer !== null) {
      clearTimeout(this.markReadTimer)
      this.markReadTimer = null
    }
    if (!session) return
    const sessionId = session.sessionId
    this.markReadTimer = setTimeout(() => {
      this.markReadTimer = null
      const cur = this.state
      const curFocused = cur.split ? (cur.focusedPane === 'A' ? cur.paneA : cur.paneB) : cur.paneA
      const s = cur.sessions.find((x) => x.sessionId === sessionId)
      if (curFocused === sessionId && s?.unread === true && tabIsVisible()) {
        void this.statics.markSessionRead(sessionId)
      }
    }, MARK_READ_ON_VIEW_MS)
  }

  // ----------------------------------------------------------- replica ↔ state

  private refreshAllRows(): void {
    this.refreshSessionRows()
    this.refreshIssueRows()
    this.refreshConversationRows()
  }

  private refreshSessionRows(): void {
    const rows = this.replica.rows('sessions')
    // Collapse duplicate rows for the same underlying conversation (e.g. a
    // Codex thread surfaced twice on resume).
    this.baseSessions = rows.length === 0 ? rows : dedupeSessionsByResume(rows)
    this.recomputeSessions()
  }

  private refreshIssueRows(): void {
    this.baseIssues = this.replica.rows('issues')
    this.recomputeIssues()
  }

  private refreshConversationRows(): void {
    this.apply({ conversations: this.replica.rows('conversations') })
  }

  /** The pending overlays for one entity, in application order: resolved
   *  patches awaiting truth first (they were sent earliest), then the queued
   *  outbox entries FIFO — so two pending mutations on the same row compose in
   *  queue order — plus the #119 spawn placeholder inserts (order-independent:
   *  folding applies inserts before any patch). Derived fresh each recompute:
   *  the outbox itself is the queued-overlay state, never a second copy. */
  private overlaysFor(entity: OverlayEntity): PendingOverlay[] {
    const out: PendingOverlay[] = []
    for (const o of this.spawnOverlays) if (o.entity === entity) out.push(o)
    for (const a of this.awaitingTruth) if (a.overlay.entity === entity) out.push(a.overlay)
    for (const e of this.outbox.pending()) {
      const o = overlayForOutboxEntry(e)
      if (o && o.entity === entity) out.push(o)
    }
    return out
  }

  /** Retirement rule (a) (#263, overlay.ts): spawn inserts retire when server
   *  truth (same id) landed in the replica; resolved patches retire when the
   *  row covers the mutation, moved past the enqueue baseline (oldest per row),
   *  or outlived the TTL. Retiring an awaiting patch also deletes its durable
   *  storage entry (finding 1: deletion happens at retirement, not resolution). */
  private retireCovered<T extends object>(
    entity: OverlayEntity,
    base: T[],
    keyOf: (row: T) => string,
  ): void {
    if (this.spawnOverlays.some((o) => o.entity === entity)) {
      const known = new Set(base.map(keyOf))
      const keep = this.spawnOverlays.filter((o) => o.entity !== entity || !known.has(o.id))
      if (keep.length !== this.spawnOverlays.length) this.spawnOverlays = keep
    }
    const pruned = pruneAwaiting(this.awaitingTruth, entity, base, keyOf)
    if (pruned !== this.awaitingTruth) {
      const dropped = this.awaitingTruth.filter((a) => !pruned.includes(a))
      // Assign BEFORE the durable retire, so any re-entrant recompute already
      // sees the pruned stage.
      this.awaitingTruth = pruned
      for (const a of dropped) this.outbox.retireAwaiting(a.overlay.key)
    }
  }

  /** Fold `replica rows + pending mutations' overlays` into the snapshot's
   *  session list, and derive pendingSpawnIds — the ids AgentPanel must not
   *  attach to yet (#119). */
  private recomputeSessions(): void {
    const base = this.baseSessions
    const keyOf = (s: SessionMeta): string => s.sessionId
    this.retireCovered('sessions', base, keyOf)
    const { rows, pendingInsertIds } = foldOverlays(base, this.overlaysFor('sessions'), keyOf)
    this.apply({ sessions: rows, pendingSpawnIds: pendingInsertIds })
  }

  private recomputeIssues(): void {
    const base = this.baseIssues
    const keyOf = (i: IssueWire): string => i.id
    this.retireCovered('issues', base, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issues'), keyOf)
    this.apply({ issues: rows })
  }

  private recomputeFor(entity: OverlayEntity | undefined): void {
    if (entity === 'sessions') this.recomputeSessions()
    else if (entity === 'issues') this.recomputeIssues()
  }

  /** Drain success (#263): hand the entry's overlay to the awaiting-truth
   *  stage. Called by the outbox BEFORE it notifies subscribers of the
   *  shrunken queue, so no intermediate snapshot ever lacks the overlay.
   *  Returns true to keep the entry DURABLY in storage (finding 1) until
   *  covering truth retires it. */
  private onMutationApplied(entry: OutboxEntry): boolean {
    const overlay = overlayForOutboxEntry(entry)
    if (overlay?.op !== 'patch') return false
    const row =
      overlay.entity === 'sessions'
        ? this.baseSessions.find((s) => s.sessionId === overlay.id)
        : this.baseIssues.find((i) => i.id === overlay.id)
    // Hold the overlay until covering truth lands. Nothing to hold when the
    // row is gone, already reflects the mutation (the broadcast echo raced
    // ahead of the response), or moved past the ENQUEUE-time baseline without
    // covering it (finding 2: covering-or-competing truth already landed — a
    // resolution-time fingerprint of that final row would never "move" again
    // and the overlay would mask server truth forever).
    let hold = false
    if (row !== undefined && !overlay.coveredBy(row)) {
      if (entry.baseline !== undefined && rowFingerprint(row) !== entry.baseline) {
        // Competing truth won while the mutation was in flight — server wins.
      } else {
        hold = true
        this.awaitingTruth = [
          ...this.awaitingTruth,
          { overlay, baseline: entry.baseline, resolvedAt: Date.now() },
        ]
        this.armAwaitingSweep()
      }
    }
    this.recomputeFor(overlay.entity)
    return hold
  }

  /** Arm (once) a timer that forces a recompute shortly after the earliest
   *  awaiting entry's TTL expires, so pruneAwaiting's backstop actually fires
   *  even when the replica goes quiet. Re-arms itself while entries remain. */
  private armAwaitingSweep(): void {
    if (this.awaitingSweepTimer !== null || this.awaitingTruth.length === 0) return
    const earliest = Math.min(...this.awaitingTruth.map((a) => a.resolvedAt))
    const delay = Math.max(0, earliest + AWAITING_TRUTH_TTL_MS - Date.now()) + 25
    this.awaitingSweepTimer = setTimeout(() => {
      this.awaitingSweepTimer = null
      this.recomputeSessions()
      this.recomputeIssues()
      this.armAwaitingSweep()
    }, delay)
  }

  /** Definitive failure — retirement rule (b): the wiring already surfaced the
   *  poison toast; repaint without the dropped entry's overlay. */
  private onMutationDropped(entry: OutboxEntry): void {
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  /** Enqueue + repaint: the queued entry IS the optimistic apply (#263). The
   *  outbox subscription (armed in start()) already repaints on any queue
   *  change; recomputing here as well keeps actions optimistic before start()
   *  and after dispose() (the duplicate recompute is a no-op publish). */
  private enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
  ): void {
    // Enqueue-time baseline (#263 review finding 2): fingerprint the target
    // row's REPLICA truth (unpainted — the replica is server truth only) so
    // resolution can tell whether truth already moved while in flight.
    const probe = overlayForOutboxEntry({ mutationId: '', kind, input, queuedAt: 0 })
    let baseline: string | undefined
    if (probe?.op === 'patch') {
      const row =
        probe.entity === 'sessions'
          ? this.baseSessions.find((s) => s.sessionId === probe.id)
          : this.baseIssues.find((i) => i.id === probe.id)
      if (row !== undefined) baseline = rowFingerprint(row)
    }
    const entry = this.outbox.enqueue(
      kind,
      input,
      baseline === undefined ? undefined : { baseline },
    )
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  private adoptSessionDraft(sessionId: string, text: string): void {
    const d = this.state.drafts
    if (d[sessionId] === text) return
    this.apply({ drafts: { ...d, [sessionId]: text } })
  }

  private persistAll(): void {
    const st = this.state
    this.ui.set(VIEW_KEY, st.view)
    this.ui.set(WT_KEY, st.selectedWorktree)
    this.ui.set(ISSUE_SEL_KEY, st.selectedIssueId)
    this.ui.set(PANE_A_KEY, st.paneA)
    this.ui.set(PANE_B_KEY, st.paneB)
    this.ui.set(SPLIT_KEY, st.split ? '1' : '0')
    this.ui.set(SUPER_OPEN_KEY, st.superOpen ? '1' : '0')
    this.ui.set(PANEL_MODE_KEY, JSON.stringify(st.panelMode))
  }

  /** Enrich the registered repos with branch/worktree metadata (fast — no
   *  filesystem walk). Discovery scanning happens explicitly via the scan flow. */
  private async refreshRepos(): Promise<void> {
    this.apply({ reposLoading: true })
    try {
      const r = await this.api.discovery.refreshRepos.mutate()
      this.apply({ repos: r.repositories, repoDiagnostics: r.diagnostics })
    } finally {
      this.apply({ reposLoading: false, reposLoaded: true })
    }
  }

  private async refreshPins(): Promise<void> {
    this.apply({ pins: await this.api.pins.list.query() })
  }

  private async refreshTabOrders(): Promise<void> {
    this.apply({ tabOrders: await this.api.tabs.listOrders.query() })
  }

  private getUserFocus(): UserFocus {
    const st = this.state
    const paneIds = [st.paneA, st.split ? st.paneB : null].filter((x): x is string => x != null)
    const focusedId = st.split ? (st.focusedPane === 'A' ? st.paneA : st.paneB) : st.paneA
    const isSession = (id: string): boolean => st.sessions.some((s) => s.sessionId === id)
    const focusedFile = focusedId ? st.fileTabs.find((f) => f.id === focusedId) : undefined
    return {
      view: st.view,
      ...(st.selectedWorktree ? { worktreePath: st.selectedWorktree } : {}),
      ...(st.selectedIssueId ? { issueId: st.selectedIssueId } : {}),
      ...(focusedId && isSession(focusedId) ? { focusedSessionId: focusedId } : {}),
      visibleSessionIds: paneIds.filter(isSession),
      ...(focusedFile ? { filePath: focusedFile.path } : {}),
    }
  }

  // ------------------------------------------------------------------- actions

  /** The imperative store actions — the old provider's trpc.* closures, moved
   *  here mostly verbatim. Built once so every snapshot carries the same
   *  function identities. */
  private buildStatics(): Omit<Store<TApi>, keyof EngineState> {
    const api = this.api
    return {
      hub: this.hub,
      trpc: api,
      replica: this.replica,
      uiState: this.ui,
      httpOrigin: this.httpOrigin,
      getUserFocus: () => this.getUserFocus(),
      refreshRepos: () => this.refreshRepos(),
      setPinned: async (kind: PinKind, id: string, pinned: boolean) => {
        this.apply({ pins: await api.pins.set.mutate({ kind, id, pinned }) })
      },
      // Optimistic: dnd-kit hands back the new order on drop, and waiting on the
      // round-trip would make the tab snap back for a frame. Server result reconciles.
      setTabOrder: async (worktree: string, sessionIds: string[]) => {
        this.apply({ tabOrders: { ...this.state.tabOrders, [worktree]: sessionIds } })
        this.apply({ tabOrders: await api.tabs.setOrder.mutate({ worktree, sessionIds }) })
      },
      setView: (v: MainView) => {
        const cur = this.router.current()
        if (cur.view === v) return
        // Switching surface closes per-surface overlays (issue page, settings
        // deep-link, search) but keeps the workspace pane context.
        this.router.navigate({ ...routeDefaults(v), worktree: cur.worktree, pane: cur.pane })
      },
      // Tab changes are real history entries (/settings/:tab): back/forward moves
      // between the tabs you visited, and a deep link lands directly on its tab.
      setSettingsTab: (tab: string | null) => {
        const cur = this.router.current()
        if (cur.view === 'settings') {
          if (cur.settingsTab !== tab) this.router.navigate({ ...cur, settingsTab: tab })
        } else if (tab !== null) {
          this.router.navigate({
            ...cur,
            view: 'settings',
            settingsTab: tab,
            issueId: null,
            searchOpen: false,
          })
        }
      },
      setSearchOpen: (open: boolean) => {
        const cur = this.router.current()
        if (cur.searchOpen === open) return
        this.router.navigate({ ...cur, searchOpen: open })
      },
      setOpenIssueId: (id: string | null) => {
        const cur = this.router.current()
        if (cur.view === 'issues' && cur.issueId === id) return
        this.router.navigate({ ...cur, view: 'issues', issueId: id, searchOpen: false })
      },
      setSuperThreadId: (id: string) => this.apply({ superThreadId: id }),
      setSuperOpen: (open: boolean) => this.apply({ superOpen: open }),
      setDockTab: (tab: DockTab) => this.apply({ dockTab: tab }),
      startBtw: async (sessionId: string) => {
        // Open the superagent dock on the session's btw thread immediately; the
        // server seeds it (and runs the orientation turn) in the background.
        this.apply({ superThreadId: `btw_${sessionId}`, superOpen: true })
        await api.superagent.startBtw.mutate({ sessionId }).catch(() => {})
        // Seeding + the orientation turn are done now — nudge the view to refetch.
        this.apply({ superRefreshKey: this.state.superRefreshKey + 1 })
      },
      tldrSession: async (sessionId: string, answerText: string) => {
        const threadId = `btw_${sessionId}`
        this.apply({ superThreadId: threadId, superOpen: true })
        // Ensure the thread is seeded with this session's context before we ask.
        await api.superagent.startBtw.mutate({ sessionId }).catch(() => {})
        const prompt = answerText.trim()
          ? `Give me a concise tl;dr (2–4 bullet points) of the agent's last answer below.\n\n---\n${answerText.trim().slice(0, 4000)}`
          : "Give me a concise tl;dr (2–4 bullet points) of the agent's last answer."
        await api.superagent.sendTurn.mutate({ threadId, text: prompt }).catch(() => {})
        this.apply({ superRefreshKey: this.state.superRefreshKey + 1 })
      },
      setPaletteOpen: (open: boolean) => this.apply({ paletteOpen: open }),
      setSelectedWorktree: (path: string | null) => this.apply({ selectedWorktree: path }),
      setSelectedIssueId: (id: string | null) => this.apply({ selectedIssueId: id }),
      // Selecting a pane also focuses it — clicking/opening a pane is a reasonable
      // proxy for input focus, and the terminal components don't expose a focus seam.
      setPane: (pane: 'A' | 'B', id: string | null) =>
        this.apply(
          pane === 'A' ? { paneA: id, focusedPane: pane } : { paneB: id, focusedPane: pane },
        ),
      setFocusedPane: (pane: 'A' | 'B') => this.apply({ focusedPane: pane }),
      setPanelMode: (sessionId: string, mode: 'chat' | 'native') => {
        const m = this.state.panelMode
        if (m[sessionId] === mode) return
        this.apply({ panelMode: { ...m, [sessionId]: mode } })
      },
      setPanelRenderMode: (sessionId: string, mode: 'chat' | 'native') => {
        if (this.panelRenderModes[sessionId] === mode) return
        this.panelRenderModes = { ...this.panelRenderModes, [sessionId]: mode }
        this.reportViewState()
      },
      toggleSplit: () => this.apply({ split: !this.state.split }),
      openFile: (sessionId: string, path: string) => {
        const scope: FileScope = { kind: 'session', sessionId }
        const id = tabIdFor(scope, path)
        const st = this.state
        const worktreePath = st.sessions.find((s) => s.sessionId === sessionId)?.cwd ?? ''
        const fileTabs = st.fileTabs.some((t) => t.id === id)
          ? st.fileTabs
          : [...st.fileTabs, { id, scope, path, worktreePath }]
        this.apply({ fileTabs, paneA: id })
      },
      openFileInWorktree: (args: { machineId?: string; root: string; path: string }) => {
        const scope: FileScope = { kind: 'worktree', machineId: args.machineId, root: args.root }
        const id = tabIdFor(scope, args.path)
        const st = this.state
        const fileTabs = st.fileTabs.some((t) => t.id === id)
          ? st.fileTabs
          : [...st.fileTabs, { id, scope, path: args.path, worktreePath: args.root }]
        this.apply({ fileTabs, paneA: id })
      },
      closeFileTab: (id: string) => {
        const st = this.state
        this.apply({
          fileTabs: st.fileTabs.filter((t) => t.id !== id),
          paneA: st.paneA === id ? null : st.paneA,
          paneB: st.paneB === id ? null : st.paneB,
        })
      },
      readFileScoped: ((scope: FileScope, path: string) =>
        scope.kind === 'session'
          ? api.files.read.query({ sessionId: scope.sessionId, path })
          : api.files.read.query({
              machineId: scope.machineId,
              root: scope.root,
              path,
            })) as Store<TApi>['readFileScoped'],
      writeFileScoped: ((args: {
        scope: FileScope
        path: string
        content: string
        baseHash?: string
      }) =>
        args.scope.kind === 'session'
          ? api.files.write.mutate({
              sessionId: args.scope.sessionId,
              path: args.path,
              content: args.content,
              baseHash: args.baseHash,
            })
          : api.files.write.mutate({
              machineId: args.scope.machineId,
              root: args.scope.root,
              path: args.path,
              content: args.content,
              baseHash: args.baseHash,
            })) as Store<TApi>['writeFileScoped'],
      listDir: ((args: { machineId?: string; root: string; path?: string }) =>
        api.files.list.query(args)) as Store<TApi>['listDir'],
      spawnDraftAgent: (args: {
        target: SpawnTarget
        agentKind: AgentKind
        firstPrompt?: string
      }): { sessionId: string; issueId: string } => {
        // Client-minted ids (server reuses them verbatim) so the optimistic rows
        // reconcile by id when the broadcast lands — no temp-id swap, no flicker.
        const sessionId = crypto.randomUUID()
        const issueId = `iss_${crypto.randomUUID()}`
        const nowIso = new Date().toISOString()
        // Unified overlay bookkeeping (#263): the placeholders are pending
        // insert overlays — same fold, same retirement (server truth with the
        // same ids lands → retire). Only the TRANSPORT differs from outboxed
        // mutations: a spawn rides direct tRPC (it must fail fast and loudly,
        // not silently queue offline), so failure rolls the overlays back here
        // rather than through the outbox's poison path.
        this.spawnOverlays = [
          ...this.spawnOverlays,
          insertOverlay(
            'sessions',
            sessionId,
            optimisticStartingSession({
              sessionId,
              issueId,
              agentKind: args.agentKind,
              cwd: args.target.path,
              nowIso,
            }),
          ),
          insertOverlay(
            'issues',
            issueId,
            optimisticDraftIssue({
              issueId,
              repoPath: args.target.repoPath,
              agentKind: args.agentKind,
              nowIso,
            }),
          ),
        ]
        this.recomputeSessions()
        this.recomputeIssues()
        // Fire the create in the background; roll the overlays back if it never
        // reaches the server (the real broadcast otherwise supersedes them).
        void createDraftAgent({
          trpc: api,
          sessionId,
          issueId,
          target: args.target,
          agentKind: args.agentKind,
          firstPrompt: args.firstPrompt,
        }).catch((err) => {
          // A rejection is NOT definitive once the create may have reached the
          // server (#263 review finding 4): the broadcast can mint the real
          // row while the HTTP response is lost. If the session row (client-
          // minted id) is already in the replica — or arrives within a short
          // grace — the spawn SUCCEEDED: no toast, no rollback (the insert
          // overlay already retired against the real row).
          const arrived = (): boolean => this.baseSessions.some((s) => s.sessionId === sessionId)
          const settleFailure = (): void => {
            if (arrived()) {
              console.debug(
                '[podium] spawn transport failed after the session was created — treating as success',
                sessionId,
                err,
              )
              return
            }
            this.spawnOverlays = this.spawnOverlays.filter(
              (o) => o.id !== sessionId && o.id !== issueId,
            )
            this.recomputeSessions()
            this.recomputeIssues()
            this.notices.error(
              `Couldn't start the agent — ${err instanceof Error ? err.message : 'unknown error'}`,
            )
          }
          if (arrived()) settleFailure()
          else setTimeout(settleFailure, this.spawnConfirmGraceMs)
        })
        return { sessionId, issueId }
      },
      killSession: async (sessionId: string) => {
        await api.sessions.kill.mutate({ sessionId }).catch(() => {})
        const st = this.state
        this.apply({
          fileTabs: st.fileTabs.filter(
            (t) => !(t.scope.kind === 'session' && t.scope.sessionId === sessionId),
          ),
          paneA: st.paneA === sessionId ? null : st.paneA,
          paneB: st.paneB === sessionId ? null : st.paneB,
          pins: { ...st.pins, panels: st.pins.panels.filter((id) => id !== sessionId) },
          tabOrders: Object.fromEntries(
            Object.entries(st.tabOrders).map(([wt, ids]) => [
              wt,
              ids.filter((id) => id !== sessionId),
            ]),
          ),
        })
      },
      continueSession: async (sessionId: string) => {
        await api.sessions.continue.mutate({ sessionId }).catch(() => {})
        // After the manual nudge, offer to make it automatic — once, and only when
        // it isn't already on / hasn't already been answered.
        try {
          const settings = await api.settings.get.query()
          if (shouldPromptAutoContinue(settings)) {
            this.apply({ autoContinuePromptSessionId: sessionId })
          }
        } catch {
          // Non-fatal: the nudge already happened; just skip the offer.
        }
      },
      closeAutoContinuePrompt: () => this.apply({ autoContinuePromptSessionId: null }),
      hibernateSession: async (sessionId: string) => {
        await api.sessions.hibernate.mutate({ sessionId }).catch(() => {})
      },
      resurrectSession: async (sessionId: string) => {
        await api.sessions.resurrect.mutate({ sessionId }).catch(() => {})
      },
      resumeAndSend: async (sessionId: string, text: string) => {
        // Outboxed: the wake+deliver is durably queued server-side once it lands,
        // and the outbox carries it there across offline gaps/reloads.
        this.outbox.enqueue('resumeAndSend', { sessionId, text })
      },
      // Curation mutations are optimistic via ONE mechanism (#263): enqueueing
      // IS the optimistic apply — the pending entry's patch paints over server
      // truth on the very next snapshot (the outbox notifies synchronously),
      // survives being authored offline (durable queue), and retires per the
      // rule in overlay.ts. The replica itself stays server truth only.
      renameSession: async (sessionId: string, name: string) => {
        this.enqueueOverlayed('rename', { sessionId, name })
      },
      archiveSession: async (sessionId: string, archived: boolean) => {
        // Archiving "files the work away": it also lands the session in the board's
        // Done lane. Unarchiving only restores it — it doesn't reopen the work state.
        this.enqueueOverlayed('setArchived', { sessionId, archived })
        if (archived) this.enqueueOverlayed('setWorkState', { sessionId, workState: 'done' })
        // Filing the work away also drops it from pinned panels — a pinned tab for an
        // archived session is dead weight, exactly as closing/killing it removes the
        // pin (mirrors killSession's local pin filter). Unlike kill, archiving doesn't
        // delete the row server-side, so the panel pin would otherwise survive in the
        // DB and resurrect on reload — clear it on the server too to make it stick.
        if (archived) {
          const pins = this.state.pins
          this.apply({ pins: { ...pins, panels: pins.panels.filter((id) => id !== sessionId) } })
          // Pins stay direct (not outboxed) — low offline value, follow-on phase.
          await api.pins.set.mutate({ kind: 'panel', id: sessionId, pinned: false }).catch(() => {})
        }
      },
      setWorkState: async (sessionId: string, workState: WorkState | null) => {
        this.enqueueOverlayed('setWorkState', { sessionId, workState })
      },
      setSnooze: async (sessionId: string, until: string | null) => {
        this.enqueueOverlayed('snoozeSet', { sessionId, until })
      },
      clearSnooze: async (sessionId: string) => {
        this.enqueueOverlayed('snoozeClear', { sessionId })
      },
      // Mark a session / issue read (issue #124): the pending entry stamps
      // readAt (from its queuedAt) + clears unread until server truth covers
      // it. markSessionUnread (#138) is the email-style inverse.
      markSessionRead: async (sessionId: string) => {
        this.enqueueOverlayed('sessionMarkRead', { sessionId })
      },
      markSessionUnread: async (sessionId: string) => {
        this.enqueueOverlayed('sessionMarkUnread', { sessionId })
      },
      markIssueRead: async (id: string) => {
        this.enqueueOverlayed('issueMarkRead', { id })
      },
      markIssueUnread: async (id: string) => {
        this.enqueueOverlayed('issueMarkUnread', { id })
      },
      setSessionDraft: (sessionId: string, text: string) => {
        this.adoptSessionDraft(sessionId, text)
        this.hub.sendSessionDraft(sessionId, text)
      },
      setSidebarSettings: async (next: Partial<SidebarSettings>) => {
        // Optimistic update so the UI reorders instantly.
        this.apply({ sidebarSettings: { ...this.state.sidebarSettings, ...next } })
        // Persist by loading the full settings blob, patching sidebar, and saving.
        try {
          const current = await api.settings.get.query()
          const updated = await api.settings.set.mutate({
            ...current,
            sidebar: { ...current.sidebar, ...next },
          })
          this.apply({ sidebarSettings: updated.sidebar })
        } catch {
          // best-effort — the optimistic state already applied
        }
      },
    } as Omit<Store<TApi>, keyof EngineState>
  }
}

export function createEngine<TApi extends PodiumClientApi = PodiumClientApi>(
  init: EngineInit<TApi>,
): Engine<TApi> {
  return new Engine(init)
}
