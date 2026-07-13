/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and store-snapshot seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

import type {
  AgentKind,
  ApprovalWire,
  ConversationSummaryWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HostMetricsWire,
  IssueWire,
  MachineWire,
  SessionMeta,
  WorkState,
} from '@podium/protocol'
import type { Sidebar as SidebarSettings } from '@podium/runtime'
import type { SocketHub } from '@podium/terminal-client'
import type { PodiumClientApi } from '../api'
import type { Replica, UiState } from '../replica/replica'
import type { MainView } from '../router'
import type { SpawnTarget } from '../spawn-agent'
import type { DockTab, FileScope, FileTab, PinKind, PinState } from '../viewmodels'

/** The two endpoints the shared store needs to reach a Podium server. */
export interface StoreServerConfig {
  httpOrigin: string
  wsClientUrl: string
}

/** UI-notice seam: web wires this to sonner toasts; mobile to its own surface. */
export interface StoreNotices {
  error(message: string): void
  info(message: string, description?: string): void
}

export const NOOP_NOTICES: StoreNotices = { error: () => {}, info: () => {} }

export function defaultFormatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

/** What this client has on screen, sent with every superagent turn (#225). Mirrors
 *  the server's `UserFocus` zod schema (apps/server/src/modules/superagent/global.ts). */
export interface UserFocus {
  view?: MainView
  worktreePath?: string
  issueId?: string
  focusedSessionId?: string
  visibleSessionIds?: string[]
  filePath?: string
}

/**
 * The engine snapshot the UI consumes (#262): data slices plus imperative
 * actions, published through the engine's subscribe/getSnapshot seam (designed
 * for React's useSyncExternalStore, but React-free). Field identities are
 * stable until the underlying slice actually changes.
 */
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
  /** Approval broker [spec:SP-edbb]: pending management-op requests. */
  approvals: ApprovalWire[]
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
  /** The right dock's shell per worktree (#23): worktreePath → the shell session
   *  living in the dock's Shell panel. Dock shells render THERE, not as workspace
   *  tabs — the tab strip filters every id in this map. Persisted so a reload
   *  reattaches the same shell [spec:SP-75b1]. */
  dockShells: Record<string, string>
  /** Point a worktree's dock at `sessionId` (null = forget the mapping). */
  setDockShell: (worktreePath: string, sessionId: string | null) => void
  /** The dock shell currently RENDERED (mounted terminal), reported in the
   *  viewState `visible` set so the server accepts its resizes. Not persisted. */
  dockVisibleSession: string | null
  setDockVisibleSession: (sessionId: string | null) => void
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
  /** [spec:SP-a1c0] Central navigate-to-session (#411): the ONLY way UI surfaces jump to a session. */
  navigateToSession: (sessionId: string) => void
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
   *  titles/names. Computed on call from live engine state, so this stays a
   *  stable function identity and never forces a re-render on pane/session churn. */
  getUserFocus: () => UserFocus
}
