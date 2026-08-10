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
import {
  allTabIds,
  type DockTab,
  EMPTY_PINS,
  emptyWorkspace,
  type FileTab,
  leafPaneIds,
  missionRootFor,
  type PinState,
  type RecentFileEntry,
  type WorkspaceKey,
  type WorkspaceLayout,
  type WorkspaceMap,
  workspaceKeyFor,
} from '../viewmodels'
import type { SuperThreadView } from '../viewmodels/slices/superagent'
import { EMPTY_ID_SET } from './overlay'
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
  /** The signed-in user's superagent threads, published by the store (POD-330,
   *  audit item zero). The view no longer keeps its own copy. */
  superThreads: SuperThreadView[]
  paletteOpen: boolean
  selectedWorktree: string | null
  selectedIssueId: IssueId | null
  /**
   * Editor-style tab workspaces (POD-710), one per task in the left sidebar,
   * keyed by {@link workspaceKeyForState}. THE source of truth for what is open:
   * `paneA` / `paneB` / `split` / `focusedPane` below are derived mirrors of it
   * (see {@link workspaceMirrorPatch}).
   */
  workspaces: WorkspaceMap
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
  /**
   * A COARSE CLOCK, in the snapshot on purpose (POD-331).
   *
   * Some published derivations are functions of time as well as of rows: a
   * snooze lapses, a session goes stale, recency reorders. `sidebarSections`
   * takes `now` for exactly that reason and feeds it to `isSnoozed` and
   * `compareRecency`.
   *
   * The slice publisher keys on SNAPSHOT IDENTITY and nothing else, which is
   * the property that makes it correct across evict and rescope
   * (`slices/publish.ts`). A derivation that read the clock out of band would
   * therefore be memoized against a clock that had moved: on a quiet system
   * with no publishes, an overnight snooze would never lapse on screen. The
   * fix is not to weaken the cache key — it is to admit that the clock is part
   * of the world these views render, so a new minute is a new snapshot.
   *
   * Minute granularity, one interval per RUNTIME. It replaces N per-component
   * `useNow` intervals that each ticked on their own phase, so two surfaces
   * could disagree about what time it was; now they cannot.
   */
  coarseNow: number
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

// ---------------------------------------------------------------------------
// Workspaces (POD-710)
// ---------------------------------------------------------------------------

/** The fields a workspace write touches: the layouts themselves and the four
 *  pane scalars they are mirrored into. Narrower than `Partial<EngineState>` so
 *  it can be applied to the action surface's state as well as the engine's. */
export interface WorkspacePatch {
  workspaces?: WorkspaceMap
  paneA?: SessionId | null
  paneB?: SessionId | null
  split?: boolean
  focusedPane?: 'A' | 'B'
}

/** The selection a workspace key is computed from. */
export type WorkspaceSelection = Pick<
  EngineState,
  'issues' | 'selectedIssueId' | 'selectedWorktree'
>

/**
 * WHICH WORKSPACE IS ON SCREEN — the one key everything else agrees on.
 *
 * The mission root wins over the selected sub-issue because a mission shares one
 * tab strip: selecting a task inside it must not swap the strip for an empty
 * one. This mirrors what `Workspace.tsx` has always computed inline; it lives
 * here so the engine and the view cannot disagree about which task's tabs they
 * are writing.
 */
export function workspaceKeyForState(st: WorkspaceSelection): WorkspaceKey {
  const selected = st.selectedIssueId
    ? st.issues.find((i) => i.id === st.selectedIssueId && !i.archived && !i.deletedAt)
    : undefined
  const root = selected ? missionRootFor(st.issues, selected.id) : undefined
  return workspaceKeyFor({
    missionRootId: root?.id ?? null,
    issueId: st.selectedIssueId,
    worktreePath: st.selectedWorktree,
  })
}

/** The layout for a key — always a layout, never undefined, so no caller has to
 *  invent the empty case. */
export function workspaceFor(
  st: Pick<EngineState, 'workspaces'>,
  key: WorkspaceKey,
): WorkspaceLayout {
  return st.workspaces[key] ?? emptyWorkspace(key)
}

/** The workspace the operator is looking at. */
export function currentWorkspace(
  st: WorkspaceSelection & Pick<EngineState, 'workspaces'>,
): WorkspaceLayout {
  return workspaceFor(st, workspaceKeyForState(st))
}

const leafCount = (ws: WorkspaceLayout | undefined): number =>
  ws ? leafPaneIds(ws.root).length : 0

/**
 * THE DERIVED MIRROR — `paneA` / `paneB` / `split` / `focusedPane` from a layout.
 *
 * These four scalars have consumers well outside the tab strip (the `?pane=`
 * route param, the PTY-relay priority in {@link userFocus}, the warm set,
 * `use-unified-work`, the flight deck), so POD-710 keeps them rather than
 * rewriting every one: the layout is the truth and these are recomputed on every
 * layout write.
 *
 * ONE COMPATIBILITY CLAUSE. `split` and `paneB` are still WRITTEN directly by
 * the pre-POD-710 surface — `toggleSplit` and `setPane('B', …)` — and until the
 * split UI is rebuilt on panes (wave 2) a single-leaf layout has no opinion
 * about them. So a write that neither produces nor leaves a real second pane
 * mirrors `paneA` only, instead of zeroing a second pane the operator can still
 * see. Any layout that has, or just had, ≥2 leaves mirrors all four.
 */
export function workspaceMirrorPatch(
  next: WorkspaceLayout,
  prev: WorkspaceLayout | undefined,
): WorkspacePatch {
  const leaves = leafPaneIds(next.root)
  const activeOf = (paneId: string | undefined): SessionId | null => {
    const id = paneId ? (next.panes[paneId]?.activeTabId ?? null) : null
    // Tab ids carry file tabs too; the pane scalars have always been typed as
    // session ids and read as opaque tab ids (see revealFileTab).
    return id === null ? null : (id as SessionId)
  }
  const paneA = activeOf(leaves[0])
  if (leaves.length < 2 && leafCount(prev) < 2) return { paneA, focusedPane: 'A' }
  return {
    paneA,
    paneB: activeOf(leaves[1]),
    split: leaves.length >= 2,
    focusedPane: leaves[1] !== undefined && next.focusedPaneId === leaves[1] ? 'B' : 'A',
  }
}

/**
 * The patch for ONE layout write: the workspace entry plus its mirror. Returns
 * an empty patch when the reducer was a no-op, so an inert action publishes no
 * snapshot at all.
 *
 * `prevKey` differs from `key` only when the workspace itself is changing (a
 * task switch); the mirror needs the layout leaving the screen to decide whether
 * a second pane is going away.
 */
export function workspaceWritePatch(
  st: Pick<EngineState, 'workspaces'>,
  key: WorkspaceKey,
  next: WorkspaceLayout,
  prevKey: WorkspaceKey = key,
): WorkspacePatch {
  const mirror = workspaceMirrorPatch(next, st.workspaces[prevKey])
  const current = st.workspaces[key]
  // A key nobody has opened anything in stays ABSENT: a no-op action on a fresh
  // task must not persist an empty layout for every task ever selected.
  const vacuous =
    current === undefined && leafPaneIds(next.root).length === 1 && allTabIds(next).length === 0
  if (current === next || vacuous) return mirror
  return { workspaces: { ...st.workspaces, [key]: next }, ...mirror }
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
    workspaces: st.workspaces,
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

/** Everything the first snapshot needs that the runtime has to gather first:
 *  the hydrated UI state, the current route, the replica's seed rows already
 *  folded through the optimistic ledger, and the outbox's restored recovery
 *  home. */
export interface EngineStateSeed {
  readonly persisted: WorkspaceUiSnapshot
  readonly route: { settingsTab: string | null; issueId?: string | null }
  readonly sessions: SessionMeta[]
  readonly issues: IssueWire[]
  readonly issueProjections: IssueProjectionRow[]
  readonly conversations: ConversationSummaryWire[]
  readonly automations: AutomationWire[]
  readonly automationRuns: AutomationRunWire[]
  readonly outboxDeadLetters: OutboxDeadLetterEntry[]
  readonly recoverOutbox: Store['recoverOutbox']
  /** Seed for the coarse clock (see {@link EngineState.coarseNow}). Injected
   *  rather than read here so a test can pin it. */
  readonly now: number
}

/**
 * The FIRST snapshot, hydrate-first (#262 review).
 *
 * The replica's collections load synchronous storage at construction, so the
 * entity slices are seeded from them BEFORE any subscriber reads — an empty
 * initial snapshot regressed persisted rows into "not found" flashes until
 * start() (a passive effect) ran. The same reasoning covers the queued outbox
 * overlays and the restored dead letters: anything already durable belongs in
 * the very first paint, or it appears to have been lost.
 *
 * It is a pure function of the seed so the shape and its initial value live
 * together — a field added to `EngineState` without an initial value here is a
 * compile error rather than an `undefined` that shows up as a blank pane.
 */
export function initialEngineState(seed: EngineStateSeed): EngineState {
  return {
    repos: [],
    reposLoading: false,
    reposLoaded: false,
    repoDiagnostics: [],
    sessions: seed.sessions,
    issues: seed.issues,
    issueProjections: seed.issueProjections,
    conversations: seed.conversations,
    automations: seed.automations,
    automationRuns: seed.automationRuns,
    pendingSpawnIds: EMPTY_ID_SET,
    hostMetrics: [],
    machines: [],
    approvals: [],
    pins: EMPTY_PINS,
    tabOrders: {},
    view: seed.persisted.view,
    settingsTab: seed.route.settingsTab,
    openIssueId: asIssueIdOrNull(seed.route.issueId),
    peekIssueId: null,
    superThreadId: 'global',
    // Default OPEN: the superagent is the desktop shell's center column now, not
    // an optional dock — only an explicit close ('0') keeps it collapsed.
    superOpen: seed.persisted.superOpen,
    dockTab: seed.persisted.dockTab,
    superThreads: [],
    paletteOpen: false,
    // Workspace pane state: a deep-linked ?wt= wins over the persisted selection.
    selectedWorktree: seed.persisted.selectedWorktree,
    selectedIssueId: seed.persisted.selectedIssueId,
    // Restored exactly, across task switches AND across reloads (POD-710). The
    // pane scalars below were flushed from the same layouts, so they already
    // agree with them and need no boot-time re-derivation.
    workspaces: seed.persisted.workspaces,
    // DECODE EDGE: the pane selection comes from the URL route or persisted UI
    // state — both raw strings — so this is where it re-enters the id space.
    paneA: seed.persisted.paneA,
    paneB: seed.persisted.paneB,
    split: seed.persisted.split,
    // Which pane has input focus. Not persisted — it resets to A on reload,
    // which is the right default (A is always the shown pane when split is off).
    focusedPane: 'A',
    panelMode: seed.persisted.panelMode,
    dockShells: seed.persisted.dockShells,
    dockVisibleSession: null,
    autoContinuePromptSessionId: null,
    drafts: {},
    sidebarSettings: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
    fileTabs: [],
    recentFiles: seed.persisted.recentFiles,
    outboxSize: 0,
    outboxDeadLetters: seed.outboxDeadLetters,
    recoverOutbox: seed.recoverOutbox,
    coarseNow: seed.now,
  }
}
