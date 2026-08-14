/**
 * Store actions: the command/UI-state ownership boundary.
 *
 * A durable write is dispatched through a declared command path. Device-local
 * navigation, selection, focus and transient geometry never reach the Outbox.
 * The lists below are the shared routing record consumed by POD-403; a new
 * action must be classified here rather than silently inheriting today's
 * single-operator placement.
 */

import type {
  AgentKind,
  IssueId,
  IssueWire,
  LayoutSnapshot,
  SessionId,
  SessionMeta,
  ThreadId,
  WorkState,
} from '@podium/model'
import { asThreadId } from '@podium/model'
import { resolveSessionIdentifier } from '@podium/protocol'
import { type Sidebar as SidebarSettings, shouldPromptAutoContinue } from '@podium/runtime'
import type { PodiumClientApi } from '../api'
import type { SocketHub } from '../socket-transport'
import type { SpawnTarget } from '../spawn-agent'
import { type Router, routeDefaults } from '../ui-state'
import type {
  DockTab,
  FileScope,
  FileTab,
  PaneId,
  PinKind,
  PinState,
  RecentFileEntry,
  TabId,
  WorkspaceLayout,
  WorkspaceMap,
} from '../viewmodels'
import {
  activateTab,
  closePane,
  closeTab,
  focusPane,
  leafPaneIds,
  moveTab,
  openTab,
  promoteTab,
  reposToViews,
  resizeSplit,
  splitPane,
  tabIdFor,
} from '../viewmodels'
import type { SuperThreadView } from '../viewmodels/slices/superagent'
import {
  createReplicatedLayoutController,
  type ReplicatedLayoutController,
} from './replicated-layout'
import {
  currentWorkspace,
  type WorkspacePatch,
  type WorkspaceSelection,
  workspaceFor,
  workspaceKeyForState,
  workspacesPatch,
  workspaceWritePatch,
} from './state'
import type { Store, StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

/**
 * Genuinely device-local actions. Route entries delegate to Router; the rest
 * mutate the UiState-backed action snapshot. POD-403 owns the per-key routing.
 * This is an exclusion list, not a default.
 */
export const UI_LOCAL_ACTIONS = [
  'setView',
  'setSettingsTab',
  'setOpenIssueId',
  'setSuperThreadId',
  'setPaletteOpen',
  'setSelectedWorktree',
  'setSelectedIssueId',
  'setPane',
  'setFocusedPane',
  'setSplitEnabled',
  'openSessionTab',
  'openTabInWorkspace',
  'promoteWorkspaceTab',
  'activateWorkspaceTab',
  'closeWorkspaceTab',
  'moveWorkspaceTab',
  'splitWorkspacePane',
  'closeWorkspacePane',
  'focusWorkspacePane',
  'resizeWorkspaceSplit',
  'navigateToSession',
  'setDockShell',
  'setDockVisibleSession',
  'toggleSplit',
  'openFile',
  'openFileInWorktree',
  'openArtifact',
  'closeFileTab',
  'closeAutoContinuePrompt',
  // POD-1069: attaching a session to the next superagent turn is a local
  // intention until that turn is sent. It moved out of COMMAND_ACTIONS when it
  // stopped minting a `btw_<sessionId>` thread — there is no write behind it any
  // more, and an offline client can still line one up.
  'startBtw',
  'clearAttachedSession',
] as const

/** Replicated/domain writes. Some are online-only by their command contract. */
export const COMMAND_ACTIONS = [
  'setPinned',
  'setTabOrder',
  'setSuperOpen',
  'setDockTab',
  'setPanelMode',
  'tldrSession',
  'writeFileScoped',
  'spawnDraftAgent',
  'killSession',
  'continueSession',
  'hibernateSession',
  'resurrectSession',
  'resumeAndSend',
  'renameSession',
  'archiveSession',
  'dismissOffer',
  'setWorkState',
  'setSnooze',
  'clearSnooze',
  'markSessionRead',
  'markSessionUnread',
  'markIssueRead',
  'markIssueUnread',
  'setIssueTucked',
  'updateIssue',
  'archiveIssue',
  'deleteIssue',
  'closeIssue',
  'deferIssue',
  'undeferIssue',
  'setIssueLabels',
  'setIssuePlacement',
  'restoreIssue',
  'setSessionDraft',
  'setSidebarSettings',
] as const

/** Command contracts reduced directly into non-entity action state. */
export const ACTION_STATE_REDUCER_COMMANDS = [
  'pins.set',
  'tabs.setOrder',
  'layout.set',
  'layout.clear',
  'settings.updatePersonal',
] as const

type ActionState = {
  pins: PinState
  tabOrders: Record<string, string[]>
  sessions: SessionMeta[]
  issues: IssueWire[]
  repos: Store['repos']
  superThreadId: ThreadId
  superOpen: boolean
  attachedSessionId: SessionId | null
  dockTab: DockTab
  superThreads: SuperThreadView[]
  paletteOpen: boolean
  selectedWorktree: string | null
  selectedIssueId: IssueId | null
  workspaces: WorkspaceMap
  paneA: SessionId | null
  paneB: SessionId | null
  split: boolean
  focusedPane: 'A' | 'B'
  splitEnabled: boolean
  panelMode: Record<string, 'chat' | 'native'>
  dockShells: Record<string, SessionId>
  dockVisibleSession: string | null
  autoContinuePromptSessionId: SessionId | null
  sidebarSettings: SidebarSettings
  fileTabs: FileTab[]
  recentFiles: RecentFileEntry[]
}

type ActionName = (typeof UI_LOCAL_ACTIONS)[number] | (typeof COMMAND_ACTIONS)[number]
export type EngineActions<TApi extends PodiumClientApi = PodiumClientApi> = Pick<
  Store<TApi>,
  ActionName | 'readFileScoped' | 'listDir' | 'gitStatus' | 'gitLog' | 'gitDiffFile'
> & { readonly replicatedLayout: ReplicatedLayoutController }

export interface EngineActionRuntime<TApi extends PodiumClientApi> {
  readonly api: TApi
  readonly hub: SocketHub
  readonly outbox: EngineOutbox
  readonly router: Router
  readonly notices: StoreNotices
  /** Layout base persisted by an earlier session, for hydrate-first paint
   *  (POD-571). The runtime reads it out of the replica; absent means cold. */
  readonly layoutSeed?: LayoutSnapshot
  /** Write an authoritative layout base back to durable storage (POD-571). */
  onLayoutBaseInstalled?(snapshot: LayoutSnapshot): void
  state(): Readonly<ActionState>
  apply(patch: Partial<ActionState>): void
  /**
   * Queue a write and repaint from it (#263). RESOLVES WHEN THE OVERLAY IS
   * PUBLISHED, not when the call is made (POD-781): the durable enqueue is a real
   * await, and a caller that has to hand a gesture over to the repainted list —
   * the sidebar's drag, which holds its transforms exactly that long — needs a
   * promise that means something. Voiding it here made every issue action resolve
   * a couple of frames before the row moved.
   */
  enqueueOverlayed<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
  ): Promise<void>
  revealFileTab(args: {
    tabId: string
    worktreePath?: string
    issueId?: IssueId
    /** Default true. False opens the file as the workspace's ONE preview tab —
     *  the file tree's single click (POD-788). */
    permanent?: boolean
  }): void
  recordRecentFile(entry: Omit<RecentFileEntry, 'openedAt'>): void
  spawnDraftAgent(args: {
    target: SpawnTarget
    agentKind: AgentKind
    firstPrompt?: string
    model?: string
    effort?: string
  }): {
    sessionId: SessionId
    issueId: IssueId
  }
  /**
   * Hold a first chat send until an optimistic spawn's create has reconciled
   * (or rolled back). See OptimismLedger.waitForSpawnConfirmed (POD-546).
   */
  waitForSpawnConfirmed(sessionId: SessionId): Promise<void>
  setSessionDraft(sessionId: SessionId, text: string): void
  /** Re-read the signed-in user's superagent threads. A NAMED refresh, replacing
   *  the `superRefreshKey` counter the view used to watch: a counter says only
   *  "something changed", so every bump refetched everything and a forgotten
   *  bump was a silently stale list (POD-330, audit item zero). */
  refreshSuperThreads(): Promise<void>
}

function reducePin(state: PinState, kind: PinKind, id: string, pinned: boolean): PinState {
  const key = kind === 'panel' ? 'panels' : kind === 'worktree' ? 'worktrees' : 'repos'
  const values = state[key].filter((candidate) => candidate !== id)
  return { ...state, [key]: pinned ? [...values, id] : values }
}

/** The slice of action state a workspace write reads. */
type WorkspaceStateSlice = Pick<
  ActionState,
  'issues' | 'selectedIssueId' | 'selectedWorktree' | 'workspaces'
>

/** Reduce the current workspace and re-derive the pane mirrors — the pure core
 *  of every workspace action. */
function workspaceEdit(
  st: WorkspaceStateSlice,
  reduce: (ws: WorkspaceLayout) => WorkspaceLayout,
  selection?: Partial<WorkspaceSelection>,
): WorkspacePatch {
  const key = workspaceKeyForState(selection ? { ...st, ...selection } : st)
  return workspaceWritePatch(st, key, reduce(workspaceFor(st, key)))
}

/**
 * Drop a tab from EVERY workspace, not just the one on screen.
 *
 * Used where the thing behind the tab is gone (a killed session, a closed file),
 * which is the only reason a tab may disappear from a workspace the operator is
 * not looking at. Closing a tab by hand goes through `closeWorkspaceTab` and
 * touches the current workspace alone.
 */
function forgetTab(st: WorkspaceStateSlice, tabId: TabId): WorkspacePatch {
  return workspacesPatch(st, (ws) => closeTab(ws, tabId))
}

/**
 * The pane scalars after a tab is forgotten.
 *
 * `patch` carries the mirror whenever the layout moved, and the mirror is the
 * ONLY thing allowed to write these — spread it whole. The fallbacks cover the
 * case where no layout held the tab (nothing to mirror) but a pane scalar still
 * names it, which is the pre-POD-710 restore path. `=== undefined` rather than
 * `??`, because `null` is a value the mirror legitimately computes: a `??` here
 * discarded "this pane is now empty" and kept the dead id.
 */
function forgottenPanes(
  patch: WorkspacePatch,
  st: Pick<ActionState, 'paneA' | 'paneB'>,
  tabId: TabId,
): WorkspacePatch {
  return {
    ...patch,
    ...(patch.paneA === undefined && st.paneA === tabId ? { paneA: null } : {}),
    ...(patch.paneB === undefined && st.paneB === tabId ? { paneB: null } : {}),
  }
}

export function createEngineActions<TApi extends PodiumClientApi>(
  rt: EngineActionRuntime<TApi>,
): EngineActions<TApi> {
  const api = rt.api
  const replicatedLayout = createReplicatedLayoutController({
    outbox: rt.outbox,
    api,
    notices: rt.notices,
    ...(rt.layoutSeed !== undefined ? { seed: rt.layoutSeed } : {}),
    ...(rt.onLayoutBaseInstalled !== undefined
      ? { onBaseInstalled: (snapshot) => rt.onLayoutBaseInstalled?.(snapshot) }
      : {}),
  })
  /**
   * ONE WRITE PATH for the tab workspaces (POD-710). Every action below rewrites
   * exactly the CURRENT workspace and re-derives the pane mirrors from it, so
   * `paneA`/`paneB`/`split`/`focusedPane` can never drift from what is on
   * screen. `selection` names the workspace a navigation is moving TO, when the
   * same apply also changes the selected issue/worktree.
   */
  const editWorkspace = (
    reduce: (ws: WorkspaceLayout) => WorkspaceLayout,
    selection?: Partial<WorkspaceSelection>,
  ): void => {
    rt.apply(workspaceEdit(rt.state(), reduce, selection))
  }

  const openInWorkspace = (tabId: TabId, opts?: { permanent?: boolean; paneId?: PaneId }): void => {
    if (!tabId) return
    editWorkspace((ws) =>
      openTab(ws, tabId, {
        // Default PERMANENT: only the flight deck's single click asks for a
        // preview, and a caller that has not thought about it wants a tab that
        // stays rather than one the next click recycles.
        permanent: opts?.permanent !== false,
        ...(opts?.paneId !== undefined ? { paneId: opts.paneId } : {}),
      }),
    )
  }

  return {
    replicatedLayout,
    setPinned: async (kind: PinKind, id: string, pinned: boolean) => {
      const previous = rt.state().pins
      rt.apply({ pins: reducePin(previous, kind, id, pinned) })
      try {
        await rt.outbox.enqueue('pinSet', { kind, id, pinned })
      } catch (error) {
        rt.apply({ pins: previous })
        throw error
      }
    },
    setTabOrder: async (worktree: string, sessionIds: SessionId[]) => {
      const previous = rt.state().tabOrders
      rt.apply({ tabOrders: { ...previous, [worktree]: sessionIds } })
      try {
        await rt.outbox.enqueue('tabSetOrder', { worktree, sessionIds })
      } catch (error) {
        rt.apply({ tabOrders: previous })
        throw error
      }
    },
    setView: (view) => {
      const current = rt.router.current()
      if (current.view !== view) {
        rt.router.navigate({
          ...routeDefaults(view),
          worktree: current.worktree,
          pane: current.pane,
        })
      }
    },
    setSettingsTab: (tab) => {
      const current = rt.router.current()
      if (current.view === 'settings') {
        if (current.settingsTab !== tab) rt.router.navigate({ ...current, settingsTab: tab })
      } else if (tab !== null) {
        rt.router.navigate({ ...current, view: 'settings', settingsTab: tab, issueId: null })
      }
    },
    setOpenIssueId: (id) => {
      const current = rt.router.current()
      if (current.view !== 'issues' || current.issueId !== id) {
        rt.router.navigate({ ...current, view: 'issues', issueId: id })
      }
    },
    setSuperThreadId: (superThreadId) => rt.apply({ superThreadId: asThreadId(superThreadId) }),
    setSuperOpen: (superOpen) => rt.apply({ superOpen }),
    setDockTab: (dockTab) => rt.apply({ dockTab }),
    /**
     * "ASK SUPERAGENT (BTW)" — OPEN THE ONE CHAT, WITH THIS SESSION ATTACHED
     * (POD-1069).
     *
     * It used to aim `superThreadId` at `btw_<sessionId>` and mint that thread
     * server-side. The dock has bound the global thread alone since POD-782, so
     * what the operator got was a pane rendering a thread with no headless
     * session: no composer, no way back, and no reset until a reload — from all
     * three entry points (tab overflow, session context menu, command palette).
     *
     * The thread was never the point; the session's transcript was. So the pane
     * stays on the one chat and the session is ATTACHED to whatever the operator
     * types next — the server digests it into that turn's preamble with the same
     * `buildBtwSeed` block the btw thread was seeded with. No thread to switch
     * to, and therefore no thread to be stranded on.
     */
    startBtw: async (sessionId) => {
      rt.apply({ attachedSessionId: sessionId, superOpen: true })
    },
    clearAttachedSession: () => rt.apply({ attachedSessionId: null }),
    tldrSession: async (sessionId, answerText) => {
      rt.apply({ superOpen: true })
      const prompt = answerText.trim()
        ? `Give me a concise tl;dr (2–4 bullet points) of the agent's last answer below.\n\n---\n${answerText.trim().slice(0, 4000)}`
        : "Give me a concise tl;dr (2–4 bullet points) of the agent's last answer."
      // The session rides WITH the turn rather than as a thread of its own, so
      // the answer lands in the chat the operator is already looking at. The
      // attachment is spent here, not staged: nothing is left on the store for
      // the operator's next message to pick up by accident.
      await api.superagent.sendTurn
        .mutate({ threadId: asThreadId('global'), text: prompt, attachSessionId: sessionId })
        .catch(() => {})
      await rt.refreshSuperThreads().catch(() => {})
    },
    setPaletteOpen: (paletteOpen) => rt.apply({ paletteOpen }),
    setSelectedWorktree: (selectedWorktree) => rt.apply({ selectedWorktree }),
    setSelectedIssueId: (selectedIssueId) => rt.apply({ selectedIssueId }),
    /**
     * PANE-SHAPED ADAPTER over the workspace model, and nothing more.
     *
     * `A` is the first leaf pane and `B` the second, so selecting into one opens
     * (or activates) a tab there and the mirror reports it back. Every branch
     * goes through the layout: the scalars are DERIVED, and a second writer to a
     * derived field is how they drift out of the strip that renders them.
     *
     * Two branches are therefore inert rather than raw writes:
     *  - `id === null`. Clearing a pane is not an operation the model has — a
     *    pane holds tabs and shows one of them; emptying it means closing them.
     *    The callers that passed null (`selectWorktree` with no session to open)
     *    are ALREADY covered: switching task/worktree switches workspace, and
     *    that workspace's own layout — restored exactly, which is the point —
     *    re-derives the scalars. Blanking them here overrode a restore.
     *  - pane `B` with a single-leaf layout. There is no second pane; the
     *    operator makes one by splitting. Writing `paneB` anyway produced a
     *    session that the strip had no tab for and no pane rendered.
     */
    setPane: (pane, id) => {
      if (id === null) return
      const st = rt.state()
      const leaves = leafPaneIds(workspaceFor(st, workspaceKeyForState(st)).root)
      const paneId = pane === 'A' ? leaves[0] : leaves[1]
      if (paneId === undefined) return
      editWorkspace((ws) => openTab(ws, id, { permanent: true, paneId }))
    },
    openSessionTab: (sessionId, opts) => openInWorkspace(sessionId, opts),
    openTabInWorkspace: (tabId, opts) => openInWorkspace(tabId, opts),
    promoteWorkspaceTab: (tabId) => editWorkspace((ws) => promoteTab(ws, tabId)),
    activateWorkspaceTab: (tabId) => editWorkspace((ws) => activateTab(ws, tabId)),
    // Closing a tab closes a VIEW: the session is untouched (it lives in the
    // flight deck now), and a file tab's buffer goes with its only view.
    closeWorkspaceTab: (tabId) => {
      const st = rt.state()
      // A file tab's buffer dies with its view, so it leaves every workspace; a
      // session tab is only a view here and closes in the one on screen.
      const isFile = st.fileTabs.some((tab) => tab.id === tabId)
      const patch = isFile ? forgetTab(st, tabId) : workspaceEdit(st, (ws) => closeTab(ws, tabId))
      const fileTabs = st.fileTabs.filter((tab) => tab.id !== tabId)
      rt.apply({
        ...forgottenPanes(patch, st, tabId),
        ...(fileTabs.length !== st.fileTabs.length ? { fileTabs } : {}),
      })
    },
    moveWorkspaceTab: (tabId, toPaneId, toIndex) =>
      editWorkspace((ws) => moveTab(ws, tabId, toPaneId, toIndex)),
    splitWorkspacePane: (paneId, axis, opts) =>
      editWorkspace((ws) => splitPane(ws, paneId, axis, opts)),
    closeWorkspacePane: (paneId) => editWorkspace((ws) => closePane(ws, paneId)),
    focusWorkspacePane: (paneId) => editWorkspace((ws) => focusPane(ws, paneId)),
    resizeWorkspaceSplit: (path, sizes) => editWorkspace((ws) => resizeSplit(ws, path, sizes)),
    setFocusedPane: (focusedPane) => rt.apply({ focusedPane }),
    // The view telling the engine what it renders — see EngineState.splitEnabled.
    // Explicit and typed on purpose: the engine never reads a feature flag, and
    // "every leaf is on screen" is an assumption it is not entitled to make.
    setSplitEnabled: (splitEnabled) => rt.apply({ splitEnabled }),
    navigateToSession: (sessionIdOrRef) => {
      const state = rt.state()
      const meta = resolveSessionIdentifier(sessionIdOrRef, state.sessions)
      if (!meta) return
      const worktree =
        reposToViews(state.repos)
          .flatMap((repo) => repo.worktrees)
          .map((candidate) => candidate.path)
          .filter((path) => meta.cwd === path || meta.cwd.startsWith(`${path}/`))
          .sort((a, b) => b.length - a.length)[0] ?? state.selectedWorktree
      const selection = {
        ...(meta.issueId ? { selectedIssueId: meta.issueId } : {}),
        ...(worktree ? { selectedWorktree: worktree } : {}),
      }
      rt.apply({
        ...selection,
        // Landing on a session opens it as a real tab in the workspace it
        // belongs to — otherwise the pane would show a session the strip has no
        // tab for, and the next layout write would mirror it away. The mirror
        // that comes back sets the pane scalars: forcing `paneA` on top of it
        // put the session in BOTH panes of a split layout (the tab opened in
        // the focused pane B, and the literal repeated it in A), blanking the
        // other half.
        ...workspaceEdit(
          { ...state, ...selection },
          (ws) => openTab(ws, meta.sessionId, { permanent: true }),
          selection,
        ),
      })
      rt.router.navigate({
        ...routeDefaults('workspace'),
        ...(worktree ? { worktree } : {}),
        pane: meta.sessionId,
      })
    },
    setPanelMode: (sessionId, mode) => {
      const panelMode = rt.state().panelMode
      if (panelMode[sessionId] !== mode)
        rt.apply({ panelMode: { ...panelMode, [sessionId]: mode } })
    },
    setDockVisibleSession: (dockVisibleSession) => rt.apply({ dockVisibleSession }),
    setDockShell: (worktreePath, sessionId) => {
      const current = rt.state().dockShells
      if ((current[worktreePath] ?? null) === sessionId) return
      const dockShells = { ...current }
      if (sessionId) dockShells[worktreePath] = sessionId
      else delete dockShells[worktreePath]
      rt.apply({ dockShells })
    },
    /**
     * SPLIT / UNSPLIT, as a layout edit (POD-710 wave 2).
     *
     * `split` is DERIVED from the layout's leaf count, so the old
     * `rt.apply({ split: !split })` was a write that the very next layout write
     * undid: it flipped the scalar true against a single-leaf layout and the
     * mirror derived it straight back to false. Toggling now edits the thing the
     * scalar is a mirror OF.
     *
     * Collapsing merges every other pane's tabs into the first (closePane's own
     * rule) rather than closing them — unsplitting is a change of arrangement,
     * and it must not silently take views away with it.
     */
    toggleSplit: () => {
      const leaves = leafPaneIds(currentWorkspace(rt.state()).root)
      if (leaves.length < 2) {
        editWorkspace((ws) => splitPane(ws, ws.focusedPaneId, 'row'))
        return
      }
      editWorkspace((ws) => leaves.slice(1).reduce((acc, paneId) => closePane(acc, paneId), ws))
    },
    openFile: (sessionId, path) => {
      const scope: FileScope = { kind: 'session', sessionId }
      const id = tabIdFor(scope, path)
      const state = rt.state()
      const session = state.sessions.find((candidate) => candidate.sessionId === sessionId)
      const cwd = session?.cwd ?? ''
      const worktreePath =
        reposToViews(state.repos)
          .flatMap((repo) => repo.worktrees)
          .map((candidate) => candidate.path)
          .filter((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`))
          .sort((a, b) => b.length - a.length)[0] ?? cwd
      const existing = state.fileTabs.find((tab) => tab.id === id)
      const issueId = existing
        ? existing.issueId
        : (session?.issueId ?? state.selectedIssueId ?? undefined)
      rt.apply({
        fileTabs: existing
          ? state.fileTabs
          : [...state.fileTabs, { id, scope, path, worktreePath, ...(issueId ? { issueId } : {}) }],
      })
      rt.revealFileTab({
        tabId: id,
        ...(worktreePath ? { worktreePath } : {}),
        ...(issueId ? { issueId } : {}),
      })
      rt.recordRecentFile({
        path,
        worktreePath,
        ...(session?.machineId ? { machineId: session.machineId } : {}),
      })
    },
    openFileInWorktree: (args) => {
      const scope: FileScope = { kind: 'worktree', machineId: args.machineId, root: args.root }
      const id = tabIdFor(scope, args.path)
      const state = rt.state()
      const existing = state.fileTabs.find((tab) => tab.id === id)
      const issueId = existing
        ? existing.issueId
        : (args.issueId ?? state.selectedIssueId ?? undefined)
      rt.apply({
        fileTabs: existing
          ? state.fileTabs
          : [
              ...state.fileTabs,
              {
                id,
                scope,
                path: args.path,
                worktreePath: args.root,
                ...(issueId ? { issueId } : {}),
              },
            ],
      })
      rt.revealFileTab({
        tabId: id,
        worktreePath: args.root,
        ...(issueId ? { issueId } : {}),
        ...(args.permanent === false ? { permanent: false } : {}),
      })
      rt.recordRecentFile({
        path: args.path,
        worktreePath: args.root,
        ...(args.machineId ? { machineId: args.machineId } : {}),
      })
    },
    openArtifact: (args) => {
      const scope: FileScope = {
        kind: 'artifact',
        issueId: args.issueId,
        artifactId: args.artifactId,
      }
      const id = tabIdFor(scope, args.path)
      const state = rt.state()
      if (!state.fileTabs.some((tab) => tab.id === id)) {
        rt.apply({
          fileTabs: [
            ...state.fileTabs,
            {
              id,
              scope,
              path: args.path,
              worktreePath: args.worktreePath ?? '',
              issueId: args.issueId,
            },
          ],
        })
      }
      rt.revealFileTab({
        tabId: id,
        issueId: args.issueId,
        ...(args.worktreePath ? { worktreePath: args.worktreePath } : {}),
      })
      rt.recordRecentFile({
        path: args.path,
        worktreePath: args.worktreePath ?? '',
        artifact: { issueId: args.issueId, artifactId: args.artifactId },
      })
    },
    closeFileTab: (id) => {
      const state = rt.state()
      rt.apply({
        // The WHOLE mirror, not a hand-picked `workspaces`/`paneA`/`paneB`:
        // dropping `split`/`focusedPane` left the layout saying one pane and
        // the scalars saying two, with no later write able to correct it.
        ...forgottenPanes(forgetTab(state, id), state, id),
        fileTabs: state.fileTabs.filter((tab) => tab.id !== id),
      })
    },
    readFileScoped: ((scope: FileScope, path: string) =>
      scope.kind === 'session'
        ? api.files.read.query({ sessionId: scope.sessionId, path })
        : scope.kind === 'artifact'
          ? api.files.read.query({ issueId: scope.issueId, artifactId: scope.artifactId, path })
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
    }) => {
      if (args.scope.kind === 'artifact')
        return Promise.reject(new Error('artifact snapshots are read-only'))
      return args.scope.kind === 'session'
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
          })
    }) as Store<TApi>['writeFileScoped'],
    listDir: ((args) => api.files.list.query(args)) as Store<TApi>['listDir'],
    gitStatus: ((args) => api.git.status.query(args)) as Store<TApi>['gitStatus'],
    gitLog: ((args) => api.git.log.query(args)) as Store<TApi>['gitLog'],
    gitDiffFile: ((args) => api.git.diffFile.query(args)) as Store<TApi>['gitDiffFile'],
    spawnDraftAgent: (args) => rt.spawnDraftAgent(args),
    killSession: async (sessionId) => {
      await api.sessions.kill.mutate({ sessionId }).catch(() => {})
      const state = rt.state()
      // A killed session's tabs are views onto something that no longer exists —
      // the one case where a tab goes away without the operator closing it. The
      // whole mirror is applied, `split` and `focusedPane` included: killing the
      // session in the second pane collapses it, and a patch that computed that
      // but did not write it left a phantom pane nothing could clear.
      rt.apply({
        ...forgottenPanes(forgetTab(state, sessionId), state, sessionId),
        fileTabs: state.fileTabs.filter(
          (tab) => !(tab.scope.kind === 'session' && tab.scope.sessionId === sessionId),
        ),
        pins: { ...state.pins, panels: state.pins.panels.filter((id) => id !== sessionId) },
        tabOrders: Object.fromEntries(
          Object.entries(state.tabOrders).map(([worktree, ids]) => [
            worktree,
            ids.filter((id) => id !== sessionId),
          ]),
        ),
      })
    },
    continueSession: async (sessionId) => {
      await api.sessions.continue.mutate({ sessionId }).catch(() => {})
      try {
        const settings = await api.settings.get.query()
        if (shouldPromptAutoContinue(settings)) rt.apply({ autoContinuePromptSessionId: sessionId })
      } catch {}
    },
    closeAutoContinuePrompt: () => rt.apply({ autoContinuePromptSessionId: null }),
    hibernateSession: async (sessionId) => {
      await api.sessions.hibernate.mutate({ sessionId }).catch(() => {})
    },
    resurrectSession: async (sessionId) => {
      try {
        const result = await api.sessions.resurrect.mutate({ sessionId })
        if (!result.ok)
          rt.notices.error(`Couldn't resume the session — ${result.reason ?? 'unknown error'}`)
        return result
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error'
        rt.notices.error(`Couldn't resume the session — ${reason}`)
        return { ok: false, reason }
      }
    },
    resumeAndSend: async (sessionId, text) => {
      // Optimistic spawn paints the session id before the server has it. A send
      // in that window dead-letters as "unknown session" and used to be treated
      // as applied — the prompt never reached the agent (POD-546).
      await rt.waitForSpawnConfirmed(sessionId)
      await rt.outbox.enqueue('resumeAndSend', { sessionId, text })
    },
    renameSession: async (sessionId, name) => rt.enqueueOverlayed('rename', { sessionId, name }),
    archiveSession: async (sessionId, archived) => {
      rt.enqueueOverlayed('setArchived', { sessionId, archived })
      if (archived) rt.enqueueOverlayed('setWorkState', { sessionId, workState: 'done' })
      if (archived) {
        const pins = rt.state().pins
        rt.apply({ pins: { ...pins, panels: pins.panels.filter((id) => id !== sessionId) } })
        await rt.outbox.enqueue('pinSet', { kind: 'panel', id: sessionId, pinned: false })
      }
    },
    // NOT `enqueueOverlayed`, unlike its neighbours here: the contract is
    // `offline: 'direct-only'`, so this goes straight at the server and the
    // cleared session broadcast is what takes the offer off the surfaces. The
    // error is left to propagate — a caller that has hidden its offer bar
    // optimistically needs to hear that the server still holds it.
    dismissOffer: async (sessionId: SessionId, offerCreatedAt: string) => {
      await api.sessions.dismissOffer.mutate({ sessionId, offerCreatedAt })
    },
    setWorkState: async (sessionId: SessionId, workState: WorkState | null) =>
      rt.enqueueOverlayed('setWorkState', { sessionId, workState }),
    setSnooze: async (sessionId, until) => rt.enqueueOverlayed('snoozeSet', { sessionId, until }),
    clearSnooze: async (sessionId) => rt.enqueueOverlayed('snoozeClear', { sessionId }),
    markSessionRead: async (sessionId) => rt.enqueueOverlayed('sessionMarkRead', { sessionId }),
    markSessionUnread: async (sessionId) => rt.enqueueOverlayed('sessionMarkUnread', { sessionId }),
    markIssueRead: async (id) => rt.enqueueOverlayed('issueMarkRead', { id }),
    markIssueUnread: async (id) => rt.enqueueOverlayed('issueMarkUnread', { id }),
    setIssueTucked: async (id, tucked) => rt.enqueueOverlayed('issueSetTucked', { id, tucked }),
    // The curation writes (POD-781). Nothing here but the enqueue: the queued
    // entry IS the optimistic apply (#263), so there is no local mirror to keep
    // and no rollback to write — the overlay retires itself on covering truth or
    // drops on a definitive refusal, and the poison toast is the failure surface.
    updateIssue: async (id, patch) => rt.enqueueOverlayed('issueUpdate', { id, patch }),
    archiveIssue: async (id) => rt.enqueueOverlayed('issueArchive', { id }),
    deleteIssue: async (id) => rt.enqueueOverlayed('issueDelete', { id }),
    closeIssue: async (id, reason) => rt.enqueueOverlayed('issueClose', { id, reason }),
    deferIssue: async (id, until) => rt.enqueueOverlayed('issueDefer', { id, until }),
    undeferIssue: async (id) => rt.enqueueOverlayed('issueUndefer', { id }),
    setIssueLabels: async (id, labels) => rt.enqueueOverlayed('issueSetLabels', { id, labels }),
    setIssuePlacement: async (id, placement, originId) =>
      rt.enqueueOverlayed('issueSetPlacement', { id, placement, originId }),
    restoreIssue: async (id) => rt.enqueueOverlayed('issueRestore', { id }),
    setSessionDraft: (sessionId, text) => rt.setSessionDraft(sessionId, text),
    setSidebarSettings: async (next) => {
      const previous = rt.state().sidebarSettings
      rt.apply({ sidebarSettings: { ...previous, ...next } })
      const values = Object.fromEntries(
        Object.entries(next).map(([key, value]) => [`sidebar.${key}`, value]),
      )
      try {
        await rt.outbox.enqueue('settingsUpdatePersonal', { values })
      } catch (error) {
        rt.apply({ sidebarSettings: previous })
        throw error
      }
    },
  }
}
