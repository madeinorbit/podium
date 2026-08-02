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
  SessionId,
  SessionMeta,
  WorkState,
} from '@podium/model'
import { resolveSessionIdentifier } from '@podium/protocol'
import { type Sidebar as SidebarSettings, shouldPromptAutoContinue } from '@podium/runtime'
import type { PodiumClientApi } from '../api'
import type { Router } from '../router'
import { routeDefaults } from '../router'
import type { SocketHub } from '../socket-transport'
import type { SpawnTarget } from '../spawn-agent'
import type { DockTab, FileScope, FileTab, PinKind, PinState, RecentFileEntry } from '../viewmodels'
import { reposToViews, tabIdFor } from '../viewmodels'
import {
  createReplicatedLayoutController,
  type ReplicatedLayoutController,
} from './replicated-layout'
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
  'setPeekIssueId',
  'setSuperThreadId',
  'setSuperOpen',
  'setPaletteOpen',
  'setSelectedWorktree',
  'setSelectedIssueId',
  'setPane',
  'setFocusedPane',
  'navigateToSession',
  'setDockTab',
  'setPanelMode',
  'setDockShell',
  'setDockVisibleSession',
  'setPanelRenderMode',
  'toggleSplit',
  'openFile',
  'openFileInWorktree',
  'openArtifact',
  'closeFileTab',
  'closeAutoContinuePrompt',
] as const

/** Replicated/domain writes. Some are online-only by their command contract. */
export const COMMAND_ACTIONS = [
  'setPinned',
  'setTabOrder',
  'startBtw',
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
  'setWorkState',
  'setSnooze',
  'clearSnooze',
  'markSessionRead',
  'markSessionUnread',
  'markIssueRead',
  'markIssueUnread',
  'setIssueTucked',
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
  state(): Readonly<ActionState>
  apply(patch: Partial<ActionState>): void
  enqueueOverlayed<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): void
  revealFileTab(args: { tabId: string; worktreePath?: string; issueId?: IssueId }): void
  recordRecentFile(entry: Omit<RecentFileEntry, 'openedAt'>): void
  setPanelRenderMode(sessionId: SessionId, mode: 'chat' | 'native'): void
  spawnDraftAgent(args: { target: SpawnTarget; agentKind: AgentKind; firstPrompt?: string }): {
    sessionId: SessionId
    issueId: IssueId
  }
  setSessionDraft(sessionId: SessionId, text: string): void
}

function reducePin(state: PinState, kind: PinKind, id: string, pinned: boolean): PinState {
  const key = kind === 'panel' ? 'panels' : kind === 'worktree' ? 'worktrees' : 'repos'
  const values = state[key].filter((candidate) => candidate !== id)
  return { ...state, [key]: pinned ? [...values, id] : values }
}

export function createEngineActions<TApi extends PodiumClientApi>(
  rt: EngineActionRuntime<TApi>,
): EngineActions<TApi> {
  const api = rt.api
  const replicatedLayout = createReplicatedLayoutController({
    outbox: rt.outbox,
    notices: rt.notices,
  })
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
    setPeekIssueId: (peekIssueId) => rt.apply({ peekIssueId }),
    setSuperThreadId: (superThreadId) => rt.apply({ superThreadId }),
    setSuperOpen: (superOpen) => rt.apply({ superOpen }),
    setDockTab: (dockTab) => rt.apply({ dockTab }),
    startBtw: async (sessionId) => {
      rt.apply({ superThreadId: `btw_${sessionId}`, superOpen: true })
      await api.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      rt.apply({ superRefreshKey: rt.state().superRefreshKey + 1 })
    },
    tldrSession: async (sessionId, answerText) => {
      const threadId = `btw_${sessionId}`
      rt.apply({ superThreadId: threadId, superOpen: true })
      await api.superagent.startBtw.mutate({ sessionId }).catch(() => {})
      const prompt = answerText.trim()
        ? `Give me a concise tl;dr (2–4 bullet points) of the agent's last answer below.\n\n---\n${answerText.trim().slice(0, 4000)}`
        : "Give me a concise tl;dr (2–4 bullet points) of the agent's last answer."
      await api.superagent.sendTurn.mutate({ threadId, text: prompt }).catch(() => {})
      rt.apply({ superRefreshKey: rt.state().superRefreshKey + 1 })
    },
    setPaletteOpen: (paletteOpen) => rt.apply({ paletteOpen }),
    setSelectedWorktree: (selectedWorktree) => rt.apply({ selectedWorktree }),
    setSelectedIssueId: (selectedIssueId) => rt.apply({ selectedIssueId }),
    setPane: (pane, id) =>
      rt.apply(pane === 'A' ? { paneA: id, focusedPane: pane } : { paneB: id, focusedPane: pane }),
    setFocusedPane: (focusedPane) => rt.apply({ focusedPane }),
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
      rt.apply({
        ...(meta.issueId ? { selectedIssueId: meta.issueId } : {}),
        ...(worktree ? { selectedWorktree: worktree } : {}),
        paneA: meta.sessionId,
        focusedPane: 'A',
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
    setPanelRenderMode: (sessionId, mode) => rt.setPanelRenderMode(sessionId, mode),
    toggleSplit: () => rt.apply({ split: !rt.state().split }),
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
      rt.revealFileTab({ tabId: id, worktreePath: args.root, ...(issueId ? { issueId } : {}) })
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
        fileTabs: state.fileTabs.filter((tab) => tab.id !== id),
        paneA: state.paneA === id ? null : state.paneA,
        paneB: state.paneB === id ? null : state.paneB,
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
      rt.apply({
        fileTabs: state.fileTabs.filter(
          (tab) => !(tab.scope.kind === 'session' && tab.scope.sessionId === sessionId),
        ),
        paneA: state.paneA === sessionId ? null : state.paneA,
        paneB: state.paneB === sessionId ? null : state.paneB,
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
      } catch (error) {
        rt.notices.error(
          `Couldn't resume the session — ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
    },
    resumeAndSend: async (sessionId, text) => {
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
    setWorkState: async (sessionId: SessionId, workState: WorkState | null) =>
      rt.enqueueOverlayed('setWorkState', { sessionId, workState }),
    setSnooze: async (sessionId, until) => rt.enqueueOverlayed('snoozeSet', { sessionId, until }),
    clearSnooze: async (sessionId) => rt.enqueueOverlayed('snoozeClear', { sessionId }),
    markSessionRead: async (sessionId) => rt.enqueueOverlayed('sessionMarkRead', { sessionId }),
    markSessionUnread: async (sessionId) => rt.enqueueOverlayed('sessionMarkUnread', { sessionId }),
    markIssueRead: async (id) => rt.enqueueOverlayed('issueMarkRead', { id }),
    markIssueUnread: async (id) => rt.enqueueOverlayed('issueMarkUnread', { id }),
    setIssueTucked: async (id, tucked) => rt.enqueueOverlayed('issueSetTucked', { id, tucked }),
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
