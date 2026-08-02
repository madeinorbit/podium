/**
 * The Podium client engine (#262 [spec:SP-3fe2]): the non-React core that used
 * to live inside react/provider.tsx as ~20 useEffects and a per-render value
 * object. It owns:
 *
 *  - SocketHub lifecycle + subscription wiring (via the P5a `on()` seam),
 *  - replica snapshot consumption (hydration/publication live in replica-binding),
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
  AutomationRunWire,
  AutomationWire,
  ConversationSummaryWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HostMetricsWire,
  IssueId,
  IssueWire,
  MachineWire,
  SessionId,
  SessionMeta,
} from '@podium/model'
import { asIssueId, asSessionId } from '@podium/model'
import type { ApprovalWire } from '@podium/protocol'
import type { Sidebar as SidebarSettings } from '@podium/runtime'
import type { PodiumClientApi } from '../api'
import { randomUUID } from '../id'
import type { OutboxDeadLetterEntry, OutboxEntry } from '../outbox'
import { markSwitch } from '../perf/switch-trace'
import type { IssueProjectionRow } from '../replica/contract'
import type { Replica, UiState } from '../replica/replica'
import {
  createRouter,
  DOCK_SHELLS_KEY,
  DOCK_TAB_KEY,
  ISSUE_SEL_KEY,
  type MainView,
  PANE_A_KEY,
  PANE_B_KEY,
  PANEL_MODE_KEY,
  RECENT_FILES_KEY,
  readStoredDockShells,
  readStoredPanelModes,
  readStoredRecentFiles,
  readStoredView,
  type Router,
  type RouterWindow,
  type RouteState,
  routeDefaults,
  SPLIT_KEY,
  SUPER_OPEN_KEY,
  VIEW_KEY,
  WT_KEY,
} from '../ui-state'
import type { FeedSinkPort, SocketHub } from '../socket-transport'
import { NotificationSounder } from '../sound/notification-sounds'
import { createDraftAgent, type SpawnTarget } from '../spawn-agent'
import { createSubscriptionStore, type SubscriptionStore } from '../store'
import {
  type DockTab,
  dedupeSessionsByResume,
  EMPTY_PINS,
  type FileTab,
  optimisticDraftIssue,
  optimisticDraftSortKey,
  optimisticStartingSession,
  type PinState,
  planWorktreeMoves,
  type RecentFileEntry,
  readStoredDockTab,
  reposToViews,
} from '../viewmodels'
import { createEngineActions } from './actions'
import {
  AWAITING_TRUTH_TTL_MS,
  type AwaitingTruth,
  EMPTY_ID_SET,
  foldOverlays,
  insertOverlay,
  legacyIssueReadOverlay,
  type OverlayEntity,
  overlayForOutboxEntry,
  type PendingOverlay,
  pruneAwaiting,
  rowFingerprint,
} from './overlay'
import {
  createReplicaBinding,
  type ReplicaBinding,
  type ReplicaPublication,
} from './replica-binding'
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

/** Throttle window (ms) for mark-read-on-view. The FIRST activity on the surface
 *  the operator is looking at marks it read immediately (POD-272 — it is already
 *  on screen); this window then bounds the follow-ups, so a streaming session
 *  costs one mutation per window plus one trailing pass rather than one a frame.
 *  Still the default trailing debounce for the standalone useMarkReadOnView. */
export const MARK_READ_ON_VIEW_MS = 1200

/** The stamp the server's issue-unread compares against read_at: the issue's own
 *  updatedAt, or a member session's activity when that is newer. Mirrors the
 *  server's computeUnread so the client reacts to exactly the same events. */
function issueActivityAt(issue: IssueWire, sessions: SessionMeta[]): string {
  let latest = issue.updatedAt
  for (const s of sessions) {
    if ((s.issueId ?? null) === issue.id && s.lastActiveAt > latest) latest = s.lastActiveAt
  }
  return latest
}

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
  /**
   * Replica factory — mobile injects the AsyncStorage-backed one. Called once.
   *
   * REQUIRED since POD-1239. It used to be optional, falling back to
   * `createReplica()` with no storage argument, which resolved
   * `window.localStorage` on its own — so the flag-off browser client adopted
   * ambient state on every boot.
   *
   * The client audit DID count that site — measured, not assumed: it reported
   * `engine.ts:297` on integration. The problem was where it POINTED. This file is
   * shared and platform-neutral, and attribution needs the CURRENT PRINCIPAL, which
   * client-core cannot know. So the finding named a file that could not host its own
   * fix; a platform agent reading it would find nothing here to do, which is a
   * quieter failure than an uncounted site and lasts just as long.
   *
   * Requiring the factory deletes the construction rather than defaulting it, so
   * every replica is built at a platform root that CAN answer the question. Audit
   * membership changes by exactly one — `engine.ts:297` out,
   * `apps/web/src/lib/webReplica.ts` in — and the count does not move, because
   * nothing was hidden and nothing new exposed. The finding became actionable.
   */
  createReplicaFn: () => Replica
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Test seam: replaces SocketHub construction (engine unit tests inject a fake). */
  createHub?: CreateHub
  /**
   * WIRE v2 / kernel replica (POD-1223). Supplied together with a
   * `createReplicaFn` that returns the kernel-backed facade: the platform layer
   * builds the whole assembly (store, kernel Replica, feed sink) and hands the
   * engine its two ends. Absent ⇒ the shipped v1 path, byte-for-byte unchanged.
   */
  feed?: FeedSinkPort
  /** Platform queue factory. Web injects the real kernel Outbox opened over IndexedDB. */
  createOutboxFn?: CreateEngineOutbox
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
  issueProjections: IssueProjectionRow[]
  conversations: ConversationSummaryWire[]
  automations: AutomationWire[]
  automationRuns: AutomationRunWire[]
  pendingSpawnIds: ReadonlySet<string>
  hostMetrics: HostMetricsWire[]
  machines: MachineWire[]
  /** Approval broker [spec:SP-edbb]: pending management-op requests (popup). */
  approvals: ApprovalWire[]
  pins: PinState
  tabOrders: Record<string, string[]>
  view: MainView
  settingsTab: string | null
  openIssueId: IssueId | null
  peekIssueId: IssueId | null
  superThreadId: string
  superOpen: boolean
  dockTab: DockTab
  superRefreshKey: number
  paletteOpen: boolean
  selectedWorktree: string | null
  selectedIssueId: IssueId | null
  paneA: SessionId | null
  paneB: SessionId | null
  split: boolean
  focusedPane: 'A' | 'B'
  panelMode: Record<string, 'chat' | 'native'>
  dockShells: Record<string, SessionId>
  dockVisibleSession: string | null
  autoContinuePromptSessionId: SessionId | null
  drafts: Record<string, string>
  sidebarSettings: SidebarSettings
  fileTabs: FileTab[]
  recentFiles: RecentFileEntry[]
  outboxSize: number
  outboxDeadLetters: OutboxDeadLetterEntry[]
  recoverOutbox: Store['recoverOutbox']
}

/** Narrow a raw route/persisted value into the session id space (POD-362). */
const asSessionIdOrNull = (v: string | null | undefined): SessionId | null =>
  v ? asSessionId(v) : null

/** The issue-id twin of {@link asSessionIdOrNull} (POD-363). Same DECODE EDGE:
 *  the URL route and `localStorage` hand back raw strings, and this is the one
 *  place they re-enter the id space — so the store's issue-selection surface can
 *  be branded end to end without a cast at every consumer. */
const asIssueIdOrNull = (v: string | null | undefined): IssueId | null => (v ? asIssueId(v) : null)

export class Engine<TApi extends PodiumClientApi = PodiumClientApi> {
  readonly replica: Replica
  readonly hub: SocketHub
  readonly outbox: EngineOutbox
  readonly router: Router
  readonly ui: UiState

  private readonly replicaBinding: ReplicaBinding

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
  private baseIssueProjections: IssueProjectionRow[] = []
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
  /** True when this engine runs on the wire-v2 feed (POD-1223). */
  private readonly onFeed: boolean
  /** Live spawn-confirm grace timers (#263 review round 2). Cleared in
   *  dispose(): a replaced engine's late timer must not roll back overlays or
   *  toast after its successor took over the same storage/session state. */
  private readonly spawnConfirmTimers = new Set<ReturnType<typeof setTimeout>>()
  /** Effective rendered mode per session (what AgentPanel actually shows),
   *  reported up the viewState channel. Not in the snapshot — only the setter
   *  is public — and not persisted (re-reported on mount from live state). */
  private panelRenderModes: Record<string, 'chat' | 'native'> = {}
  private prevRoute: RouteState
  private prevCwds: Record<string, string> = {}
  private markReadKey: string | null = null
  private markReadTimer: ReturnType<typeof setTimeout> | null = null
  /** When the focused session's eager mark-read last actually fired (POD-272) —
   *  the throttle window's origin, so a burst of activity costs one mutation. */
  private markReadFiredAt = 0
  private issueMarkReadKey: string | null = null
  private issueMarkReadTimer: ReturnType<typeof setTimeout> | null = null
  private issueMarkReadFiredAt = 0
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
    // No fallback (POD-1239): an engine that can build its own replica is a
    // construction site outside every composition root. The runtime check exists
    // because the type is only half the guard — an untyped caller omitting the
    // factory must fail LOUDLY here rather than quietly adopt ambient storage.
    if (typeof init.createReplicaFn !== 'function') {
      throw new Error(
        'createEngine requires createReplicaFn: the platform composition root builds the replica ' +
          'and is responsible for establishing that its persisted store belongs to the current ' +
          'principal (POD-307 / POD-1239).',
      )
    }
    this.replica = init.createReplicaFn()
    this.ui = this.replica.uiState()
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
          // A chained entry (enqueued behind a same-row sibling, #263 review
          // round 2) never uses the moved-past escape: its sibling's echo may
          // have landed while we were unloaded, and the stale enqueue baseline
          // would retire it on the first prune — coveredBy/TTL bound it instead.
          baseline: e.chained === true ? undefined : e.baseline,
          resolvedAt: e.resolvedAt ?? Date.now(),
        })
      } else {
        this.outbox.retireAwaiting(e.mutationId)
      }
    }
    this.awaitingTruth = restoredAwaiting
    // URL router (issue #15 Phase 4): the main surface is the URL. A plain '/'
    // start restores the persisted view; unknown URLs fall back to Tasks.
    this.router = createRouter({ fallbackView: readStoredView(this.ui), win: init.routerWindow })
    const route = this.router.current()
    this.prevRoute = route
    // Hydrate-first FIRST snapshot (#262 review): the replica's collections
    // load synchronous storage at construction, so seed the entity slices from
    // them BEFORE any subscriber reads — the old useReplicaRows path exposed
    // persisted rows at the very first render, and an empty initial snapshot
    // regressed that into "not found" flashes until start() (a passive effect)
    // ran. ReplicaBinding also owns async hydrate for adapters that need it.
    const replicaSeed = this.replicaBinding.snapshot()
    const seedSessions = replicaSeed.sessions
    this.baseSessions =
      seedSessions.length === 0 ? seedSessions : dedupeSessionsByResume(seedSessions)
    this.baseIssues = replicaSeed.issues
    this.baseIssueProjections = replicaSeed.issueProjections
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
    const seededProjectionFold = foldOverlays(
      this.baseIssueProjections,
      this.overlaysFor('issueProjections'),
      (i) => i.id,
    )
    this.state = {
      repos: [],
      reposLoading: false,
      reposLoaded: false,
      repoDiagnostics: [],
      sessions: seededSessionFold.rows,
      issues: seededIssueFold.rows,
      issueProjections: seededProjectionFold.rows,
      conversations: replicaSeed.conversations,
      automations: replicaSeed.automations,
      automationRuns: replicaSeed.automationRuns,
      pendingSpawnIds: EMPTY_ID_SET,
      hostMetrics: [],
      machines: [],
      approvals: [],
      pins: EMPTY_PINS,
      tabOrders: {},
      view: route.view,
      settingsTab: route.settingsTab,
      openIssueId: asIssueIdOrNull(route.issueId),
      peekIssueId: null,
      superThreadId: 'global',
      // Default OPEN: the superagent is the desktop shell's center column now, not
      // an optional dock — only an explicit close ('0') keeps it collapsed.
      superOpen: this.ui.get(SUPER_OPEN_KEY) !== '0',
      dockTab: readStoredDockTab(this.ui.get(DOCK_TAB_KEY)),
      superRefreshKey: 0,
      paletteOpen: false,
      // Workspace pane state: a deep-linked ?wt= wins over the persisted selection.
      selectedWorktree: route.worktree ?? this.ui.get(WT_KEY),
      selectedIssueId: asIssueIdOrNull(this.ui.get(ISSUE_SEL_KEY)),
      // DECODE EDGE: the pane selection comes from the URL route or persisted UI
      // state — both raw strings — so this is where it re-enters the id space.
      paneA: asSessionIdOrNull(route.pane ?? this.ui.get(PANE_A_KEY)),
      paneB: asSessionIdOrNull(this.ui.get(PANE_B_KEY)),
      split: this.ui.get(SPLIT_KEY) === '1',
      // Which pane has input focus. Not persisted — it resets to A on reload,
      // which is the right default (A is always the shown pane when split is off).
      focusedPane: 'A',
      panelMode: readStoredPanelModes(this.ui),
      dockShells: readStoredDockShells(this.ui),
      dockVisibleSession: null,
      autoContinuePromptSessionId: null,
      drafts: {},
      sidebarSettings: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
      fileTabs: [],
      recentFiles: readStoredRecentFiles(this.ui),
      outboxSize: 0,
      // Hydrate-first, like the entity slices above: the outbox constructor has
      // already restored its durable recovery home, so the first Store snapshot
      // must expose it without waiting for start() or another queue notification.
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
        this.apply({ outboxSize: size, outboxDeadLetters: this.outbox.deadLetters() })
        this.recomputeSessions()
        this.recomputeIssues()
        this.recomputeIssueProjections()
      }),
    )
    this.outbox.attach()
    this.apply({ outboxSize: this.outbox.size(), outboxDeadLetters: this.outbox.deadLetters() })
    // Restored awaiting-truth entries (see constructor) need the TTL backstop
    // armed even if no replica change ever recomputes them.
    this.armAwaitingSweep()

    // Entity state, single-sourced. ReplicaBinding owns preload + row
    // subscriptions and publishes a coalesced slice; engine.ts never hydrates or
    // reaches collection listeners directly.
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
        if (online > onlineMachines) void this.refreshRepos()
        onlineMachines = online
      }),
    )
    offs.push(
      this.hub.on('sessionDraft', (sessionId, text) => this.adoptSessionDraft(sessionId, text)),
    )
    // A daemon-created worktree is otherwise invisible in every repo menu until
    // reload (POD-665) — re-fetch through the same path used at boot.
    offs.push(this.hub.on('worktreesChanged', () => void this.refreshRepos()))
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
      document.addEventListener('visibilitychange', this.onVisibilityChange)
      offs.push(() => document.removeEventListener('visibilitychange', this.onVisibilityChange))
    }
    this.onVisibilityChange()

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
      void this.refreshPersonalSettings().catch(() => {})
      // These enrichments are network-derived, not the source of truth for the
      // principal slice. A cold offline boot must keep serving the persisted
      // replica instead of replacing it with a fatal connection screen.
      void Promise.all([this.refreshRepos(), this.refreshPins(), this.refreshTabOrders()]).catch(
        () => {},
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
    if (this.issueMarkReadTimer !== null) {
      clearTimeout(this.issueMarkReadTimer)
      this.issueMarkReadTimer = null
    }
    if (this.awaitingSweepTimer !== null) {
      clearTimeout(this.awaitingSweepTimer)
      this.awaitingSweepTimer = null
    }
    for (const t of this.spawnConfirmTimers) clearTimeout(t)
    this.spawnConfirmTimers.clear()
    this.markReadKey = null
    this.issueMarkReadKey = null
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
    if (changed.has('dockShells'))
      this.ui.set(DOCK_SHELLS_KEY, JSON.stringify(this.state.dockShells))
    if (changed.has('dockTab')) this.ui.set(DOCK_TAB_KEY, this.state.dockTab)
    if (changed.has('recentFiles'))
      this.ui.set(RECENT_FILES_KEY, JSON.stringify(this.state.recentFiles))
    // Session-follows-view policy (old lines 1113-1136): diffs consecutive
    // session snapshots, so it reacts to sessions only.
    if (changed.has('sessions')) this.reactWorktreeFollow()
    // Worktree fallback selection (old lines 1083-1105).
    if (any('sessions', 'repos', 'reposLoaded', 'selectedWorktree')) this.reactWorktreeFallback()
    // State→URL mirror — the single URL writer (old lines 1172-1176).
    if (any('selectedWorktree', 'paneA')) this.mirrorUrl()
    // View-state report to the server (old lines 1038-1060).
    if (any('paneA', 'paneB', 'split', 'focusedPane', 'dockVisibleSession')) this.reportViewState()
    // Mark-the-viewed-session-read reaction (old useMarkReadOnView call).
    if (any('sessions', 'paneA', 'paneB', 'split', 'focusedPane')) this.updateMarkReadTimer()
    // …and the same for the issue the operator has in the foreground (POD-272).
    if (any('issues', 'sessions', 'view', 'selectedIssueId', 'openIssueId'))
      this.updateIssueMarkReadTimer()
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
    this.mirrorUrl()
  }

  /**
   * INVARIANT (#262, replaces the provider's React-#185 hazard): the engine's
   * router is the ONLY writer of the URL. Every surface navigates through
   * engine actions (setView / setOpenIssueId / setSettingsTab)
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
    // The dock's shell (#23) renders OUTSIDE the panes — without reporting it
    // here the server's viewVisible gate drops its resizes and the terminal
    // stays pinned to the spawn-default 80×24.
    const visible = tabVisible
      ? [
          ...new Set(
            [st.paneA, st.split ? st.paneB : null, st.dockVisibleSession].filter(
              (x): x is SessionId => x != null,
            ),
          ),
        ]
      : []
    const focused = tabVisible ? (effectivePane === 'A' ? st.paneA : st.paneB) : null
    // Rendered mode (native/chat) for each visible session — default 'native'
    // until its AgentPanel reports its effective mode.
    const modes: Record<string, 'native' | 'chat'> = {}
    for (const sid of visible) modes[sid] = this.panelRenderModes[sid] ?? 'native'
    this.hub.setViewState(visible, focused, modes)
    // Switch-latency trace [POD-701]: stamp when the view-state report carrying
    // the traced session went out (markSwitch no-ops for untraced sessions).
    for (const sid of visible) markSwitch(sid, 'viewstate:sent')
  }

  private readonly onVisibilityChange = (): void => {
    this.hub.setVisible(tabIsVisible())
    this.reportViewState()
  }

  /** Mark the session the operator is LOOKING AT read on view (#138), keyed on
   *  the focused session's id + activity. The activity that lands while the
   *  session IS the open pane is already on screen, so it's marked read EAGERLY
   *  — leading edge, no settle wait (POD-272: waiting left a "new" chip on the
   *  row of the very session being read). MARK_READ_ON_VIEW_MS survives as the
   *  throttle window: a burst costs one mutation now plus one trailing pass, so
   *  a streaming session still can't spam the outbox.
   *
   *  The trigger stays ACTIVITY, never the `unread` flag itself, so manually
   *  marking the open session unread isn't instantly undone; `unread` +
   *  visibility are re-checked at fire time. */
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
    const wait = MARK_READ_ON_VIEW_MS - (Date.now() - this.markReadFiredAt)
    if (wait <= 0) {
      this.fireMarkSessionRead(sessionId)
      return
    }
    this.markReadTimer = setTimeout(() => {
      this.markReadTimer = null
      this.fireMarkSessionRead(sessionId)
    }, wait)
  }

  /** The guarded mark-read itself: only when this session is STILL the focused
   *  pane, still unread, and the tab is visible. */
  private fireMarkSessionRead(sessionId: SessionId): void {
    const cur = this.state
    const curFocused = cur.split ? (cur.focusedPane === 'A' ? cur.paneA : cur.paneB) : cur.paneA
    const s = cur.sessions.find((x) => x.sessionId === sessionId)
    if (curFocused !== sessionId || s?.unread !== true || !tabIsVisible()) return
    this.markReadFiredAt = Date.now()
    void this.statics.markSessionRead(sessionId)
  }

  /** The issue in the FOREGROUND: the open issue page, or the issue whose
   *  sessions the workspace is showing. Any other surface has none. */
  private foregroundIssue(): IssueWire | undefined {
    const st = this.state
    const id =
      st.view === 'issues' ? st.openIssueId : st.view === 'workspace' ? st.selectedIssueId : null
    return id ? st.issues.find((i) => i.id === id) : undefined
  }

  /** The issue half of eager mark-read-on-view (POD-272): while an issue is the
   *  foreground surface its incoming activity is on screen, so the row must not
   *  hold a "new message" chip for it. Same shape as the session reaction —
   *  keyed on activity (so a manual mark-unread sticks), leading edge, throttled
   *  by MARK_READ_ON_VIEW_MS. */
  private updateIssueMarkReadTimer(): void {
    const issue = this.foregroundIssue()
    const key = issue ? `${issue.id}\n${issueActivityAt(issue, this.state.sessions)}` : null
    if (key === this.issueMarkReadKey) return
    this.issueMarkReadKey = key
    if (this.issueMarkReadTimer !== null) {
      clearTimeout(this.issueMarkReadTimer)
      this.issueMarkReadTimer = null
    }
    if (!issue) return
    const issueId = issue.id
    const wait = MARK_READ_ON_VIEW_MS - (Date.now() - this.issueMarkReadFiredAt)
    if (wait <= 0) {
      this.fireMarkIssueRead(issueId)
      return
    }
    this.issueMarkReadTimer = setTimeout(() => {
      this.issueMarkReadTimer = null
      this.fireMarkIssueRead(issueId)
    }, wait)
  }

  private fireMarkIssueRead(issueId: string): void {
    const issue = this.foregroundIssue()
    if (issue?.id !== issueId || !tabIsVisible()) return
    const activityAt = Date.parse(issueActivityAt(issue, this.state.sessions))
    const readAt = issue.readAt ? Date.parse(issue.readAt) : Number.NaN
    const unread = !Number.isFinite(readAt) || (Number.isFinite(activityAt) && activityAt > readAt)
    if (!unread) return
    this.issueMarkReadFiredAt = Date.now()
    void this.statics.markIssueRead(issueId)
  }

  // ----------------------------------------------------------- replica ↔ state

  private publishReplica(publication: ReplicaPublication): void {
    const { snapshot, changed } = publication
    if (changed.has('sessions')) {
      const rows = snapshot.sessions
      // Collapse duplicate rows for the same underlying conversation (e.g. a
      // Codex thread surfaced twice on resume).
      this.baseSessions = rows.length === 0 ? rows : dedupeSessionsByResume(rows)
      this.recomputeSessions()
    }
    if (changed.has('issues')) {
      this.baseIssues = snapshot.issues
      this.recomputeIssues()
    }
    if (changed.has('issueProjections')) {
      this.baseIssueProjections = snapshot.issueProjections
      this.recomputeIssueProjections()
    }
    const patch: Partial<EngineState> = {}
    if (changed.has('conversations')) patch.conversations = snapshot.conversations
    if (changed.has('automations')) patch.automations = snapshot.automations
    if (changed.has('automationRuns')) patch.automationRuns = snapshot.automationRuns
    this.apply(patch)
  }

  /** The pending overlays for one entity, in application order: resolved
   *  patches awaiting truth first (they were sent earliest), then the queued
   *  outbox entries FIFO — so two pending mutations on the same row compose in
   *  queue order — plus the #119 spawn placeholder inserts (order-independent:
   *  folding applies inserts before any patch). Derived fresh each recompute:
   *  the outbox itself is the queued-overlay state, never a second copy. */
  private overlaysFor(entity: OverlayEntity): PendingOverlay[] {
    const out: PendingOverlay[] = []
    const include = (overlay: PendingOverlay): void => {
      if (overlay.entity === entity) out.push(overlay)
      if (entity === 'issues') {
        const compatibility = legacyIssueReadOverlay(overlay)
        if (compatibility) out.push(compatibility)
      }
    }
    for (const overlay of this.spawnOverlays) include(overlay)
    for (const awaiting of this.awaitingTruth) include(awaiting.overlay)
    for (const entry of this.outbox.pending()) {
      const overlay = overlayForOutboxEntry(entry)
      if (overlay) include(overlay)
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

  private recomputeIssueProjections(): void {
    const base = this.baseIssueProjections
    const keyOf = (i: IssueProjectionRow): string => i.id
    // During the additive cutover a legacy row can arrive before its normalized
    // projection. Keep a resolved read overlay alive against that row instead
    // of treating the temporarily absent projection as deletion.
    const normalizedIds = new Set(base.map(keyOf))
    const retirementBase: IssueProjectionRow[] = [
      ...base,
      ...this.baseIssues
        .filter((issue) => !normalizedIds.has(issue.id))
        .map(
          (issue) =>
            ({
              id: issue.id,
              readAt:
                (issue as IssueWire & { unread?: boolean }).unread === true
                  ? null
                  : (issue.readAt ?? null),
            }) as IssueProjectionRow,
        ),
    ]
    this.retireCovered('issueProjections', retirementBase, keyOf)
    const { rows } = foldOverlays(base, this.overlaysFor('issueProjections'), keyOf)
    this.apply({ issueProjections: rows })
  }

  private recomputeFor(entity: OverlayEntity | undefined): void {
    if (entity === 'sessions') this.recomputeSessions()
    else if (entity === 'issues') this.recomputeIssues()
    else if (entity === 'issueProjections') {
      this.recomputeIssueProjections()
      this.recomputeIssues()
    }
  }

  /** Drain success (#263): hand the entry's overlay to the awaiting-truth
   *  stage. Called by the outbox BEFORE it notifies subscribers of the
   *  shrunken queue, so no intermediate snapshot ever lacks the overlay.
   *  Returns true to keep the entry DURABLY in storage (finding 1) until
   *  covering truth retires it. */
  private onMutationApplied(entry: OutboxEntry): boolean {
    if (this.reconcileActionState(entry)) return false
    const overlay = overlayForOutboxEntry(entry)
    if (overlay?.op !== 'patch') return false
    const row =
      overlay.entity === 'sessions'
        ? this.baseSessions.find((s) => s.sessionId === overlay.id)
        : overlay.entity === 'issues'
          ? this.baseIssues.find((i) => i.id === overlay.id)
          : (this.baseIssueProjections.find((i) => i.id === overlay.id) ??
            this.baseIssues
              .filter((i) => i.id === overlay.id)
              .map(
                (i) =>
                  ({
                    id: i.id,
                    readAt:
                      (i as IssueWire & { unread?: boolean }).unread === true
                        ? null
                        : (i.readAt ?? null),
                  }) as IssueProjectionRow,
              )
              .at(0))
    // Hold the overlay until covering truth lands. Nothing to hold when the
    // row is gone, already reflects the mutation (the broadcast echo raced
    // ahead of the response), or moved past the ENQUEUE-time baseline without
    // covering it (finding 2: covering-or-competing truth already landed — a
    // resolution-time fingerprint of that final row would never "move" again
    // and the overlay would mask server truth forever).
    //
    // EXCEPT (#263 review round 2): when an OLDER same-row entry exists — this
    // entry was enqueued behind a sibling (`chained`), or a sibling is still
    // awaiting truth — the movement is almost certainly the PREDECESSOR'S echo,
    // not a competing writer. Dropping here would flash the predecessor's value
    // until this entry's own echo lands. Hold instead, WITHOUT the moved-past
    // escape (baseline undefined — the stale enqueue baseline would trip on the
    // sibling's echo at the very next prune pass); coveredBy / row-gone / the
    // TTL retire it, exactly the bounds the oldest-first rule already relies on.
    let hold = false
    if (row !== undefined && !overlay.coveredBy(row)) {
      const olderSameRow =
        entry.chained === true ||
        this.awaitingTruth.some(
          (a) => a.overlay.entity === overlay.entity && a.overlay.id === overlay.id,
        )
      const moved = entry.baseline !== undefined && rowFingerprint(row) !== entry.baseline
      if (moved && !olderSameRow) {
        // Competing truth won while the mutation was in flight — server wins.
      } else {
        hold = true
        this.awaitingTruth = [
          ...this.awaitingTruth,
          { overlay, baseline: olderSameRow ? undefined : entry.baseline, resolvedAt: Date.now() },
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
      this.recomputeIssueProjections()
      this.armAwaitingSweep()
    }, delay)
  }

  /** Definitive failure — retirement rule (b): the wiring already surfaced the
   *  poison toast; repaint without the dropped entry's overlay. */
  private onMutationDropped(entry: OutboxEntry): void {
    this.reconcileActionState(entry)
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  /** Enqueue + repaint: the queued entry IS the optimistic apply (#263). The
   *  outbox subscription (armed in start()) already repaints on any queue
   *  change; recomputing here as well keeps actions optimistic before start()
   *  and after dispose() (the duplicate recompute is a no-op publish). */
  private reconcileActionState(entry: OutboxEntry): boolean {
    if (entry.kind === 'pinSet') {
      void this.refreshPins().catch(() => {})
      return true
    }
    if (entry.kind === 'tabSetOrder') {
      void this.refreshTabOrders().catch(() => {})
      return true
    }
    if (entry.kind === 'settingsUpdatePersonal') {
      void this.refreshPersonalSettings().catch(() => {})
      return true
    }
    return false
  }

  private async enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
  ): Promise<void> {
    // Enqueue-time baseline (#263 review finding 2): fingerprint the target
    // row's REPLICA truth (unpainted — the replica is server truth only) so
    // resolution can tell whether truth already moved while in flight.
    const probe = overlayForOutboxEntry({ mutationId: '', kind, input, queuedAt: 0 })
    let baseline: string | undefined
    let chained = false
    if (probe?.op === 'patch') {
      const row =
        probe.entity === 'sessions'
          ? this.baseSessions.find((s) => s.sessionId === probe.id)
          : probe.entity === 'issues'
            ? this.baseIssues.find((i) => i.id === probe.id)
            : this.baseIssueProjections.find((i) => i.id === probe.id)
      if (row !== undefined) baseline = rowFingerprint(row)
      // Chained stamp (#263 review round 2): a same-row entry already pending
      // (queued or awaiting) means ITS echo will move the row past this
      // baseline while this mutation is in flight — resolution must not read
      // that movement as a competing writer (see onMutationApplied).
      const sameRow = (o: PendingOverlay | null): boolean =>
        o?.op === 'patch' && o.entity === probe.entity && o.id === probe.id
      chained =
        this.awaitingTruth.some((a) => sameRow(a.overlay)) ||
        this.outbox.pending().some((e) => sameRow(overlayForOutboxEntry(e)))
    }
    const entry = await this.outbox.enqueue(kind, input, {
      ...(baseline !== undefined ? { baseline } : {}),
      ...(chained ? { chained } : {}),
    })
    this.recomputeFor(overlayForOutboxEntry(entry)?.entity)
  }

  private adoptSessionDraft(sessionId: SessionId, text: string): void {
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
    this.ui.set(DOCK_SHELLS_KEY, JSON.stringify(st.dockShells))
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

  private async refreshPersonalSettings(): Promise<void> {
    const settings = await this.api.settings.get.query()
    this.apply({ sidebarSettings: settings.sidebar })
  }

  private getUserFocus(): UserFocus {
    const st = this.state
    const paneIds = [st.paneA, st.split ? st.paneB : null].filter((x): x is SessionId => x != null)
    const focusedId = st.split ? (st.focusedPane === 'A' ? st.paneA : st.paneB) : st.paneA
    const isSession = (id: SessionId): boolean => st.sessions.some((s) => s.sessionId === id)
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

  // Land a just-opened file/artifact tab on screen (#101) — the file-tab twin of
  // navigateToSession: opening a tab from a non-workspace view (issues page,
  // peek overlay) must switch to the workspace via the router (mirrorUrl bails
  // unless the view is already 'workspace', and setView would re-apply the
  // current route's stale pane). Selecting the tab's issue/worktree keeps
  // fileTabsForWorkspace from dropping the tab and bouncing the pane; an open
  // peek overlay is closed so the tab is actually visible.
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

  // ------------------------------------------------------------------- actions
  private spawnDraftAgent(args: {
    target: SpawnTarget
    agentKind: AgentKind
    firstPrompt?: string
  }): { sessionId: SessionId; issueId: IssueId } {
    const sessionId = asSessionId(randomUUID())
    const issueId = asIssueId(`iss_${randomUUID()}`)
    const nowIso = new Date().toISOString()
    const sortKey = optimisticDraftSortKey(
      this.state.issues,
      args.target.repoPath,
      args.target.repoId,
    )
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
          repoId: args.target.repoId,
          sortKey,
          agentKind: args.agentKind,
          nowIso,
        }),
      ),
    ]
    this.recomputeSessions()
    this.recomputeIssues()
    void createDraftAgent({
      trpc: this.api,
      sessionId,
      issueId,
      target: args.target,
      agentKind: args.agentKind,
      firstPrompt: args.firstPrompt,
    }).catch((error) => {
      const arrived = (): boolean => this.baseSessions.some((row) => row.sessionId === sessionId)
      const settleFailure = (): void => {
        if (arrived()) {
          console.debug(
            '[podium] spawn transport failed after the session was created — treating as success',
            sessionId,
            error,
          )
          return
        }
        this.spawnOverlays = this.spawnOverlays.filter(
          (overlay) => overlay.id !== sessionId && overlay.id !== issueId,
        )
        this.recomputeSessions()
        this.recomputeIssues()
        this.notices.error(
          `Couldn't start the agent — ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
      if (arrived()) {
        settleFailure()
      } else {
        const timer = setTimeout(() => {
          this.spawnConfirmTimers.delete(timer)
          settleFailure()
        }, this.spawnConfirmGraceMs)
        this.spawnConfirmTimers.add(timer)
      }
    })
    return { sessionId, issueId }
  }

  private buildStatics(): Omit<Store<TApi>, keyof EngineState> {
    return {
      hub: this.hub,
      trpc: this.api,
      replica: this.replica,
      uiState: this.ui,
      httpOrigin: this.httpOrigin,
      getUserFocus: () => this.getUserFocus(),
      refreshRepos: () => this.refreshRepos(),
      ...createEngineActions({
        api: this.api,
        hub: this.hub,
        outbox: this.outbox,
        router: this.router,
        notices: this.notices,
        state: () => this.state,
        apply: (patch) => this.apply(patch),
        enqueueOverlayed: (kind, input) => {
          void this.enqueueOverlayed(kind, input)
        },
        revealFileTab: (args) => this.revealFileTab(args),
        recordRecentFile: (entry) => this.recordRecentFile(entry),
        setPanelRenderMode: (sessionId, mode) => {
          if (this.panelRenderModes[sessionId] === mode) return
          this.panelRenderModes = { ...this.panelRenderModes, [sessionId]: mode }
          this.reportViewState()
        },
        spawnDraftAgent: (args) => this.spawnDraftAgent(args),
        setSessionDraft: (sessionId, text) => {
          this.adoptSessionDraft(sessionId, text)
          this.hub.sendSessionDraft(sessionId, text)
        },
      }),
    }
  }
}

export function createEngine<TApi extends PodiumClientApi = PodiumClientApi>(
  init: EngineInit<TApi>,
): Engine<TApi> {
  return new Engine(init)
}
