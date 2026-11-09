/** This signed-in user's screen state on this device. Only UiPersistence saves it. */
import { lazy } from '@podium/mobx-helpers'
import {
  type ArtifactId,
  asThreadId,
  type CheckoutRepository,
  type IssueId,
  isMachinePathWithinRoot,
  type MachineId,
  type SessionId,
  type ThreadId,
} from '@podium/model'
import { isSessionIdPrefix } from '@podium/protocol'
import { actionBound, observable, observableRef } from 'mobx'
import type { PodiumClientApi } from '../api'
import type { NoticeSink } from '../notices'
import type { SocketHub } from '../socket-transport'
import type { FileScrollPosition, MainView, RoutedUiState, Router } from '../ui-state'
import { readStoredPanelModes, UI_STATE_KEYS, uiStateRoute } from '../ui-state'
import type {
  DockTab,
  FileScope,
  FileTab,
  PaneId,
  RecentFileEntry,
  SplitAxis,
  TabId,
  WorkspaceLayout,
  WorkspaceMap,
} from '../values'
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
} from '../values'
import { type NavigationIntent, planNavigation } from './navigation'
import { sessionLinkProblem, sessionLinkSelection } from './session-link'
import {
  currentWorkspace,
  focusedPaneSession,
  loadingNavigationProvider,
  NAVIGATION_LOADING,
  type NavigationProvider,
  resolvedWorkspaceKey,
  type ScreenState,
  userFocus,
  type WorkspaceSelection,
  workspaceFor,
  workspaceKeyForState,
  workspaceMirrorPatch,
} from './state'
import type { IssueVisitBaseline, UserFocus } from './types'
import {
  forgetTab,
  forgottenPanes,
  ISSUE_SESSION_WAIT_MS,
  waitForState,
  workspaceEdit,
} from './workspace-actions'

export interface FileTabOpen {
  tabId: string
  worktreePath?: string
  issueId?: IssueId
  permanent?: boolean
  fileTab?: FileTab
  recentFile?: Omit<RecentFileEntry, 'openedAt'>
}
export interface Notice {
  readonly id: string
  readonly message: string
  readonly kind: 'error' | 'info'
  readonly description?: string
}
export interface UiStorePorts {
  api: PodiumClientApi
  hub: SocketHub
  notices: NoticeSink
  keys: RoutedUiState
  router: Router
  /** The registered repositories and their worktrees, derived from the
   *  replica's `checkout` records (POD-6644). */
  repositories(): readonly CheckoutRepository[]
  isVisible(): boolean
  watch?(keys: readonly ('selectedIssueId' | 'navigation')[], listener: () => void): () => void
  navigate?(intent: NavigationIntent): boolean
  waitForSessionNavigation?(identifier: string): void
  revealTranscript?(sessionId: SessionId, itemKey: string): void
}

export class UiStore {
  @observableRef accessor issueVisitBaseline: IssueVisitBaseline | null = null
  @actionBound setIssueVisitBaseline(value: IssueVisitBaseline | null): void {
    this.issueVisitBaseline = value
  }
  @observable accessor view: MainView = 'workspace'
  @observable accessor selectedWorktree: string | null = null
  @observable accessor selectedIssueId: IssueId | null = null
  @observable accessor settingsTab: string | null = null
  @observable accessor openIssueId: IssueId | null = null
  @observable accessor superThreadId: ThreadId | null = asThreadId('global')
  @observable accessor attachedSessionId: SessionId | null = null
  @observable accessor dockVisibleSession: SessionId | null = null
  @observable accessor focusedPane: PaneId = 'p1'
  @observableRef accessor workspaces: WorkspaceMap = {}
  @observableRef accessor dockShells: Record<string, SessionId> = {}
  @observableRef accessor recentFiles: RecentFileEntry[] = []
  readonly devicePrefs = observable.map<string, string>()
  getDevicePref(key: string): string | null {
    this.assertDevicePreference(key)
    return this.devicePrefs.get(key) ?? null
  }
  private assertDevicePreference(key: string): void {
    if (
      [
        'view',
        'selectedWorktree',
        'selectedIssueId',
        'paneA',
        'paneB',
        'split',
        'workspaces',
        'fileTabs',
        'fileScroll',
        'dockShells',
        'recentFiles',
      ].some((field) => Reflect.get(UI_STATE_KEYS, field) === key)
    )
      throw new Error(`${key} is a typed UiStore field`)
  }
  @actionBound setDevicePref(key: string, value: string | null): void {
    this.assertDevicePreference(key)
    if (uiStateRoute(key).home !== 'device-local')
      throw new Error(`Not a device preference: ${key}`)
    if (value === null) this.devicePrefs.delete(key)
    else this.devicePrefs.set(key, value)
  }
  readonly fileTabs = observable.map<string, FileTab>(undefined, { deep: false })
  readonly fileScroll = observable.map<string, number>()
  readonly notices = observable.array<Notice>([], { deep: false })
  /** The pool's addressed navigation handle, never rows or a collection copy. */
  @observableRef accessor navigation: NavigationProvider = loadingNavigationProvider
  readonly screen: ScreenState
  private alive = true

  constructor(private readonly ports: UiStorePorts) {
    // Pure planners and the existing services accept a narrow read port. These
    // getters read the one MobX home; this object stores no screen values.
    const fields = [
      'issueVisitBaseline',
      'view',
      'selectedWorktree',
      'selectedIssueId',
      'settingsTab',
      'openIssueId',
      'superThreadId',
      'attachedSessionId',
      'dockVisibleSession',
      'focusedPane',
      'workspaces',
      'dockShells',
      'recentFiles',
      'navigation',
      'paneA',
      'paneB',
      'split',
      'panelMode',
      'dockTab',
      'superOpen',
    ] as const
    this.screen = Object.defineProperties(
      {},
      {
        ...Object.fromEntries(
          fields.map((key) => [key, { enumerable: true, get: () => this[key] }]),
        ),
        fileTabs: { enumerable: true, get: () => this.fileTabList },
      },
    ) as ScreenState
  }

  get router(): Router {
    return this.ports.router
  }
  @lazy get fileTabList(): FileTab[] {
    return [...this.fileTabs.values()]
  }
  @lazy get workspaceLoading(): boolean {
    return resolvedWorkspaceKey(this.screen) === NAVIGATION_LOADING
  }
  @lazy get workspace(): WorkspaceLayout {
    return currentWorkspace(this.screen)
  }
  @lazy get focusedSessionId(): SessionId | null {
    return focusedPaneSession(this.screen)
  }
  @lazy get paneA(): SessionId | null {
    return workspaceMirrorPatch(this.workspace).paneA ?? null
  }
  @lazy get paneB(): SessionId | null {
    return workspaceMirrorPatch(this.workspace).paneB ?? null
  }
  @lazy get split(): boolean {
    return leafPaneIds(this.workspace.root).length > 1
  }
  // Synced layout is read through its owner. No preference value is saved here.
  @lazy get panelMode(): Record<string, 'chat' | 'native'> {
    return readStoredPanelModes(this.ports.keys)
  }
  @lazy get dockTab(): DockTab {
    const tab = this.ports.keys.get(UI_STATE_KEYS.dockTab)
    return tab === 'files' || tab === 'git' || tab === 'issue' ? tab : 'superagent'
  }
  @lazy get superOpen(): boolean {
    return this.ports.keys.get(UI_STATE_KEYS.superOpen) !== '0'
  }

  @actionBound
  patch(patch: Partial<ScreenState>): void {
    if (!this.alive) return
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'fileTabs') {
        this.fileTabs.replace((value as FileTab[]).map((tab) => [tab.id, tab]))
      } else if (key === 'panelMode' || key === 'dockTab' || key === 'superOpen') {
        this.ports.keys.set(
          UI_STATE_KEYS[key],
          typeof value === 'object'
            ? JSON.stringify(value)
            : typeof value === 'boolean'
              ? value
                ? '1'
                : '0'
              : String(value),
        )
      } else if (
        key !== 'paneA' &&
        key !== 'paneB' &&
        key !== 'split' &&
        key in this &&
        !Object.is(this[key as keyof this], value)
      ) {
        Reflect.set(this, key, value)
      }
    }
  }

  getFileScroll(id: string): FileScrollPosition | undefined {
    const top = this.fileScroll.get(JSON.stringify([id, 'top']))
    return top === undefined
      ? undefined
      : { top, left: this.fileScroll.get(JSON.stringify([id, 'left'])) ?? 0 }
  }
  @actionBound setFileScroll(id: string, value: FileScrollPosition): void {
    if (
      !Number.isFinite(value.top) ||
      value.top < 0 ||
      !Number.isFinite(value.left) ||
      value.left < 0
    )
      return
    const top = JSON.stringify([id, 'top']),
      left = JSON.stringify([id, 'left'])
    this.fileScroll.delete(top)
    this.fileScroll.delete(left)
    this.fileScroll.set(top, value.top)
    this.fileScroll.set(left, value.left)
    while (this.fileScroll.size > 400) {
      const first = this.fileScroll.keys().next().value
      if (first === undefined) break
      this.fileScroll.delete(first)
    }
  }
  @actionBound addNotice(notice: Notice): void {
    this.notices.push(notice)
  }
  @actionBound dismissNotice(id: string): void {
    this.notices.replace(this.notices.filter((notice) => notice.id !== id))
  }
  @actionBound setNavigation(navigation: NavigationProvider): void {
    this.patch({ navigation })
  }
  @lazy get workspaceKeyValue() {
    return workspaceKeyForState(this.screen)
  }
  readonly workspaceKey = () => this.workspaceKeyValue
  @actionBound getUserFocus(): UserFocus {
    return userFocus(this.screen)
  }
  @actionBound dispose(): void {
    this.alive = false
    this.notices.clear()
  }

  private onChange(
    keys: readonly ('selectedIssueId' | 'navigation')[],
    listener: () => void,
  ): () => void {
    return this.ports.watch?.(keys, listener) ?? (() => {})
  }
  private editWorkspace(
    reduce: (ws: WorkspaceLayout) => WorkspaceLayout,
    selection?: Partial<WorkspaceSelection>,
  ): void {
    this.patch(workspaceEdit(this.screen, reduce, selection))
  }
  private openInWorkspace(tabId: TabId, opts?: { permanent?: boolean; paneId?: PaneId }): void {
    if (tabId)
      this.editWorkspace((ws) =>
        openTab(ws, tabId, {
          permanent: opts?.permanent !== false,
          ...(opts?.paneId ? { paneId: opts.paneId } : {}),
        }),
      )
  }
  @actionBound navigate(intent: NavigationIntent): boolean {
    if (!this.alive) return false
    if (this.ports.navigate) return this.ports.navigate(intent)
    const plan = planNavigation(this.screen, this.router.current(), intent, {
      visible: this.ports.isVisible(),
      now: new Date().toISOString(),
    })
    if (plan.pending) return false
    this.patch(plan.patch)
    if (plan.replace) this.router.replace(plan.route)
    else this.router.navigate(plan.route)
    return true
  }
  @actionBound navigateToSession(identifier: string): void {
    if (!this.alive) return
    const meta = this.navigation.session(identifier)
    if (meta === NAVIGATION_LOADING) {
      this.ports.waitForSessionNavigation?.(identifier)
      return
    }
    if (!meta) {
      if (isSessionIdPrefix(identifier))
        void this.ports.api.sessions.resolve
          .query({ identifier })
          .then((answer) => {
            if (!this.alive) return
            if (answer.kind === 'session') this.navigateToSession(answer.sessionId)
            else this.ports.notices.error(sessionLinkProblem(identifier, answer))
          })
          .catch(() => {})
      return
    }
    this.navigate({
      view: 'workspace',
      ...sessionLinkSelection(this.screen, this.ports.repositories(), meta),
      tabId: meta.sessionId,
      history: 'push',
    })
  }
  private revealFileTab(args: FileTabOpen): void {
    this.navigate({
      view: 'workspace',
      ...(args.worktreePath ? { selectedWorktree: args.worktreePath } : {}),
      ...(args.issueId ? { selectedIssueId: args.issueId } : {}),
      tabId: args.tabId,
      firstPane: true,
      permanent: args.permanent !== false,
      ...(args.fileTab ? { fileTab: args.fileTab } : {}),
      ...(args.recentFile ? { recentFile: args.recentFile } : {}),
      retireOrphanFiles: true,
      history: 'push',
    })
  }
  @actionBound
  navigateWorkspace(...parameters: [intent: Omit<NavigationIntent, 'view'>]): boolean {
    const [intent] = parameters
    return this.navigate({ ...intent, view: 'workspace' })
  }

  @actionBound
  setView(...parameters: [view: MainView]): void {
    const [view] = parameters

    if (this.view !== view) this.navigate({ view })
  }

  @actionBound setSettingsTab(tab: string | null): void {
    if (this.view === 'settings' || tab !== null)
      this.patch({ view: 'settings', settingsTab: tab, openIssueId: null })
  }
  @actionBound setOpenIssueId(id: IssueId | null): void {
    this.patch({ view: 'issues', openIssueId: id, settingsTab: null })
  }

  @actionBound setSuperThreadId(id: string | null): void {
    this.patch({ superThreadId: id === null ? null : asThreadId(id) })
  }

  @actionBound
  setSuperOpen(...parameters: [open: boolean]): void {
    const [superOpen] = parameters
    this.ports.keys.set(UI_STATE_KEYS.superOpen, superOpen ? '1' : '0')
  }

  @actionBound
  setDockTab(...parameters: [tab: DockTab]): void {
    const [dockTab] = parameters
    this.ports.keys.set(UI_STATE_KEYS.dockTab, dockTab)
  }

  @actionBound
  async startBtw(sessionId: SessionId): Promise<void> {
    this.patch({ attachedSessionId: sessionId, superOpen: true, dockTab: 'superagent' })
  }

  @actionBound
  clearAttachedSession(...parameters: []): void {
    this.patch({ attachedSessionId: null })
  }

  @actionBound
  setSelectedWorktree(...parameters: [path: string | null]): void {
    const [selectedWorktree] = parameters
    this.patch({ selectedWorktree })
  }

  @actionBound
  setSelectedIssueId(...parameters: [id: IssueId | null]): void {
    const [selectedIssueId] = parameters
    this.patch({ selectedIssueId })
  }

  @actionBound
  setPane(...parameters: [pane: 'A' | 'B', sessionId: SessionId | null]): void {
    const [pane, id] = parameters

    if (id === null) return
    const st = this.screen
    const leaves = leafPaneIds(workspaceFor(st, workspaceKeyForState(st)).root)
    const paneId = pane === 'A' ? leaves[0] : leaves[1]
    if (paneId === undefined) return
    this.editWorkspace((ws) => openTab(ws, id, { permanent: true, paneId }))
  }

  @actionBound
  openSessionTab(
    ...parameters: [sessionId: SessionId, opts?: { permanent?: boolean; paneId?: PaneId }]
  ): void {
    const [sessionId, opts] = parameters
    this.openInWorkspace(sessionId, opts)
  }

  @actionBound
  openSessionAtTranscript(
    ...parameters: [sessionId: SessionId, itemKey: string, opts?: { permanent?: boolean }]
  ): void {
    const [sessionId, itemKey, opts] = parameters
    if (!sessionId || !itemKey) return
    this.openSessionTab(sessionId, opts)
    this.ports.revealTranscript?.(sessionId, itemKey)
  }

  @actionBound
  openTabInWorkspace(
    ...parameters: [tabId: TabId, opts?: { permanent?: boolean; paneId?: PaneId }]
  ): void {
    const [tabId, opts] = parameters
    this.openInWorkspace(tabId, opts)
  }

  @actionBound
  promoteWorkspaceTab(...parameters: [tabId: TabId]): void {
    const [tabId] = parameters
    this.editWorkspace((ws) => promoteTab(ws, tabId))
  }

  @actionBound
  activateWorkspaceTab(...parameters: [tabId: TabId]): void {
    const [tabId] = parameters
    this.editWorkspace((ws) => activateTab(ws, tabId))
  }

  @actionBound
  closeWorkspaceTab(...parameters: [tabId: TabId]): void {
    const [tabId] = parameters

    const st = this.screen
    // A file tab's buffer dies with its view, so it leaves every workspace; a
    // session tab is only a view here and closes in the one on screen.
    const isFile = st.fileTabs.some((tab) => tab.id === tabId)
    const patch = isFile ? forgetTab(st, tabId) : workspaceEdit(st, (ws) => closeTab(ws, tabId))
    const fileTabs = st.fileTabs.filter((tab) => tab.id !== tabId)
    this.patch({
      ...forgottenPanes(patch, st, tabId),
      ...(fileTabs.length !== st.fileTabs.length ? { fileTabs } : {}),
    })
    // TAB RELEASE (POD-4435): a session tab actually closed (not a file tab,
    // which carries no session). The server answers it through the shell
    // lifetime policy — an untouched shell dies, a used one stays. Only when
    // the tab held a session: file tabs report nothing.
    if (!isFile) this.ports.hub.reportTabRelease(tabId as SessionId)
  }

  @actionBound
  moveWorkspaceTab(...parameters: [tabId: TabId, toPaneId: PaneId, toIndex: number]): void {
    const [tabId, toPaneId, toIndex] = parameters
    this.editWorkspace((ws) => moveTab(ws, tabId, toPaneId, toIndex))
  }

  @actionBound
  splitWorkspacePane(
    ...parameters: [paneId: PaneId, axis: SplitAxis, opts?: { tabId?: TabId }]
  ): void {
    const [paneId, axis, opts] = parameters
    this.editWorkspace((ws) => splitPane(ws, paneId, axis, opts))
  }

  @actionBound
  closeWorkspacePane(...parameters: [paneId: PaneId]): void {
    const [paneId] = parameters
    this.editWorkspace((ws) => closePane(ws, paneId))
  }

  @actionBound
  focusWorkspacePane(...parameters: [paneId: PaneId]): void {
    const [paneId] = parameters
    this.editWorkspace((ws) => focusPane(ws, paneId))
  }

  @actionBound
  resizeWorkspaceSplit(...parameters: [path: readonly number[], sizes: readonly number[]]): void {
    const [path, sizes] = parameters
    this.editWorkspace((ws) => resizeSplit(ws, path, sizes))
  }

  @actionBound
  setFocusedPane(...parameters: [pane: 'A' | 'B']): void {
    const [focusedPane] = parameters
    const leaves = leafPaneIds(this.workspace.root)
    const paneId = focusedPane === 'B' ? leaves[1] : leaves[0]
    if (paneId) this.focusWorkspacePane(paneId)
  }

  @actionBound
  async focusIssueSession(
    ...parameters: [
      issueId: IssueId,
      opts?: { timeoutMs?: number; excludeSessionIds?: readonly SessionId[] },
    ]
  ): Promise<SessionId | null> {
    const [issueId, opts] = parameters

    const excluded = new Set(opts?.excludeSessionIds ?? [])
    this.patch({ selectedIssueId: issueId })
    const session = await waitForState(
      (listener) => {
        let stopRows: (() => void) | undefined
        const arm = () => {
          stopRows?.()
          const navigation = this.navigation
          stopRows = navigation.watch?.(
            () => [navigation.issue(issueId), navigation.issueSessions?.(issueId)],
            listener,
          )
        }
        arm()
        const stopLocal = this.onChange(['selectedIssueId', 'navigation'], () => {
          arm()
          listener()
        })
        return () => {
          stopRows?.()
          stopLocal()
        }
      },
      () => {
        const st = this.screen
        const issue = st.navigation.issue(issueId)
        if (!issue || issue === NAVIGATION_LOADING) return undefined
        const rows = st.navigation.issueSessions?.(issueId)
        if (!rows || rows === NAVIGATION_LOADING || st.selectedIssueId !== issueId) return undefined
        return rows.find(
          (candidate) =>
            candidate.issueId === issueId &&
            !candidate.archived &&
            !excluded.has(candidate.sessionId),
        )
      },
      opts?.timeoutMs ?? ISSUE_SESSION_WAIT_MS,
    )
    if (!this.alive || !session || this.selectedIssueId !== issueId) return null
    this.navigateToSession(session.sessionId)
    return session.sessionId
  }

  @actionBound
  setPanelMode(...parameters: [sessionId: SessionId, mode: 'chat' | 'native']): void {
    const [sessionId, mode] = parameters

    const panelMode = this.panelMode
    if (panelMode[sessionId] !== mode)
      this.patch({ panelMode: { ...panelMode, [sessionId]: mode } })
  }

  @actionBound
  preferPanelMode(...parameters: [sessionId: SessionId, mode: 'chat' | 'native']): void {
    const [sessionId, mode] = parameters

    const panelMode = this.panelMode
    if (panelMode[sessionId] !== undefined) return
    this.patch({ panelMode: { ...panelMode, [sessionId]: mode } })
  }

  @actionBound
  setDockVisibleSession(...parameters: [sessionId: SessionId | null]): void {
    const [dockVisibleSession] = parameters
    this.patch({ dockVisibleSession })
  }

  @actionBound
  setDockShell(...parameters: [worktreePath: string, sessionId: SessionId | null]): void {
    const [worktreePath, sessionId] = parameters

    const current = this.dockShells
    if ((current[worktreePath] ?? null) === sessionId) return
    const dockShells = { ...current }
    if (sessionId) dockShells[worktreePath] = sessionId
    else delete dockShells[worktreePath]
    this.patch({ dockShells })
  }

  @actionBound
  toggleSplit(...parameters: []): void {
    const leaves = leafPaneIds(currentWorkspace(this.screen).root)
    if (leaves.length < 2) {
      this.editWorkspace((ws) => splitPane(ws, ws.focusedPaneId, 'row'))
      return
    }
    this.editWorkspace((ws) => leaves.slice(1).reduce((acc, paneId) => closePane(acc, paneId), ws))
  }

  @actionBound
  openFile(...parameters: [sessionId: SessionId, path: string]): void {
    const [sessionId, path] = parameters

    const scope: FileScope = { kind: 'session', sessionId }
    const id = tabIdFor(scope, path)
    const state = this.screen
    const rawSession = state.navigation.session(sessionId)
    const session = rawSession === NAVIGATION_LOADING ? undefined : rawSession
    const cwd = session?.cwd ?? ''
    const worktreePath =
      reposToViews(this.ports.repositories())
        .flatMap((repo) => repo.worktrees)
        .map((candidate) => candidate.path)
        .filter((candidate) => isMachinePathWithinRoot(candidate, cwd))
        .sort((a, b) => b.length - a.length)[0] ?? cwd
    const existing = state.fileTabs.find((tab) => tab.id === id)
    const issueId = existing
      ? existing.issueId
      : (session?.issueId ?? state.selectedIssueId ?? undefined)
    this.revealFileTab({
      tabId: id,
      ...(worktreePath ? { worktreePath } : {}),
      ...(issueId ? { issueId } : {}),
      fileTab: existing ?? { id, scope, path, worktreePath, ...(issueId ? { issueId } : {}) },
      recentFile: {
        path,
        worktreePath,
        ...(session?.machineId ? { machineId: session.machineId } : {}),
      },
    })
  }

  @actionBound
  openFileInWorktree(
    ...parameters: [
      args: {
        machineId?: MachineId
        root: string
        path: string
        issueId?: IssueId
        permanent?: boolean
      },
    ]
  ): void {
    const [args] = parameters

    const scope: FileScope = { kind: 'worktree', machineId: args.machineId, root: args.root }
    const id = tabIdFor(scope, args.path)
    const state = this.screen
    const existing = state.fileTabs.find((tab) => tab.id === id)
    const issueId = existing
      ? existing.issueId
      : (args.issueId ?? state.selectedIssueId ?? undefined)
    this.revealFileTab({
      tabId: id,
      worktreePath: args.root,
      ...(issueId ? { issueId } : {}),
      ...(args.permanent === false ? { permanent: false } : {}),
      fileTab: existing ?? {
        id,
        scope,
        path: args.path,
        worktreePath: args.root,
        ...(issueId ? { issueId } : {}),
      },
      recentFile: {
        path: args.path,
        worktreePath: args.root,
        ...(args.machineId ? { machineId: args.machineId } : {}),
      },
    })
  }

  @actionBound
  openArtifact(
    ...parameters: [
      args: {
        issueId: IssueId
        artifactId: ArtifactId
        path: string
        worktreePath?: string
      },
    ]
  ): void {
    const [args] = parameters

    const scope: FileScope = {
      kind: 'artifact',
      issueId: args.issueId,
      artifactId: args.artifactId,
    }
    const id = tabIdFor(scope, args.path)
    this.revealFileTab({
      tabId: id,
      issueId: args.issueId,
      ...(args.worktreePath ? { worktreePath: args.worktreePath } : {}),
      fileTab: {
        id,
        scope,
        path: args.path,
        worktreePath: args.worktreePath ?? '',
        issueId: args.issueId,
      },
      recentFile: {
        path: args.path,
        worktreePath: args.worktreePath ?? '',
        artifact: { issueId: args.issueId, artifactId: args.artifactId },
      },
    })
  }

  @actionBound forgetSession(sessionId: SessionId): void {
    this.patch({
      ...forgetTab(this.screen, sessionId),
      fileTabs: this.fileTabList.filter(
        (tab) => tab.scope.kind !== 'session' || tab.scope.sessionId !== sessionId,
      ),
    })
  }
  @actionBound
  closeFileTab(...parameters: [id: string]): void {
    const [id] = parameters

    const state = this.screen
    this.patch({
      // The WHOLE mirror, not a hand-picked `workspaces`/`paneA`/`paneB`:
      // dropping `split`/`focusedPane` left the layout saying one pane and
      // the scalars saying two, with no later write able to correct it.
      ...forgottenPanes(forgetTab(state, id), state, id),
      fileTabs: state.fileTabs.filter((tab) => tab.id !== id),
    })
  }
}
