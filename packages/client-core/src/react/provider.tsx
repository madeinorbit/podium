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
import { SocketHub } from '@podium/terminal-client'
import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { PodiumClientApi } from '../api'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type StoreNotices,
  type StoreServerConfig,
  type UserFocus,
} from '../engine/types'
import { createEngineHub, createEngineOutbox } from '../engine/wiring'
import { useReplicaRows } from '../replica/react'
import { createReplica, type Replica, type UiState } from '../replica/replica'
import {
  createRouter,
  type MainView,
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
  mergeOptimistic,
  optimisticDraftIssue,
  optimisticStartingSession,
  type PinKind,
  type PinState,
  planWorktreeMoves,
  readStoredDockTab,
  reposToViews,
  tabIdFor,
} from '../viewmodels'
import { useMarkReadOnView } from './use-mark-read-on-view'

// Shared engine seams (#262): types live with the engine; re-exported here so
// the react entrypoint's public surface is unchanged.
export type { StoreNotices, StoreServerConfig, UserFocus } from '../engine/types'

export interface Store<TApi extends PodiumClientApi = PodiumClientApi> {
  hub: SocketHub
  trpc: TApi
  /** Local replica (docs/spec/thin-client-replica.md): the ONE entity read
   *  path (sessions/issues/conversations) + offline transcript windows. When
   *  durable storage is unusable (private mode) the same collections run in
   *  memory — `replica.persistent` is false and a reload cold-starts. */
  replica: Replica
  repos: GitRepositoryWire[]
  reposLoading: boolean
  /** True once the first repo refresh has resolved — lets the UI distinguish
   *  "still loading" from "registry is genuinely empty" (first-run onboarding). */
  reposLoaded: boolean
  repoDiagnostics: GitDiscoveryDiagnosticWire[]
  sessions: SessionMeta[]
  /** Issues (work items) broadcast by the server — full list, refreshed on every mutation. */
  issues: IssueWire[]
  /** Conversation summaries mirrored from the replica (offline search, mobile inbox). */
  conversations: ConversationSummaryWire[]
  /** Session ids painted optimistically that the server hasn't confirmed yet (#119).
   *  AgentPanel gates its terminal attach on this — attaching to a not-yet-created
   *  session is dropped and never retried, so it must wait for reconciliation. */
  pendingSpawnIds: ReadonlySet<string>
  /** Latest health sample per daemon host; empty until a daemon reports (or after it drops). */
  hostMetrics: HostMetricsWire[]
  /** Connected machines registered with this Podium server; refreshed via machinesChanged. */
  machines: MachineWire[]
  pins: PinState
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** Manual tab order per worktree path (drag-to-reorder). Absent key = no manual order. */
  tabOrders: Record<string, string[]>
  setTabOrder: (worktree: string, sessionIds: string[]) => Promise<void>
  /** Main-area surface: attention board, worktree workspace, superagent, or settings. */
  view: MainView
  setView: (view: MainView) => void
  /** Deep-link target for the Settings view — a tab key (e.g. from global search).
   *  Consumed and cleared by SettingsView on mount. */
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
  /** Active superagent thread: the 'global' orchestrator or a 'btw_<sessionId>' thread. */
  superThreadId: string
  setSuperThreadId: (id: string) => void
  /** Whether the superagent panel is open — a collapsible right dock on desktop,
   *  a minimizable overlay on mobile (no longer a full-screen view). */
  superOpen: boolean
  dockTab: DockTab
  setDockTab: (tab: DockTab) => void
  setSuperOpen: (open: boolean) => void
  /** Bumped when a btw thread finishes seeding, so the superagent view refetches. */
  superRefreshKey: number
  /** Open (or re-open) a btw superagent thread seeded from a chat session's transcript. */
  startBtw: (sessionId: string) => Promise<void>
  /** Open the session's btw thread and ask the superagent for a concise tl;dr of
   *  the agent's last answer (passed in for context). */
  tldrSession: (sessionId: string, answerText: string) => Promise<void>
  /** The issue whose detail drawer is open (from the kanban card or the sidebar
   *  Issues tab), or null when closed. Ephemeral — not persisted. */
  openIssueId: string | null
  setOpenIssueId: (id: string | null) => void
  /** Whether the Cmd/Ctrl+K command palette is open. In the store (not palette-
   *  local) so other surfaces (toolbar button, shell shortcut) can open it. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  /** Whether the conversation-search overlay is open. Route-backed (/search or
   *  ?search=1), so a deep link opens it and back closes it. */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  /** Issue-keyed workspace selection (unified sidebar only): the issue whose
   *  sessions the center tab strip shows. Null = today's worktree-keyed view.
   *  Classic sidebar never sets it; unified worktree rows clear it. */
  selectedIssueId: string | null
  setSelectedIssueId: (id: string | null) => void
  paneA: string | null // sessionId in pane A
  paneB: string | null // sessionId in pane B (null = no split)
  setPane: (pane: 'A' | 'B', sessionId: string | null) => void
  /** Which split pane currently holds input focus — drives the `focused` field of
   *  the view-state the client reports so the server prioritizes that session's PTY
   *  relay. Only meaningful when `split` is on; clamps to 'A' otherwise. */
  focusedPane: 'A' | 'B'
  setFocusedPane: (pane: 'A' | 'B') => void
  /** Per-session chat-vs-native panel mode, persisted across reloads so a session
   *  returns to the view the user last left it in. A missing entry falls back to the
   *  per-device default; the hibernated/exited-forces-chat rule still wins over it. */
  panelMode: Record<string, 'chat' | 'native'>
  setPanelMode: (sessionId: string, mode: 'chat' | 'native') => void
  /** The EFFECTIVE rendered mode per session (native terminal vs chat) as each
   *  AgentPanel computes it — distinct from the saved `panelMode` override. Reported
   *  up the viewState channel so the server has the signal; not persisted. */
  setPanelRenderMode: (sessionId: string, mode: 'chat' | 'native') => void
  fileTabs: FileTab[]
  openFile: (sessionId: string, path: string) => void
  openFileInWorktree: (args: { machineId?: string; root: string; path: string }) => void
  closeFileTab: (id: string) => void
  readFileScoped: (
    scope: FileScope,
    path: string,
  ) => Promise<Awaited<ReturnType<TApi['files']['read']['query']>>>
  writeFileScoped: (args: {
    scope: FileScope
    path: string
    content: string
    baseHash?: string
  }) => Promise<Awaited<ReturnType<TApi['files']['write']['mutate']>>>
  listDir: (args: {
    machineId?: string
    root: string
    path?: string
  }) => Promise<Awaited<ReturnType<TApi['files']['list']['query']>>>
  split: boolean
  toggleSplit: () => void
  /** Enrich the registered repos with branch/worktree metadata (fast — no
   *  filesystem walk). Discovery scanning happens explicitly via the scan flow. */
  refreshRepos: () => Promise<void>
  /** Start a new agent optimistically (#119): mints client ids, paints a
   *  'starting' session + its draft-issue vessel INSTANTLY (an overlay over the
   *  server rows), then fires `sessions.create` in the background reusing those
   *  ids so the broadcast reconciles by id — and rolls the optimistic rows back
   *  if the create never lands. Returns the ids synchronously so the caller
   *  navigates without waiting on the round-trip. */
  spawnDraftAgent: (args: { target: SpawnTarget; agentKind: AgentKind; firstPrompt?: string }) => {
    sessionId: string
    issueId: string
  }
  killSession: (sessionId: string) => Promise<void>
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: string) => Promise<void>
  /** Session whose first manual Continue should raise the auto-continue popup,
   *  or null when the popup is closed. */
  autoContinuePromptSessionId: string | null
  closeAutoContinuePrompt: () => void
  renameSession: (sessionId: string, name: string) => Promise<void>
  hibernateSession: (sessionId: string) => Promise<void>
  resurrectSession: (sessionId: string) => Promise<void>
  /** Send a chat message to a parked (hibernated/exited) session, waking it
   *  first and delivering the text once it's ready. Falls back to a plain send
   *  when the session is already live. */
  resumeAndSend: (sessionId: string, text: string) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  setWorkState: (sessionId: string, workState: WorkState | null) => Promise<void>
  /** Snooze a session out of the attention surface. `until` = null → until next
   *  message; ISO string → timed. Orthogonal to agent state. */
  setSnooze: (sessionId: string, until: string | null) => Promise<void>
  /** Un-snooze a session (return it to the normal attention flow). */
  clearSnooze: (sessionId: string) => Promise<void>
  /** Mark a session read (issue #124): stamp readAt = now, clearing derived `unread`.
   *  Optimistic + outboxed. Called when the operator opens/focuses the session. */
  markSessionRead: (sessionId: string) => Promise<void>
  /** Mark a session UNREAD again (issue #138, email-style inverse of markSessionRead):
   *  stamp readAt = null so derived `unread` flips back to true. Optimistic + outboxed. */
  markSessionUnread: (sessionId: string) => Promise<void>
  /** Mark an issue read (issue #124): stamp readAt = now, clearing derived `unread`.
   *  Optimistic + outboxed. Called when the operator opens the issue. */
  markIssueRead: (id: string) => Promise<void>
  /** Mark an issue UNREAD again (issue #138, email-style inverse of markIssueRead):
   *  stamp readAt = null so derived `unread` flips back to true. Optimistic + outboxed. */
  markIssueUnread: (id: string) => Promise<void>
  /** Per-session chat composer draft, shared across every view of that session
   *  (chat panes, split view) and preserved across chat/native mode switches.
   *  The native PTY input line is opaque bytes we can't read back, so this is the
   *  one input state we *can* synchronize. */
  drafts: Record<string, string>
  setSessionDraft: (sessionId: string, text: string) => void
  /** Sidebar layout preferences (repo sort mode + custom order). */
  sidebarSettings: SidebarSettings
  /** Persist a new sidebar sort/order — optimistic update + server round-trip. */
  setSidebarSettings: (next: Partial<SidebarSettings>) => Promise<void>
  /** ONE UI persistence mechanism: the replica's versioned ui-state collection
   *  (see replica.uiState()) — components persist prefs through this, never
   *  through ad-hoc localStorage keys. */
  uiState: UiState
  /** Server HTTP origin — used to build asset URLs (e.g. markdown images). */
  httpOrigin: string
  /** Count of not-yet-synced outbox entries (offline-authored writes waiting to
   *  replay) — drives the "pending" chip in HostIndicators. */
  outboxSize: number
  /** What the user is LOOKING AT right now (#225): the screen, selected issue/
   *  worktree, session(s) on screen. Ids only — the server resolves them to
   *  titles/names. Read through a ref internally so this stays a stable function
   *  identity and never forces a re-render on pane/session churn. */
  getUserFocus: () => UserFocus
}

// The main-view union lives with the router (URL ↔ view mapping).
export type { MainView } from '../router'
export type { FileTab } from '../viewmodels'

// The context carries a subscription-store HANDLE (stable identity for the
// provider's lifetime), not the value object — so a provider re-render never
// re-renders consumers by itself. Consumers subscribe via useSyncExternalStore
// (useStore / useStoreSelector below) and only re-render when the slice they
// read actually changed.
const Ctx = createContext<SubscriptionStore<Store<PodiumClientApi>> | null>(null)

// Persist the "where am I" state so a reload (the PWA cold-starts often on
// mobile) lands back on the same surface. All UI persistence goes through the
// replica's ONE versioned ui-state collection (replica.uiState()); the old
// ad-hoc localStorage keys are migrated in there once and removed.
const VIEW_KEY = 'podium.view'
const WT_KEY = 'podium.selectedWorktree'
const ISSUE_SEL_KEY = 'podium.selectedIssueId'

const DOCK_TAB_KEY = 'podium.dockTab'
const PANE_A_KEY = 'podium.paneA'
const PANE_B_KEY = 'podium.paneB'
const SPLIT_KEY = 'podium.split'
const SUPER_OPEN_KEY = 'podium.superOpen'
const PANEL_MODE_KEY = 'podium.panelMode'
function readStoredView(ui: UiState): MainView {
  const v = ui.get(VIEW_KEY)
  // 'superagent' is no longer a full view (it's a dock now) — a returning user who
  // left on it lands on home instead of a dead surface.
  return v === 'home' ||
    v === 'workspace' ||
    v === 'settings' ||
    v === 'usage' ||
    v === 'issues' ||
    v === 'automations' ||
    v === 'specs'
    ? v
    : 'home'
}
/** The persisted per-session panel-mode map. A corrupt/missing blob reads as empty. */
function readStoredPanelModes(ui: UiState): Record<string, 'chat' | 'native'> {
  const raw = ui.get(PANEL_MODE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, 'chat' | 'native'> = {}
    for (const [id, m] of Object.entries(parsed as Record<string, unknown>)) {
      if (m === 'chat' || m === 'native') out[id] = m
    }
    return out
  } catch {
    return {}
  }
}

/** Stable empty set so `pendingSpawnIds` keeps identity when nothing is pending. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set()

export interface StoreProviderProps<TApi extends PodiumClientApi> {
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
  children: ReactNode
}

export function StoreProvider<TApi extends PodiumClientApi>({
  config,
  api,
  onFatalError,
  formatError = defaultFormatError,
  notices = NOOP_NOTICES,
  createReplicaFn,
  routerWindow,
  children,
}: StoreProviderProps<TApi>): JSX.Element {
  const trpc = api
  // Persistent local replica (docs/spec/thin-client-replica.md). Constructed
  // synchronously so its persisted cursor can seed the hub's first changesSince;
  // entity hydration happens async in the mount effect below. When storage is
  // unavailable the replica is inert and everything behaves exactly like today.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the factory is intentionally consulted once
  const replica = useMemo(() => (createReplicaFn ? createReplicaFn() : createReplica()), [])
  // The ONE UI persistence mechanism: a versioned ui-state collection in the
  // replica (in-memory in private mode — same seam, best-effort durability).
  const ui = useMemo(() => replica.uiState(), [replica])
  const hub = useMemo(
    () => createEngineHub({ wsClientUrl: config.wsClientUrl, api: trpc, replica, onFatalError }),
    [config.wsClientUrl, onFatalError, trpc, replica],
  )
  // Durable write path for the covered mutations: optimistic local apply stays in
  // each store method; the server round-trip goes through the outbox so an offline
  // write survives a reload and replays (deduped by mutationId) on reconnect.
  const outbox = useMemo(
    () => createEngineOutbox({ api: trpc, replica, notices }),
    [trpc, replica, notices],
  )
  const [outboxSize, setOutboxSize] = useState(0)
  useEffect(() => {
    setOutboxSize(outbox.size())
    const off = outbox.subscribe(setOutboxSize)
    // attach/dispose pair (not constructor-only): StrictMode's dev double-mount
    // disposes the memoized instance once, so the mount must re-arm its triggers.
    outbox.attach()
    return () => {
      off()
      outbox.dispose()
    }
  }, [outbox])

  const [repos, setRepos] = useState<GitRepositoryWire[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [reposLoaded, setReposLoaded] = useState(false)
  const [repoDiagnostics, setRepoDiagnostics] = useState<GitDiscoveryDiagnosticWire[]>([])
  // Entity state, single-sourced: sessions/issues are TanStack DB live queries
  // over the replica's collections — the hub writes ONLY into the replica
  // (onMetadataApplied above) and the queries re-render from there. In private
  // browsing the same collections run in memory (replica.ts), so there is no
  // parallel entity path.
  const liveSessionRows = useReplicaRows(replica, 'sessions')
  const liveIssueRows = useReplicaRows(replica, 'issues')
  const conversations = useReplicaRows(replica, 'conversations')
  // Collapse duplicate rows for the same underlying conversation (e.g. a Codex
  // thread surfaced twice on resume); memoized so list identity only changes
  // when the underlying rows do (no per-render churn).
  const baseSessions = useMemo(() => dedupeSessionsByResume(liveSessionRows), [liveSessionRows])
  const baseIssues = liveIssueRows
  // Optimistic spawn overlay (#119): client-minted session + draft-issue rows
  // shown INSTANTLY on "New <Agent>", merged over server truth below and pruned
  // once the real row (same id) lands. Ephemeral (not persisted / not outboxed):
  // a create must spawn a process, which can't happen offline, so there's nothing
  // durable to queue — this only hides the online round-trip latency.
  const [optimisticSessions, setOptimisticSessions] = useState<SessionMeta[]>([])
  const [optimisticIssues, setOptimisticIssues] = useState<IssueWire[]>([])
  const sessions = useMemo(
    () => mergeOptimistic(baseSessions, optimisticSessions, (s) => s.sessionId),
    [baseSessions, optimisticSessions],
  )
  const issues = useMemo(
    () => mergeOptimistic(baseIssues, optimisticIssues, (i) => i.id),
    [baseIssues, optimisticIssues],
  )
  // Reconcile: drop an optimistic row once server truth for its id arrives (the
  // merge already lets the base win; this keeps the overlay from growing).
  useEffect(() => {
    if (optimisticSessions.length === 0) return
    const known = new Set(baseSessions.map((s) => s.sessionId))
    const keep = optimisticSessions.filter((s) => !known.has(s.sessionId))
    if (keep.length !== optimisticSessions.length) setOptimisticSessions(keep)
  }, [baseSessions, optimisticSessions])
  useEffect(() => {
    if (optimisticIssues.length === 0) return
    const known = new Set(baseIssues.map((i) => i.id))
    const keep = optimisticIssues.filter((i) => !known.has(i.id))
    if (keep.length !== optimisticIssues.length) setOptimisticIssues(keep)
  }, [baseIssues, optimisticIssues])
  // Session ids shown optimistically but NOT yet confirmed by the server. The
  // terminal must not attach to these: the session doesn't exist server-side yet,
  // so `hub.attach` is dropped and (since the sessionId never changes) never
  // re-sent — leaving the pane black until a manual remount. AgentPanel gates its
  // mount on this and attaches the instant the real session reconciles in (#119).
  const pendingSpawnIds = useMemo(() => {
    if (optimisticSessions.length === 0) return EMPTY_STRING_SET
    const known = new Set(baseSessions.map((s) => s.sessionId))
    return new Set(optimisticSessions.map((s) => s.sessionId).filter((id) => !known.has(id)))
  }, [optimisticSessions, baseSessions])
  // Optimistic local apply for curation mutations: a replica-collection upsert
  // (the live query re-renders, and with durable storage the optimism even
  // survives an offline reload alongside its queued outbox entry). Server truth
  // reconciles via the same collections.
  const liveSessionRowsRef = useRef<SessionMeta[]>([])
  liveSessionRowsRef.current = liveSessionRows
  const patchSession = useMemo(
    () => (sessionId: string, patch: Partial<SessionMeta>) => {
      const row = liveSessionRowsRef.current.find((s) => s.sessionId === sessionId)
      if (row) replica.applyChanges('sessions', [{ ...row, ...patch }], [])
    },
    [replica],
  )
  // Same optimistic-apply seam for a single issue (issue #124: markIssueRead).
  const liveIssueRowsRef = useRef<IssueWire[]>([])
  liveIssueRowsRef.current = liveIssueRows
  const patchIssue = useMemo(
    () => (id: string, patch: Partial<IssueWire>) => {
      const row = liveIssueRowsRef.current.find((i) => i.id === id)
      if (row) replica.applyChanges('issues', [{ ...row, ...patch }], [])
    },
    [replica],
  )
  const [hostMetrics, setHostMetrics] = useState<HostMetricsWire[]>([])
  const [machines, setMachines] = useState<MachineWire[]>([])
  const [pins, setPins] = useState<PinState>(EMPTY_PINS)
  const [tabOrders, setTabOrders] = useState<Record<string, string[]>>({})
  // URL router (issue #15 Phase 4): the main surface is the URL. A plain '/'
  // start restores the persisted view (same reload behavior the view string
  // had); unknown URLs fall back to home.
  // biome-ignore lint/correctness/useExhaustiveDependencies: routerWindow is fixed for the provider's lifetime
  const router = useMemo(
    () => createRouter({ fallbackView: readStoredView(ui), win: routerWindow }),
    [ui],
  )
  const [route, setRouteState] = useState<RouteState>(() => router.current())
  useEffect(() => {
    const off = router.subscribe(setRouteState)
    router.attach()
    setRouteState(router.current())
    return () => {
      off()
      router.dispose()
    }
  }, [router])
  const view = route.view
  const setView = useMemo(
    () => (v: MainView) => {
      const cur = router.current()
      if (cur.view === v) return
      // Switching surface closes per-surface overlays (issue page, settings
      // deep-link, search) but keeps the workspace pane context.
      router.navigate({ ...routeDefaults(v), worktree: cur.worktree, pane: cur.pane })
    },
    [router],
  )
  const settingsTab = route.settingsTab
  // Tab changes are real history entries (/settings/:tab): back/forward moves
  // between the tabs you visited, and a deep link lands directly on its tab.
  const setSettingsTab = useMemo(
    () => (tab: string | null) => {
      const cur = router.current()
      if (cur.view === 'settings') {
        if (cur.settingsTab !== tab) router.navigate({ ...cur, settingsTab: tab })
      } else if (tab !== null) {
        router.navigate({
          ...cur,
          view: 'settings',
          settingsTab: tab,
          issueId: null,
          searchOpen: false,
        })
      }
    },
    [router],
  )
  const searchOpen = route.searchOpen
  const setSearchOpen = useMemo(
    () => (open: boolean) => {
      const cur = router.current()
      if (cur.searchOpen === open) return
      router.navigate({ ...cur, searchOpen: open })
    },
    [router],
  )
  const [autoContinuePromptSessionId, setAutoContinuePromptSessionId] = useState<string | null>(
    null,
  )
  const [superThreadId, setSuperThreadId] = useState('global')
  const [superOpen, setSuperOpen] = useState(() => ui.get(SUPER_OPEN_KEY) === '1')
  const [dockTab, setDockTabState] = useState<DockTab>(() =>
    readStoredDockTab(ui.get(DOCK_TAB_KEY)),
  )
  const setDockTab = useMemo(
    () => (tab: DockTab) => {
      setDockTabState(tab)
      ui.set(DOCK_TAB_KEY, tab)
    },
    [ui],
  )
  const [superRefreshKey, setSuperRefreshKey] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sidebarSettings, setSidebarSettingsState] = useState<SidebarSettings>({
    repoSort: 'lastUsed',
    repoOrder: [],
    groupByRepo: false,
  })
  const openIssueId = route.issueId
  const setOpenIssueId = useMemo(
    () => (id: string | null) => {
      const cur = router.current()
      if (cur.view === 'issues' && cur.issueId === id) return
      router.navigate({ ...cur, view: 'issues', issueId: id, searchOpen: false })
    },
    [router],
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Workspace pane state: a deep-linked ?wt= wins over the persisted selection.
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(
    () => router.current().worktree ?? ui.get(WT_KEY),
  )
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(() => ui.get(ISSUE_SEL_KEY))
  const [paneA, setPaneA] = useState<string | null>(
    () => router.current().pane ?? ui.get(PANE_A_KEY),
  )
  const [paneB, setPaneB] = useState<string | null>(() => ui.get(PANE_B_KEY))
  const [split, setSplit] = useState(() => ui.get(SPLIT_KEY) === '1')
  // Which pane has input focus. Not persisted — it resets to A on reload, which is
  // the right default (A is always the shown pane when split is off).
  const [focusedPane, setFocusedPane] = useState<'A' | 'B'>('A')
  // Selecting a pane also focuses it — clicking/opening a pane is a reasonable
  // proxy for input focus, and the terminal components don't expose a focus seam.
  const setPane = useMemo(
    () => (pane: 'A' | 'B', id: string | null) => {
      if (pane === 'A') setPaneA(id)
      else setPaneB(id)
      setFocusedPane(pane)
    },
    [],
  )
  const toggleSplit = useMemo(() => () => setSplit((s) => !s), [])
  const [panelMode, setPanelMode] = useState<Record<string, 'chat' | 'native'>>(() =>
    readStoredPanelModes(ui),
  )
  // Effective rendered mode per session (what AgentPanel actually shows), reported up
  // the viewState channel. Not persisted — it's re-reported on mount from live state.
  const [panelRenderModes, setPanelRenderModes] = useState<Record<string, 'chat' | 'native'>>({})
  const [fileTabs, setFileTabs] = useState<FileTab[]>([])
  const started = useRef(false)
  // Latest reportViewState closure, so the once-mounted visibilitychange listener
  // always sees current pane/focus state without re-subscribing on every change.
  const reportViewStateRef = useRef<() => void>(() => {})

  const refreshRepos = useMemo(
    () => async () => {
      setReposLoading(true)
      try {
        const r = await trpc.discovery.refreshRepos.mutate()
        setRepos(r.repositories)
        setRepoDiagnostics(r.diagnostics)
      } finally {
        setReposLoading(false)
        setReposLoaded(true)
      }
    },
    [trpc],
  )
  const refreshPins = useMemo(
    () => async () => {
      setPins(await trpc.pins.list.query())
    },
    [trpc],
  )
  const setPinned = useMemo(
    () => async (kind: PinKind, id: string, pinned: boolean) => {
      setPins(await trpc.pins.set.mutate({ kind, id, pinned }))
    },
    [trpc],
  )
  const openFile = useMemo(
    () => (sessionId: string, path: string) => {
      const scope: FileScope = { kind: 'session', sessionId }
      const id = tabIdFor(scope, path)
      const worktreePath = sessions.find((s) => s.sessionId === sessionId)?.cwd ?? ''
      setFileTabs((tabs) =>
        tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, scope, path, worktreePath }],
      )
      setPaneA(id)
    },
    [sessions],
  )
  const openFileInWorktree = useMemo(
    () => (args: { machineId?: string; root: string; path: string }) => {
      const scope: FileScope = { kind: 'worktree', machineId: args.machineId, root: args.root }
      const id = tabIdFor(scope, args.path)
      setFileTabs((tabs) =>
        tabs.some((t) => t.id === id)
          ? tabs
          : [...tabs, { id, scope, path: args.path, worktreePath: args.root }],
      )
      setPaneA(id)
    },
    [],
  )
  const closeFileTab = useMemo(
    () => (id: string) => {
      setFileTabs((tabs) => tabs.filter((t) => t.id !== id))
      setPaneA((p) => (p === id ? null : p))
      setPaneB((p) => (p === id ? null : p))
    },
    [],
  )
  const readFileScoped = useMemo<Store<TApi>['readFileScoped']>(
    () =>
      ((scope: FileScope, path: string) =>
        scope.kind === 'session'
          ? trpc.files.read.query({ sessionId: scope.sessionId, path })
          : trpc.files.read.query({
              machineId: scope.machineId,
              root: scope.root,
              path,
            })) as Store<TApi>['readFileScoped'],
    [trpc],
  )
  const writeFileScoped = useMemo<Store<TApi>['writeFileScoped']>(
    () =>
      ((args: { scope: FileScope; path: string; content: string; baseHash?: string }) =>
        args.scope.kind === 'session'
          ? trpc.files.write.mutate({
              sessionId: args.scope.sessionId,
              path: args.path,
              content: args.content,
              baseHash: args.baseHash,
            })
          : trpc.files.write.mutate({
              machineId: args.scope.machineId,
              root: args.scope.root,
              path: args.path,
              content: args.content,
              baseHash: args.baseHash,
            })) as Store<TApi>['writeFileScoped'],
    [trpc],
  )
  const listDir = useMemo<Store<TApi>['listDir']>(
    () =>
      ((args: { machineId?: string; root: string; path?: string }) =>
        trpc.files.list.query(args)) as Store<TApi>['listDir'],
    [trpc],
  )
  const refreshTabOrders = useMemo(
    () => async () => {
      setTabOrders(await trpc.tabs.listOrders.query())
    },
    [trpc],
  )
  // Optimistic: dnd-kit hands back the new order on drop, and waiting on the
  // round-trip would make the tab snap back for a frame. Server result reconciles.
  const setTabOrder = useMemo(
    () => async (worktree: string, sessionIds: string[]) => {
      setTabOrders((orders) => ({ ...orders, [worktree]: sessionIds }))
      setTabOrders(await trpc.tabs.setOrder.mutate({ worktree, sessionIds }))
    },
    [trpc],
  )
  const killSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.kill.mutate({ sessionId }).catch(() => {})
      setFileTabs((tabs) =>
        tabs.filter((t) => !(t.scope.kind === 'session' && t.scope.sessionId === sessionId)),
      )
      setPaneA((p) => (p === sessionId ? null : p))
      setPaneB((p) => (p === sessionId ? null : p))
      setPins((p) => ({ ...p, panels: p.panels.filter((id) => id !== sessionId) }))
      setTabOrders((orders) =>
        Object.fromEntries(
          Object.entries(orders).map(([wt, ids]) => [wt, ids.filter((id) => id !== sessionId)]),
        ),
      )
    },
    [trpc],
  )
  const continueSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId }).catch(() => {})
      // After the manual nudge, offer to make it automatic — once, and only when
      // it isn't already on / hasn't already been answered.
      try {
        const settings = await trpc.settings.get.query()
        if (shouldPromptAutoContinue(settings)) setAutoContinuePromptSessionId(sessionId)
      } catch {
        // Non-fatal: the nudge already happened; just skip the offer.
      }
    },
    [trpc],
  )
  const closeAutoContinuePrompt = useMemo(() => () => setAutoContinuePromptSessionId(null), [])
  const hibernateSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.hibernate.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const resurrectSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.resurrect.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const resumeAndSend = useMemo(
    () => async (sessionId: string, text: string) => {
      // Outboxed: the wake+deliver is durably queued server-side once it lands,
      // and the outbox carries it there across offline gaps/reloads.
      outbox.enqueue('resumeAndSend', { sessionId, text })
    },
    [outbox],
  )
  // Curation mutations are optimistic: the server broadcast reconciles, but
  // waiting on it makes renames/drags feel sticky. The round-trip itself goes
  // through the outbox, so these survive being authored offline.
  const renameSession = useMemo(
    () => async (sessionId: string, name: string) => {
      patchSession(sessionId, { name: name.trim() })
      outbox.enqueue('rename', { sessionId, name })
    },
    [outbox, patchSession],
  )
  const archiveSession = useMemo(
    () => async (sessionId: string, archived: boolean) => {
      // Archiving "files the work away": it also lands the session in the board's
      // Done lane. Unarchiving only restores it — it doesn't reopen the work state.
      patchSession(sessionId, archived ? { archived, workState: 'done' } : { archived })
      // Filing the work away also drops it from pinned panels — a pinned tab for an
      // archived session is dead weight, exactly as closing/killing it removes the
      // pin (mirrors killSession's local pin filter). Unlike kill, archiving doesn't
      // delete the row server-side, so the panel pin would otherwise survive in the
      // DB and resurrect on reload — clear it on the server too to make it stick.
      if (archived) {
        setPins((p) => ({ ...p, panels: p.panels.filter((id) => id !== sessionId) }))
        // Pins stay direct (not outboxed) — low offline value, follow-on phase.
        await trpc.pins.set.mutate({ kind: 'panel', id: sessionId, pinned: false }).catch(() => {})
      }
      outbox.enqueue('setArchived', { sessionId, archived })
      if (archived) outbox.enqueue('setWorkState', { sessionId, workState: 'done' })
    },
    [outbox, patchSession, trpc],
  )
  const startBtw = useMemo(
    () => async (sessionId: string) => {
      // Open the superagent dock on the session's btw thread immediately; the
      // server seeds it (and runs the orientation turn) in the background.
      setSuperThreadId(`btw_${sessionId}`)
      setSuperOpen(true)
      await trpc.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      // Seeding + the orientation turn are done now — nudge the view to refetch.
      setSuperRefreshKey((k) => k + 1)
    },
    [trpc],
  )
  const tldrSession = useMemo(
    () => async (sessionId: string, answerText: string) => {
      const threadId = `btw_${sessionId}`
      setSuperThreadId(threadId)
      setSuperOpen(true)
      // Ensure the thread is seeded with this session's context before we ask.
      await trpc.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      const prompt = answerText.trim()
        ? `Give me a concise tl;dr (2–4 bullet points) of the agent's last answer below.\n\n---\n${answerText.trim().slice(0, 4000)}`
        : "Give me a concise tl;dr (2–4 bullet points) of the agent's last answer."
      await trpc.superagent.sendTurn.mutate({ threadId, text: prompt }).catch(() => {})
      setSuperRefreshKey((k) => k + 1)
    },
    [trpc],
  )
  const setSessionDraft = useMemo(
    () => (sessionId: string, text: string) => {
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text }))
      hub.sendSessionDraft(sessionId, text)
    },
    [hub],
  )
  const setSidebarSettings = useMemo(
    () => async (next: Partial<SidebarSettings>) => {
      // Optimistic update so the UI reorders instantly.
      setSidebarSettingsState((s) => ({ ...s, ...next }))
      // Persist by loading the full settings blob, patching sidebar, and saving.
      try {
        const current = await trpc.settings.get.query()
        const updated = await trpc.settings.set.mutate({
          ...current,
          sidebar: { ...current.sidebar, ...next },
        })
        setSidebarSettingsState(updated.sidebar)
      } catch {
        // best-effort — the optimistic state already applied
      }
    },
    [trpc],
  )
  const setPanelModeCb = useMemo(
    () => (sessionId: string, mode: 'chat' | 'native') => {
      setPanelMode((m) => (m[sessionId] === mode ? m : { ...m, [sessionId]: mode }))
    },
    [],
  )
  const setPanelRenderModeCb = useMemo(
    () => (sessionId: string, mode: 'chat' | 'native') => {
      setPanelRenderModes((m) => (m[sessionId] === mode ? m : { ...m, [sessionId]: mode }))
    },
    [],
  )
  const setWorkState = useMemo(
    () => async (sessionId: string, workState: WorkState | null) => {
      patchSession(sessionId, { workState: workState ?? undefined })
      outbox.enqueue('setWorkState', { sessionId, workState })
    },
    [outbox, patchSession],
  )
  const setSnooze = useMemo(
    () => async (sessionId: string, until: string | null) => {
      patchSession(sessionId, { snoozedUntil: until })
      outbox.enqueue('snoozeSet', { sessionId, until })
    },
    [outbox, patchSession],
  )
  const clearSnooze = useMemo(
    () => async (sessionId: string) => {
      patchSession(sessionId, { snoozedUntil: undefined })
      outbox.enqueue('snoozeClear', { sessionId })
    },
    [outbox, patchSession],
  )
  const spawnDraftAgent = useMemo(
    () =>
      (args: {
        target: SpawnTarget
        agentKind: AgentKind
        firstPrompt?: string
      }): { sessionId: string; issueId: string } => {
        // Client-minted ids (server reuses them verbatim) so the optimistic rows
        // reconcile by id when the broadcast lands — no temp-id swap, no flicker.
        const sessionId = crypto.randomUUID()
        const issueId = `iss_${crypto.randomUUID()}`
        const nowIso = new Date().toISOString()
        setOptimisticSessions((all) => [
          ...all,
          optimisticStartingSession({
            sessionId,
            issueId,
            agentKind: args.agentKind,
            cwd: args.target.path,
            nowIso,
          }),
        ])
        setOptimisticIssues((all) => [
          ...all,
          optimisticDraftIssue({
            issueId,
            repoPath: args.target.repoPath,
            agentKind: args.agentKind,
            nowIso,
          }),
        ])
        // Fire the create in the background; roll the optimistic rows back if it
        // never reaches the server (the real broadcast otherwise supersedes them).
        void createDraftAgent({
          trpc,
          sessionId,
          issueId,
          target: args.target,
          agentKind: args.agentKind,
          firstPrompt: args.firstPrompt,
        }).catch((err) => {
          setOptimisticSessions((all) => all.filter((s) => s.sessionId !== sessionId))
          setOptimisticIssues((all) => all.filter((i) => i.id !== issueId))
          notices.error(
            `Couldn't start the agent — ${err instanceof Error ? err.message : 'unknown error'}`,
          )
        })
        return { sessionId, issueId }
      },
    [trpc, notices],
  )
  // Mark a session / issue read (issue #124): optimistically stamp readAt = now and
  // clear unread, then durably round-trip via the outbox. Server truth reconciles.
  const markSessionRead = useMemo(
    () => async (sessionId: string) => {
      patchSession(sessionId, { readAt: new Date().toISOString(), unread: false })
      outbox.enqueue('sessionMarkRead', { sessionId })
    },
    [outbox, patchSession],
  )
  // The email-style inverse (#138): stamp readAt = null so `unread` re-arms.
  const markSessionUnread = useMemo(
    () => async (sessionId: string) => {
      patchSession(sessionId, { readAt: null, unread: true })
      outbox.enqueue('sessionMarkUnread', { sessionId })
    },
    [outbox, patchSession],
  )
  const markIssueRead = useMemo(
    () => async (id: string) => {
      patchIssue(id, { readAt: new Date().toISOString(), unread: false })
      outbox.enqueue('issueMarkRead', { id })
    },
    [outbox, patchIssue],
  )
  const markIssueUnread = useMemo(
    () => async (id: string) => {
      patchIssue(id, { readAt: null, unread: true })
      outbox.enqueue('issueMarkUnread', { id })
    },
    [outbox, patchIssue],
  )

  // Mark the session the operator is actually LOOKING AT read on view (#138). The
  // explicit switch handlers only fire on a pane *change*, so a session that's
  // already the open/focused pane (the coordinator session the user keeps coming
  // back to) never re-marked read and stayed bold. The hook debounces on the
  // focused session's activity so a streaming session settles first.
  const focusedPaneSessionId = split ? (focusedPane === 'A' ? paneA : paneB) : paneA
  const focusedSession = focusedPaneSessionId
    ? sessions.find((s) => s.sessionId === focusedPaneSessionId)
    : undefined
  useMarkReadOnView({ session: focusedSession, markSessionRead })

  // Report which sessions this client renders (`visible`) and which one has input
  // focus (`focused`) so the server can prioritize PTY relay for them. While the tab
  // is hidden we report nothing — a backgrounded client isn't watching anything.
  // `focusedPane` is clamped to A when split is off (B isn't shown).
  const reportViewState = useMemo(
    () => () => {
      const tabVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
      const effectivePane: 'A' | 'B' = split ? focusedPane : 'A'
      const visible = tabVisible
        ? [paneA, split ? paneB : null].filter((x): x is string => x != null)
        : []
      const focused = tabVisible ? (effectivePane === 'A' ? paneA : paneB) : null
      // Rendered mode (native/chat) for each visible session — default 'native' until
      // its AgentPanel reports its effective mode. Wired through to the server; does
      // not affect output scheduling.
      const modes: Record<string, 'native' | 'chat'> = {}
      for (const sid of visible) modes[sid] = panelRenderModes[sid] ?? 'native'
      hub.setViewState(visible, focused, modes)
    },
    [hub, paneA, paneB, split, focusedPane, panelRenderModes],
  )
  // Re-derive + send on every change to the inputs, and keep the ref current so the
  // visibilitychange listener (registered once at mount) calls the latest closure.
  useEffect(() => {
    reportViewStateRef.current = reportViewState
    reportViewState()
  }, [reportViewState])

  // What the user is LOOKING AT, snapshotted for each superagent turn (#225): the
  // screen, the selected issue/worktree, the session(s) on screen. Ids only — the
  // server resolves them to titles/names. Read through a ref so consumers get a
  // stable `getUserFocus` and never re-render on pane/session churn.
  const userFocusRef = useRef<UserFocus>({})
  {
    const paneIds = [paneA, split ? paneB : null].filter((x): x is string => x != null)
    const focusedId = split ? (focusedPane === 'A' ? paneA : paneB) : paneA
    const isSession = (id: string) => sessions.some((s) => s.sessionId === id)
    const focusedFile = focusedId ? fileTabs.find((f) => f.id === focusedId) : undefined
    userFocusRef.current = {
      view,
      ...(selectedWorktree ? { worktreePath: selectedWorktree } : {}),
      ...(selectedIssueId ? { issueId: selectedIssueId } : {}),
      ...(focusedId && isSession(focusedId) ? { focusedSessionId: focusedId } : {}),
      visibleSessionIds: paneIds.filter(isSession),
      ...(focusedFile ? { filePath: focusedFile.path } : {}),
    }
  }
  const getUserFocus = useMemo(() => () => userFocusRef.current, [])

  useEffect(() => {
    // Wait for the first repo load — otherwise a persisted (restored) selection
    // would be wiped against the still-empty repo list before discovery resolves.
    if (!reposLoaded) return
    if (!selectedWorktree) {
      const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
      setSelectedWorktree(worktrees[0]?.path ?? null)
      return
    }
    const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
    // Keep an explicit selection alive when it's a registered worktree OR when a
    // session is actually running there — a superagent-/CLI-spawned session can
    // sit in a path the web's repo list doesn't know yet, and reverting it to
    // worktrees[0] made "Open" on that session show an unrelated one.
    const known = worktrees.some((w) => w.path === selectedWorktree)
    // Containment, not equality: a session stamped with a subdirectory of the
    // selected path still anchors the selection.
    const hasSession = sessions.some(
      (s) => s.cwd === selectedWorktree || s.cwd.startsWith(`${selectedWorktree}/`),
    )
    if (known || hasSession) return
    setSelectedWorktree(worktrees[0]?.path ?? null)
  }, [repos, reposLoaded, selectedWorktree, sessions])

  // Session-follows-view policy: when a session the user is LOOKING AT (in a
  // visible pane) moves out of the selected worktree, switch the whole view to
  // where it went — otherwise it silently disappears from the tab strip mid-
  // conversation. A background session's move never yanks the view; it gets a
  // toast so the user knows where it now lives in the sidebar.
  const prevCwdsRef = useRef<Record<string, string>>({})
  useEffect(() => {
    const prevCwds = prevCwdsRef.current
    prevCwdsRef.current = Object.fromEntries(sessions.map((s) => [s.sessionId, s.cwd]))
    const tabVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
    const plan = planWorktreeMoves({
      prevCwds,
      sessions,
      worktreePaths: reposToViews(repos).flatMap((r) => r.worktrees.map((w) => w.path)),
      selectedWorktree,
      visiblePanes: tabVisible ? [paneA, split ? paneB : null].filter((x) => x != null) : [],
    })
    if (plan.follow) setSelectedWorktree(plan.follow)
    for (const move of plan.moved) {
      const s = sessions.find((x) => x.sessionId === move.sessionId)
      const dest = move.to ?? s?.cwd
      notices.info(
        `${s?.name || s?.title || 'A session'} moved to ${dest?.split('/').pop() ?? '?'}`,
        dest,
      )
    }
    // Moves are diffs between consecutive `sessions` snapshots; the other inputs
    // only parameterize how a detected move is handled, and re-running on their
    // changes is a no-op (prev === current cwd for every session).
  }, [sessions, repos, selectedWorktree, paneA, paneB, split, notices])

  // URL ⇄ workspace pane state. While the workspace is the surface, mirror the
  // selection into the query (replace — no history spam) so the URL stays
  // shareable; on a route change carrying pane state (deep link, back/forward),
  // apply it to the selection.
  //
  // The URL→state direction must only adopt a wt/pane VALUE THAT CHANGED in the
  // URL (deep link, back/forward), and only a worktree that can actually be
  // shown. Adopting an unknown ?wt= would fight the fallback effect above (it
  // re-resolves the selection to a real worktree, the mirror below rewrites the
  // URL from state one commit behind) and the two writers ping-pong the URL
  // between the unknown and the fallback path forever — an unbounded update
  // loop (React #185, seen as the "Podium crashed" screen). An unknown wt now
  // settles deterministically: the URL is normalized to the fallback once.
  // Panes are adopted as-is — an unknown pane has no fallback↔adopt pair
  // (Workspace holds or clears it) so it cannot oscillate.
  const prevRouteRef = useRef<RouteState | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only route changes should trigger the URL→state direction; the other values are read fresh but must not re-trigger it
  useEffect(() => {
    const prev = prevRouteRef.current
    prevRouteRef.current = route
    if (
      route.worktree &&
      route.worktree !== prev?.worktree &&
      route.worktree !== selectedWorktree
    ) {
      const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
      const canShow =
        !reposLoaded ||
        worktrees.some((w) => w.path === route.worktree) ||
        sessions.some((s) => s.cwd === route.worktree || s.cwd.startsWith(`${route.worktree}/`))
      if (canShow) setSelectedWorktree(route.worktree)
    }
    if (route.pane && route.pane !== prev?.pane && route.pane !== paneA) setPaneA(route.pane)
  }, [route])
  useEffect(() => {
    if (route.view !== 'workspace') return
    if (route.worktree === selectedWorktree && route.pane === paneA) return
    router.replace({ ...route, worktree: selectedWorktree, pane: paneA })
  }, [route, router, selectedWorktree, paneA])

  // Persist the "where am I" state for next load.
  useEffect(() => ui.set(VIEW_KEY, view), [ui, view])
  useEffect(() => ui.set(WT_KEY, selectedWorktree), [ui, selectedWorktree])
  useEffect(() => ui.set(ISSUE_SEL_KEY, selectedIssueId), [ui, selectedIssueId])
  useEffect(() => ui.set(PANE_A_KEY, paneA), [ui, paneA])
  useEffect(() => ui.set(PANE_B_KEY, paneB), [ui, paneB])
  useEffect(() => ui.set(SPLIT_KEY, split ? '1' : '0'), [ui, split])
  useEffect(() => ui.set(SUPER_OPEN_KEY, superOpen ? '1' : '0'), [ui, superOpen])
  useEffect(() => ui.set(PANEL_MODE_KEY, JSON.stringify(panelMode)), [ui, panelMode])

  useEffect(() => {
    // The hub's single entity write seam is onMetadataApplied → replica; the
    // live queries render from there. Only ephemeral state (host metrics,
    // machines, drafts) still mirrors hub events into useState.
    const offHostMetrics = hub.onHostMetrics(setHostMetrics)
    // Repos are only scannable through a connected daemon, so a machine coming online
    // (e.g. the split daemon reconnecting after a restart) can make previously-empty
    // repos available. Refetch when the online count climbs, so the workspace isn't
    // stuck on the "add a repo" empty state until a manual reload.
    let onlineMachines = 0
    const offMachines = hub.onMachines((m) => {
      setMachines(m)
      const online = m.reduce((n, x) => n + (x.online ? 1 : 0), 0)
      if (online > onlineMachines) void refreshRepos()
      onlineMachines = online
    })
    const offDraft = hub.onSessionDraft((sessionId, text) =>
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text })),
    )
    // Reconnect drains the outbox: the browser 'online' event (the outbox's own
    // trigger) misses a server restart behind a healthy network, but the hub's
    // heartbeat-derived health catches both.
    let prevHealth = hub.connectionHealth().status
    const offHealth = hub.onConnectionHealth((h) => {
      if (h.status === 'ok' && prevHealth !== 'ok') outbox.notifyConnected()
      prevHealth = h.status
    })
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    const offAttention = hub.onAttention((e) => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      try {
        new Notification(e.title, { body: e.body, tag: e.sessionId })
      } catch {
        // some webviews throw on construction — never break the app over a toast
      }
    })
    // Presence feeds the server's smart router (skip mobile push while visible).
    // Re-report view-state too so hiding the tab clears it (and showing re-asserts).
    const reportVisibility = () => {
      hub.setVisible(typeof document === 'undefined' || document.visibilityState === 'visible')
      reportViewStateRef.current()
    }
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', reportVisibility)
    reportVisibility()
    // Hydrate-first paint (docs/spec/thin-client-replica.md §2.2): seed the hub's
    // entity lists from the persisted replica so the subscriptions above deliver
    // last-known data before (or without) the network answering — an offline
    // reload paints a full UI instead of a blank shell. The hydrate microtask
    // resolves before the deferred connect below, and `seedMetadata` refuses to
    // clobber server truth if a heal somehow lands first. `hydrate` never throws
    // (a poisoned replica clears itself and cold-starts).
    void replica.hydrate().then((snap) => {
      if (snap.sessions.length + snap.issues.length + snap.conversations.length > 0) {
        hub.seedMetadata(snap)
      }
    })
    const connectTimer = setTimeout(() => {
      try {
        hub.connect()
      } catch (e) {
        onFatalError(formatError(e, 'WebSocket connection failed'))
      }
    }, 0)
    if (!started.current) {
      started.current = true
      // Sidebar prefs load out of band so boot fans out only repos + pins + tab
      // orders (never gated on settings or a conversation scan).
      void trpc.settings.get
        .query()
        .then((s) => setSidebarSettingsState(s.sidebar))
        .catch(() => {})
      void Promise.all([refreshRepos(), refreshPins(), refreshTabOrders()]).catch((e) => {
        onFatalError(formatError(e, 'Could not load Podium data'))
      })
    }
    return () => {
      clearTimeout(connectTimer)
      offHostMetrics()
      offMachines()
      offDraft()
      offHealth()
      offAttention()
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', reportVisibility)
      hub.dispose()
    }
  }, [
    hub,
    onFatalError,
    formatError,
    outbox,
    refreshPins,
    refreshRepos,
    refreshTabOrders,
    replica,
    trpc,
  ])

  const value: Store<TApi> = {
    hub,
    trpc,
    replica,
    repos,
    reposLoading,
    reposLoaded,
    repoDiagnostics,
    sessions,
    issues,
    conversations,
    pendingSpawnIds,
    hostMetrics,
    machines,
    pins,
    setPinned,
    tabOrders,
    setTabOrder,
    view,
    setView,
    settingsTab,
    setSettingsTab,
    superThreadId,
    setSuperThreadId,
    superOpen,
    setSuperOpen,
    dockTab,
    setDockTab,
    superRefreshKey,
    startBtw,
    tldrSession,
    openIssueId,
    setOpenIssueId,
    paletteOpen,
    setPaletteOpen,
    searchOpen,
    setSearchOpen,
    selectedWorktree,
    setSelectedWorktree,
    selectedIssueId,
    setSelectedIssueId,
    paneA,
    paneB,
    setPane,
    focusedPane,
    setFocusedPane,
    panelMode,
    setPanelMode: setPanelModeCb,
    setPanelRenderMode: setPanelRenderModeCb,
    split,
    toggleSplit,
    refreshRepos,
    spawnDraftAgent,
    killSession,
    continueSession,
    autoContinuePromptSessionId,
    closeAutoContinuePrompt,
    hibernateSession,
    resurrectSession,
    resumeAndSend,
    renameSession,
    archiveSession,
    setWorkState,
    setSnooze,
    clearSnooze,
    markSessionRead,
    markSessionUnread,
    markIssueRead,
    markIssueUnread,
    drafts,
    setSessionDraft,
    sidebarSettings,
    setSidebarSettings,
    uiState: ui,
    httpOrigin: config.httpOrigin,
    outboxSize,
    fileTabs,
    openFile,
    openFileInWorktree,
    closeFileTab,
    readFileScoped,
    writeFileScoped,
    listDir,
    getUserFocus,
  }
  // Publish into the subscription store (created once; identity is the context
  // value). publish() shallow-compares, so a provider re-render where nothing
  // observable changed notifies nobody — and keeps the old snapshot identity.
  const extStoreRef = useRef<SubscriptionStore<Store<TApi>> | null>(null)
  if (extStoreRef.current === null) extStoreRef.current = createSubscriptionStore(value)
  const extStore = extStoreRef.current
  useLayoutEffect(() => {
    extStore.publish(value)
  })
  return (
    <Ctx.Provider value={extStore as unknown as SubscriptionStore<Store<PodiumClientApi>>}>
      {children}
    </Ctx.Provider>
  )
}

function useStoreHandle<TApi extends PodiumClientApi>(): SubscriptionStore<Store<TApi>> {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s as unknown as SubscriptionStore<Store<TApi>>
}

/** Compatibility hook: the WHOLE store snapshot. Re-renders whenever any store
 *  field changes — prefer `useStoreSelector` for hot components. */
export function useStore<TApi extends PodiumClientApi = PodiumClientApi>(): Store<TApi> {
  const handle = useStoreHandle<TApi>()
  return useSyncExternalStore(handle.subscribe, handle.getSnapshot)
}

/**
 * Slice subscription: re-renders only when `selector(store)` changes (per
 * `isEqual`, Object.is by default). Selectors may allocate (e.g. pick several
 * fields into an object) as long as `isEqual` is passed accordingly — the hook
 * caches the last selected value per snapshot so getSnapshot stays stable.
 */
export function useStoreSelector<T, TApi extends PodiumClientApi = PodiumClientApi>(
  selector: (s: Store<TApi>) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const handle = useStoreHandle<TApi>()
  const cache = useRef<{ snap: Store<TApi>; selected: T } | null>(null)
  // A new selector closure (inline arrows capture fresh props each render)
  // must invalidate the cache — but only across renders, never mid-render.
  const selectorRef = useRef(selector)
  if (selectorRef.current !== selector) {
    selectorRef.current = selector
    cache.current = null
  }
  const isEqualRef = useRef(isEqual)
  isEqualRef.current = isEqual
  const getSelected = () => {
    const snap = handle.getSnapshot()
    const c = cache.current
    if (c && c.snap === snap) return c.selected
    const next = selectorRef.current(snap)
    // Keep the previous selected identity when equal, so useSyncExternalStore's
    // Object.is check sees "unchanged" and skips the re-render.
    const selected = c && isEqualRef.current(c.selected, next) ? c.selected : next
    cache.current = { snap, selected }
    return selected
  }
  return useSyncExternalStore(handle.subscribe, getSelected)
}
