import {
  useClientRuntime,
  useCommands,
  useDeviceState,
  useHttpOrigin,
  useRequestClient,
  useSocketHub,
  useUi,
} from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { ScreenState } from '@podium/client-core/ui'
import { pendingApprovals } from '@podium/client-graph/approval-effects'
import type { EffectModel } from '@podium/client-graph/models'
import type { MobxPool } from '@podium/client-graph/pool'
import type { ShellDock, shellViews } from '@podium/client-graph/shell-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { allowImperativeRead, assertReactiveRead } from '@podium/mobx-helpers'
import type { MachineFacts } from '@podium/model/browser'
import { useMemo } from 'react'
import { useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** The lazy runtime installs this shared view before exposing its pool. */
function shellView(pool: MobxPool): ReturnType<typeof shellViews> {
  const view = pool.sources.peekView<ReturnType<typeof shellViews>>('shell-views')
  if (!view) throw new Error('Shell reads require their pool screen')
  return view
}

/** Identity-stable actions/transports only; the existing runtime remains the
 * mutation owner. Live values never come from this one-time acquisition. */
export function useShellActions() {
  const owner = useClientRuntime<Trpc>()
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const trpc = useRequestClient<Trpc>()
  const hub = useSocketHub()
  const httpOrigin = useHttpOrigin()
  const deviceState = useDeviceState()
  return useMemo(
    () => ({
      trpc: trpc,
      hub: hub,
      httpOrigin: httpOrigin,
      uiState: deviceState,
      navigateToSession: ui.navigateToSession,
      closeAutoContinuePrompt: owner.autoContinueDialog.close,
      setPreferences: commands.preferences.setPreferences,
      setSelectedIssueId: ui.setSelectedIssueId,
      setView: ui.setView,
      setSuperOpen: ui.setSuperOpen,
      setPaletteOpen: owner.palette.setOpen,
      setOpenIssueId: ui.setOpenIssueId,
      openArtifact: ui.openArtifact,
      openFileInWorktree: ui.openFileInWorktree,
      closeFileTab: ui.closeFileTab,
      closeWorkspaceTab: ui.closeWorkspaceTab,
      setSettingsTab: ui.setSettingsTab,
      decideApproval: commands.automations.decideApproval,
    }),
    [commands, ui, trpc, hub, httpOrigin, deviceState, owner],
  )
}
/** The right dock's routing view: an observer reads each field where it is
 * shown (`dock.active`, `dock.gitIssue`, `dock.mailIssueId`, `dock.scope`). */
export function useShellDock(): ShellDock | null {
  if (import.meta.env.DEV) assertReactiveRead('useShellDock')
  const pool = useWorklistPool()
  return pool ? shellView(pool).dock : null
}
const EMPTY_SHIPPING = { unfinishedCount: 0, decisionCount: 0 }
export function useShellShipping() {
  if (import.meta.env.DEV) assertReactiveRead('useShellShipping')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).dock.shipping : LOADING
  return value && value !== LOADING ? value : EMPTY_SHIPPING
}

export function useShellWindow() {
  if (import.meta.env.DEV) assertReactiveRead('useShellWindow')
  const owner = useClientRuntime<Trpc>(),
    ui = owner.ui
  return {
    get view() {
      return ui.view
    },
    get paneA() {
      return ui.paneA
    },
    get selectedIssueId() {
      return ui.selectedIssueId
    },
    get selectedWorktree() {
      return ui.selectedWorktree
    },
    get superOpen() {
      return ui.superOpen
    },
    get paletteOpen() {
      return owner.palette.open
    },
    get autoContinuePromptSessionId() {
      return owner.autoContinueDialog.sessionId
    },
  }
}
/** The agent requests waiting for this person, oldest first (POD-6674): the
 *  pool's `approval` effect models. */
export function useShellApprovals(): readonly EffectModel[] {
  if (import.meta.env.DEV) assertReactiveRead('useShellApprovals')
  const pool = useWorklistPool()
  return pool ? pendingApprovals(pool) : EMPTY_APPROVALS
}
const EMPTY_APPROVALS: readonly EffectModel[] = []

const EMPTY_SESSIONS: import('@podium/client-core/session-values').SessionView[] = []
export function useShellLinks() {
  const pool = useWorklistPool(),
    views = pool ? shellView(pool) : null
  return useMemo(
    () => ({
      readSession: (identifier: string) =>
        allowImperativeRead(() => {
          const session = views?.linkedSession(identifier)
          return session && session !== LOADING ? session : undefined
        }),
      readIssue: (identifier: string) =>
        allowImperativeRead(() => {
          const issue = views?.linkedIssue(identifier)
          return issue && issue !== LOADING ? issue : undefined
        }),
      artifactIssue: (id: string) =>
        allowImperativeRead(() => {
          const row = views?.issue(id, true)
          return row && row !== LOADING ? (row as IssueViewModel) : undefined
        }),
      pool,
    }),
    [pool, views],
  )
}
export function useShellSessionResolver() {
  const pool = useWorklistPool()
  return useMemo(
    () => (id: string) =>
      allowImperativeRead(() => {
        const value = pool ? shellView(pool).session(id) : undefined
        return value && value !== LOADING ? value : undefined
      }),
    [pool],
  )
}
export function useShellSessions() {
  if (import.meta.env.DEV) assertReactiveRead('useShellSessions')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).sessions() : LOADING
  return value && value !== LOADING ? value : EMPTY_SESSIONS
}

export function useShellClose() {
  if (import.meta.env.DEV) assertReactiveRead('useShellClose')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).close() : LOADING
  return value && value !== LOADING ? value : undefined
}
const EMPTY_MACHINES: MachineFacts[] = []
export function useShellMachines() {
  if (import.meta.env.DEV) assertReactiveRead('useShellMachines')
  const pool = useWorklistPool()
  return pool ? shellView(pool).machines() : EMPTY_MACHINES
}

const EMPTY_CHROME = {
  view: 'workspace' as ScreenState['view'],
  reposLoaded: false,
  superOpen: false,
  paletteOpen: false,
  repoCount: 0,
  worktreeCount: 0,
  sessionCount: 0,
  selectedIssueId: null as ScreenState['selectedIssueId'],
  missionRoot: undefined as IssueViewModel | undefined,
  /** False while the snapshot loads: every field above is then a placeholder,
   *  not an answer (a cold selection reads as "no mission"). */
  settled: false,
}
export function useShellChrome() {
  if (import.meta.env.DEV) assertReactiveRead('useShellChrome')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).chrome() : LOADING
  const owner = useClientRuntime<Trpc>(),
    ui = owner.ui
  return {
    ...(value && value !== LOADING ? { ...value, settled: true } : EMPTY_CHROME),
    view: ui.view,
    selectedIssueId: ui.selectedIssueId,
    paletteOpen: owner.palette.open,
    superOpen: ui.superOpen,
  }
}
