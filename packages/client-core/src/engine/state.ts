/**
 * The client runtime's STATE SHAPE and the pure derivations over it (POD-404).
 *
 * Split out of the old `engine.ts` god file. Everything here is a total function
 * of `EngineState` — no timers, no network, no subscriptions — so the
 * derivations that the reaction table and the action surface both need (which
 * pane is focused, which issue is in the foreground, what the operator is
 * looking at) have ONE definition instead of a copy per caller.
 *
 * Under multi-user (docs/multi-user-readiness.md §3.1) these derive over the
 * PRINCIPAL'S SLICE, not the world: `sessions` / `issues` / `issueProjections`
 * can SHRINK under an evict and be REBUILT under a rescope without any row's
 * revision moving. Nothing in this file may treat a referenced-but-absent id as
 * "late" — every lookup below is a `find` whose miss is a legitimate,
 * steady-state answer (the row is invisible to this principal), never a reason
 * to wait for it to arrive.
 */

import type {
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
import { asIssueId } from '@podium/model'
import type { ApprovalWire } from '@podium/protocol'
import type { Sidebar as SidebarSettings } from '@podium/runtime'
import type { PodiumClientApi } from '../api'
import type { OutboxDeadLetterEntry } from '../outbox'
import type { IssueProjectionRow } from '../replica/contract'
import type { MainView, WorkspaceUiSnapshot } from '../ui-state'
import type { DockTab, FileTab, PinState, RecentFileEntry } from '../viewmodels'
import type { Store, UserFocus } from './types'

/** The runtime's mutable data slices — exactly the non-function fields of Store
 *  that change over time (constants like hub/trpc/replica live outside it). */
export interface EngineState {
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

/** The store fields that are NOT state: action methods and constant handles,
 *  spread into every snapshot so their identities never change. */
export type EngineStatics<TApi extends PodiumClientApi> = Omit<Store<TApi>, keyof EngineState>

/** Narrow a raw route/persisted value into the issue id space (POD-363). The URL
 *  route and local state hand back raw strings, and this is the one
 *  place they re-enter the id space — so the store's issue-selection surface can
 *  be branded end to end without a cast at every consumer. */
export const asIssueIdOrNull = (v: string | null | undefined): IssueId | null =>
  v ? asIssueId(v) : null

export const tabIsVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

/** The stamp the server's issue-unread compares against read_at: the issue's own
 *  updatedAt, or a member session's activity when that is newer. Mirrors the
 *  server's computeUnread so the client reacts to exactly the same events. */
export function issueActivityAt(issue: IssueWire, sessions: SessionMeta[]): string {
  let latest = issue.updatedAt
  for (const s of sessions) {
    if ((s.issueId ?? null) === issue.id && s.lastActiveAt > latest) latest = s.lastActiveAt
  }
  return latest
}

/** Which pane the operator is typing into. `focusedPane` clamps to A when split
 *  is off — B is not on screen then and must never be reported as focused. */
export function focusedPaneSession(st: EngineState): SessionId | null {
  return st.split ? (st.focusedPane === 'A' ? st.paneA : st.paneB) : st.paneA
}

/** The issue in the FOREGROUND: the open issue page, or the issue whose
 *  sessions the workspace is showing. Any other surface has none.
 *
 *  A miss is final, not pending: under a scoped slice the selected issue may
 *  simply not be visible to this principal. */
export function foregroundIssue(st: EngineState): IssueWire | undefined {
  const id =
    st.view === 'issues' ? st.openIssueId : st.view === 'workspace' ? st.selectedIssueId : null
  return id ? st.issues.find((i) => i.id === id) : undefined
}

/** The UI-state module's view of the workspace — the single input to routing,
 *  persistence and the URL mirror. */
export function workspaceUiSnapshot(st: EngineState): WorkspaceUiSnapshot {
  return {
    view: st.view,
    selectedWorktree: st.selectedWorktree,
    selectedIssueId: st.selectedIssueId,
    dockTab: st.dockTab,
    paneA: st.paneA,
    paneB: st.paneB,
    split: st.split,
    superOpen: st.superOpen,
    panelMode: st.panelMode,
    dockShells: st.dockShells,
    recentFiles: st.recentFiles,
  }
}

/** What this client is looking at, for the server's PTY relay priority and the
 *  notification router. Ids that are not sessions in the CURRENT slice are
 *  dropped rather than reported. */
export function userFocus(st: EngineState): UserFocus {
  const paneIds = [st.paneA, st.split ? st.paneB : null].filter((x): x is SessionId => x != null)
  const focusedId = focusedPaneSession(st)
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
