import type { NavigationIntent } from '../ui/navigation'
/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and runtime access seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

import type { ArtifactId, IssueId, MachineId, SessionId, ThreadId } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { ReadPositionPort } from '../read-position'
import type { MainView, RoutedUiState } from '../ui-state'
import type {
  DockTab,
  FileTab,
  PaneId,
  RecentFileEntry,
  SplitAxis,
  TabId,
  WorkspaceKey,
  WorkspaceMap,
} from '../values'

/** The two endpoints the shared store needs to reach a Podium server. */
export interface StoreServerConfig {
  httpOrigin: string
  wsClientUrl: string
}

/** Existing platform surface name; notices are owned by the device service. */
export type StoreNotices = import('../notices').NoticeSink

export const NOOP_NOTICES: StoreNotices = { error: () => {}, info: () => {} }

/** The issue read cursor that existed when the current foreground visit began. */
export interface IssueVisitBaseline {
  issueId: IssueId
  readAt: string | null
  openedAt: string
}

/** One app-local request to reveal a stable item inside a session transcript. */
export interface TranscriptRevealRequest {
  nonce: number
  sessionId: SessionId
  itemKey: string
}

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
  /** NOT branded, and deliberately so: this interface MIRRORS the server's
   *  `UserFocus` zod schema field for field, and POD-362 branded that schema's
   *  two session ids but left `issueId` a plain `z.string().max(128)`. Branding
   *  only this side would make the mirror drift, which is worse than the widening
   *  — the pair must move together, server-side first. */
  issueId?: IssueId
  focusedSessionId?: SessionId
  visibleSessionIds?: SessionId[]
  filePath?: string
  /** Every file/artifact tab on screen (POD-782), not only the focused one. */
  openFilePaths?: string[]
  /** The issue detail drawer open over the workspace, when there is one. Not
   *  branded, for the same mirror-fidelity reason as `issueId` above. */
  openIssueId?: IssueId
}

/**
 * The engine snapshot the UI consumes (#262): data slices plus imperative
 * actions and handles. Local values are read and followed through keyed runtime
 * channels; replicated records belong to the pool.
 */
export interface Store<TApi extends PodiumClientApi = PodiumClientApi> {
  navigation: import('./state').NavigationProvider
  /** Main-area surface: attention board, worktree workspace, superagent, or settings. */
  view: MainView
  setView: (view: MainView) => void
  /** Deep-link target for the Settings view — a tab key (e.g. from global search).
   *  Consumed and cleared by SettingsView on mount. */
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
  /**
   * The superagent thread the dock renders. IN PRACTICE ALWAYS 'global' from the
   * web (POD-782 bound the pane to the one chat, and POD-1069 removed the last
   * writer that aimed it anywhere else) — `setSuperThreadId` survives for a
   * surface that can genuinely render a second thread, which none does today.
   */
  superThreadId: ThreadId | null
  setSuperThreadId: (id: string) => void
  /** Whether the superagent panel is open — a collapsible right dock on desktop,
   *  a minimizable overlay on mobile (no longer a full-screen view). */
  superOpen: boolean
  dockTab: DockTab
  setDockTab: (tab: DockTab) => void
  setSuperOpen: (open: boolean) => void
  /** The session attached to the NEXT superagent turn, or null. Spent by the
   *  send that carries it; the composer shows it so an attachment is never a
   *  silent one. Not persisted. */
  attachedSessionId: SessionId | null
  /** Drop the attachment without sending — the chip's ×. */
  clearAttachedSession: () => void
  /** The issue whose detail drawer is open (from the kanban card or the sidebar
   *  Issues tab), or null when closed. Ephemeral — not persisted. */
  openIssueId: IssueId | null
  setOpenIssueId: (id: IssueId | null) => void
  /** Whether the Cmd/Ctrl+K command palette is open. In the store (not palette-
   *  local) so other surfaces (toolbar button, shell shortcut) can open it. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  /** Issue-keyed workspace selection (unified sidebar only): the issue whose
   *  sessions the center tab strip shows. Null = today's worktree-keyed view.
   *  Classic sidebar never sets it; unified worktree rows clear it. */
  selectedIssueId: IssueId | null
  setSelectedIssueId: (id: IssueId | null) => void
  /** Captured before eager mark-read advances the issue's per-user cursor. */
  issueVisitBaseline: IssueVisitBaseline | null
  /** Consumed by the matching chat surface, then cleared by nonce. */
  /**
   * EDITOR-STYLE TAB WORKSPACES (POD-710): what each task in the left sidebar
   * has open — its tabs, its active tab, its ONE preview tab and its split
   * layout — restored exactly across task switches and reloads. Keyed by
   * `workspaceKeyForState`; the model and its reducers live in
   * `viewmodels/workspace-layout.ts`.
   *
   * This is the truth. `paneA` / `paneB` / `split` / `focusedPane` below are
   * derived mirrors kept in sync on every write, for the consumers that still
   * speak in panes (the `?pane=` route, PTY-relay priority, the warm set).
   */
  workspaces: WorkspaceMap
  /**
   * WHICH WORKSPACE IS ON SCREEN — the key `workspaces` should be read at.
   *
   * The one resolver, exposed so a view never spells it a second time. It walks
   * the engine's own issue collection (mission root wins over the selected
   * sub-issue), and a view that recomputed it from a DIFFERENT collection —
   * say, only the issues with a normalized projection — would disagree with the
   * engine for exactly as long as the two collections disagreed, and read a
   * workspace nobody writes: an empty strip over a panel rendering normally.
   */
  workspaceKey: () => WorkspaceKey
  /** Open a SESSION as a tab in the current workspace. `permanent: false` is the
   *  flight deck's single click: a preview tab, rendered italic, reused by the
   *  next single click. Defaults to a permanent tab — a caller that has not
   *  thought about it wants a tab that stays. */
  openSessionTab: (sessionId: SessionId, opts?: { permanent?: boolean; paneId?: PaneId }) => void
  /** Open/select one session tab and request a jump to a stable transcript item. */
  openSessionAtTranscript: (
    sessionId: SessionId,
    itemKey: string,
    opts?: { permanent?: boolean },
  ) => void
  /** The same, for any tab id (a session, or a `file:…` editor tab). */
  openTabInWorkspace: (tabId: TabId, opts?: { permanent?: boolean; paneId?: PaneId }) => void
  /** Preview → permanent, with no reorder (typing into the panel, or a
   *  double-click in the flight deck). */
  promoteWorkspaceTab: (tabId: TabId) => void
  activateWorkspaceTab: (tabId: TabId) => void
  /** Close a VIEW. Never touches the session — that lives in the flight deck. */
  closeWorkspaceTab: (tabId: TabId) => void
  moveWorkspaceTab: (tabId: TabId, toPaneId: PaneId, toIndex: number) => void
  /** `row` = Split Right, `column` = Split Down. */
  splitWorkspacePane: (paneId: PaneId, axis: SplitAxis, opts?: { tabId?: TabId }) => void
  closeWorkspacePane: (paneId: PaneId) => void
  focusWorkspacePane: (paneId: PaneId) => void
  /** Drag a pane divider. `path` routes from the layout root to the split node
   *  being resized (`[]` is the root); `sizes` is normalized to sum to 1, so a
   *  resizer may hand over fractions or pixels. Sizes live in the layout, which
   *  is already persisted per task — a split's proportions are part of how the
   *  operator arranged that task, not a separate screen preference. */
  resizeWorkspaceSplit: (path: readonly number[], sizes: readonly number[]) => void
  paneA: SessionId | null // sessionId in pane A
  paneB: SessionId | null // sessionId in pane B (null = no split)
  /** Pane-shaped adapter over the workspace actions, kept for the call sites
   *  that navigate by pane (command palette, issue pages, spawn rows). */
  setPane: (pane: 'A' | 'B', sessionId: SessionId | null) => void
  /** Which split pane currently holds input focus — drives the `focused` field of
   *  the view-state the client reports so the server prioritizes that session's PTY
   *  relay. Only meaningful when `split` is on; clamps to 'A' otherwise. */
  focusedPane: PaneId
  setFocusedPane: (pane: 'A' | 'B') => void
  /** One modeled per-session rendered mode. AgentPanel resolves defaults and capability, then records the effective value here; the same value persists and is reported to the server. */
  panelMode: Record<string, 'chat' | 'native'>
  setPanelMode: (sessionId: SessionId, mode: 'chat' | 'native') => void
  /** Where NAVIGATION would like this session to open. Writes the mode only when
   *  the operator has never picked one for this session, so a row that focuses a
   *  session "in CLI" cannot overwrite a standing Chat pick (POD-1702). */
  preferPanelMode: (sessionId: SessionId, mode: 'chat' | 'native') => void
  /** The right dock's shell per worktree (#23): worktreePath → the shell session
   *  living in the dock's Shell panel. Dock shells render THERE, not as workspace
   *  tabs — the tab strip filters every id in this map. Persisted so a reload
   *  reattaches the same shell [spec:SP-75b1]. */
  /** worktreePath -> the session its dock is pointed at. */
  dockShells: Record<string, SessionId>
  /** Point a worktree's dock at `sessionId` (null = forget the mapping). */
  setDockShell: (worktreePath: string, sessionId: SessionId | null) => void
  /** The dock shell currently RENDERED (mounted terminal), reported in the
   *  viewState `visible` set so the server accepts its resizes. Not persisted. */
  dockVisibleSession: string | null
  setDockVisibleSession: (sessionId: SessionId | null) => void
  fileTabs: FileTab[]
  /** Recently opened files across all workspaces (POD-149), newest first —
   *  feeds the "+" menu's Recent-files list so strict issue scoping never
   *  strands a file. Persisted. */
  recentFiles: RecentFileEntry[]
  openFile: (sessionId: SessionId, path: string) => void
  /** `issueId` names the owning issue explicitly (issue pages, legacy
   *  artifacts); omitted, the open is stamped to the selected issue (POD-149).
   *
   *  `permanent: false` is the file tree's single click (POD-788): the file
   *  lands as the workspace's ONE temporary tab, exactly as a session previewed
   *  from the flight deck does. Defaults to permanent — a caller that has not
   *  thought about it wants a tab that stays. */
  openFileInWorktree: (args: {
    machineId?: MachineId
    root: string
    path: string
    issueId?: IssueId
    permanent?: boolean
  }) => void
  /** Open a permanent artifact snapshot as a read-only file tab ([spec:SP-0fc9]
   *  #441). `path` is the relpath inside the artifact dir (bundle entry or the
   *  artifact's basename). */
  openArtifact: (args: {
    issueId: IssueId
    artifactId: ArtifactId
    path: string
    worktreePath?: string
  }) => void
  closeFileTab: (id: string) => void
  split: boolean
  /** Split the focused pane in two, or — when the layout is already split —
   *  collapse it back to one pane, merging every pane's tabs into the first.
   *  A derived-mirror-safe adapter over `splitWorkspacePane`/`closeWorkspacePane`;
   *  `split` itself is read-only state derived from the layout's leaf count. */
  toggleSplit: () => void
  /** Session whose first manual Continue should raise the auto-continue popup,
   *  or null when the popup is closed. */
  autoContinuePromptSessionId: SessionId | null
  closeAutoContinuePrompt: () => void
  /** [spec:SP-a1c0] Central navigate-to-session (#411): accepts a UUID or birth ref and is the ONLY way UI surfaces jump to a session. */
  navigateWorkspace: (intent: Omit<NavigationIntent, 'view'>) => boolean
  navigateToSession: (sessionIdOrRef: string) => void
  /**
   * Select an issue and land on the session a launch just started or added,
   * waiting for that session to reach this client (POD-1202). Callers adding to
   * an occupied issue can exclude its existing sessions. Resolves with the
   * session it opened, or `null` when none showed up in time or the operator
   * selected something else while it waited.
   */
  focusIssueSession: (
    issueId: IssueId,
    opts?: { timeoutMs?: number; excludeSessionIds?: readonly SessionId[] },
  ) => Promise<SessionId | null>
  /** Keyed access routes device preferences to UiStore and synced layout to the pool. */
  uiState: RoutedUiState
  /** This person's event-stream read positions (POD-1380). Its own port, not a
   * ui-state key: the position follows the user and merges monotonically. */
  readPosition: ReadPositionPort
  /** What the user is LOOKING AT right now (#225): the screen, selected issue/
   *  worktree, session(s) on screen. Ids only — the server resolves them to
   *  titles/names. Computed on call from live engine state, so this stays a
   *  stable function identity and never forces a re-render on pane/session churn. */
  getUserFocus: () => UserFocus
}

export type SpawnPlaceholderEvent =
  | {
      readonly type: 'painted'
      readonly overlays: readonly import('../command-reducers').PendingOverlay[]
      readonly sessionId: SessionId
      readonly prompt?: string
    }
  | { readonly type: 'removed'; readonly ids: readonly string[] }
