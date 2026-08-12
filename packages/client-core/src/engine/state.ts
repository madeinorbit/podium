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
  IssueEventWire,
  IssueWire,
  MachineWire,
  SessionId,
  SessionMeta,
  ThreadId,
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
  /** The curated cross-project issue-event window (POD-1772) — replicated rows,
   *  not a timer's answer. Newest last, as the feed renders them. */
  issueEvents: IssueEventWire[]
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
  superThreadId: ThreadId
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
  /**
   * WHAT THE VIEW SAYS IT IS RENDERING — told, not read (POD-710).
   *
   * A layout keeps its panes when `tab-splitting` is turned off; the web then
   * renders the first leaf ONLY and leaves the tree alone. The engine must not
   * read a feature flag, but it also must not report a pane nobody can see: a
   * hidden pane's session would take PTY-relay priority and have its unread
   * badge cleared by the mark-read reaction (POD-710 review, item 9).
   *
   * So the surface that owns the flag TELLS us, through `setSplitEnabled`, and
   * everything that answers "what is on screen" ({@link visibleTabIds},
   * {@link focusedPaneSession}, {@link userFocus}, `reportViewState`) consults
   * this one field. Default `false`: until a view has said otherwise, the
   * conservative answer is that only the first pane is showing.
   */
  splitEnabled: boolean
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

/** The stamp issue-unread compares against read_at: this issue's updatedAt, any
 *  descendant's updatedAt, and every session in the subtree. Mirrors the
 *  sidebar/collapsed rollup so remake-on-view sees the same activity the row
 *  does (POD-912). */
export function issueActivityAt(
  issue: Pick<IssueWire, 'id' | 'updatedAt'>,
  sessions: SessionMeta[],
  issues: readonly Pick<IssueWire, 'id' | 'parentId' | 'updatedAt'>[] = [],
): string {
  const subtree = new Set<string>([issue.id])
  let grew = true
  while (grew) {
    grew = false
    for (const other of issues) {
      if (other.parentId && subtree.has(other.parentId) && !subtree.has(other.id)) {
        subtree.add(other.id)
        grew = true
      }
    }
  }
  let latest = issue.updatedAt
  for (const other of issues) {
    if (subtree.has(other.id) && other.updatedAt > latest) latest = other.updatedAt
  }
  for (const session of sessions) {
    if (session.issueId && subtree.has(session.issueId) && session.lastActiveAt > latest) {
      latest = session.lastActiveAt
    }
  }
  return latest
}

/**
 * The panes the operator can actually SEE, in strip order.
 *
 * The layout's leaves minus the ones the view is not rendering: with splitting
 * switched off a preserved split layout still shows its first leaf only (see
 * {@link EngineState.splitEnabled}). Every "what is on screen" derivation walks
 * this, so they cannot disagree about a third pane or a hidden one.
 */
export function visibleLeafPaneIds(st: EngineState): string[] {
  const leaves = leafPaneIds(currentWorkspace(st).root)
  return st.splitEnabled ? leaves : leaves.slice(0, 1)
}

/**
 * The tab ids on screen — one per visible pane, in strip order.
 *
 * The layout is the truth. The pane scalars are the fallback for exactly one
 * case: a workspace with nothing open in it at all, which is what a client
 * restored from a pre-POD-710 install has (persisted `paneA`, no persisted
 * layouts). Anything else reads the panes, so a hidden or third pane is
 * reported exactly as it is rendered.
 */
export function visibleTabIds(st: EngineState): SessionId[] {
  const ws = currentWorkspace(st)
  if (allTabIds(ws).length === 0) {
    return [st.paneA, st.split ? st.paneB : null].filter((id): id is SessionId => id != null)
  }
  return visibleLeafPaneIds(st)
    .map((paneId) => (ws.panes[paneId]?.activeTabId ?? null) as SessionId | null)
    .filter((id): id is SessionId => id != null)
}

/**
 * Which pane the operator is typing into.
 *
 * Answered from the LAYOUT, because `focusedPane` is a two-valued mirror and a
 * workspace may have more than two panes — focus on the third pane spells 'A',
 * which would report the FIRST pane's session. Focus that has landed on a pane
 * the view is not rendering falls back to the first visible one, so a layout
 * split with the flag on and then hidden reports the pane actually on screen.
 * The scalar path survives for the empty-workspace case {@link visibleTabIds}
 * describes.
 */
export function focusedPaneSession(st: EngineState): SessionId | null {
  const ws = currentWorkspace(st)
  if (allTabIds(ws).length === 0) {
    return st.split ? (st.focusedPane === 'A' ? st.paneA : st.paneB) : st.paneA
  }
  const visible = visibleLeafPaneIds(st)
  const paneId = visible.includes(ws.focusedPaneId) ? ws.focusedPaneId : visible[0]
  return paneId === undefined ? null : ((ws.panes[paneId]?.activeTabId ?? null) as SessionId | null)
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

/**
 * THE DERIVED MIRROR — `paneA` / `paneB` / `split` / `focusedPane` from a layout.
 *
 * These four scalars have consumers well outside the tab strip (the `?pane=`
 * route param, the PTY-relay priority in {@link userFocus}, the warm set,
 * `use-unified-work`, the flight deck), so POD-710 keeps them rather than
 * rewriting every one: the layout is the truth and these are recomputed on every
 * layout write.
 *
 * ALL FOUR, EVERY TIME. There used to be a compatibility clause here — a write
 * against a layout that neither had nor just had two leaves mirrored `paneA`
 * only — because `toggleSplit` and `setPane('B', …)` still wrote `split` and
 * `paneB` as raw scalars and a full mirror would have zeroed a pane the
 * operator could see. Both are adapters over the layout now (POD-710 wave 2),
 * so the layout is the only writer and a partial mirror is pure hazard: a write
 * that computed `split: false` but did not APPLY it left a phantom second pane
 * that no later write could ever clear, because the clause kept firing.
 */
export function workspaceMirrorPatch(next: WorkspaceLayout): WorkspacePatch {
  const leaves = leafPaneIds(next.root)
  const activeOf = (paneId: string | undefined): SessionId | null => {
    const id = paneId ? (next.panes[paneId]?.activeTabId ?? null) : null
    // Tab ids carry file tabs too; the pane scalars have always been typed as
    // session ids and read as opaque tab ids (see revealFileTab).
    return id === null ? null : (id as SessionId)
  }
  return {
    paneA: activeOf(leaves[0]),
    paneB: activeOf(leaves[1]),
    split: leaves.length >= 2,
    focusedPane: leaves[1] !== undefined && next.focusedPaneId === leaves[1] ? 'B' : 'A',
  }
}

/**
 * Apply a reducer to EVERY workspace and mirror the one on screen.
 *
 * Used where the thing behind a tab is gone — a killed session, a closed file,
 * a pruned ghost — which is the only reason a tab may disappear from a
 * workspace the operator is not looking at. Returns an empty patch when nothing
 * moved, so an inert pass publishes no snapshot at all.
 */
export function workspacesPatch(
  st: WorkspaceSelection & Pick<EngineState, 'workspaces'>,
  reduce: (ws: WorkspaceLayout) => WorkspaceLayout,
): WorkspacePatch {
  const workspaces: WorkspaceMap = {}
  let changed = false
  for (const [key, ws] of Object.entries(st.workspaces)) {
    const next = reduce(ws)
    if (next !== ws) changed = true
    workspaces[key] = next
  }
  if (!changed) return {}
  const key = workspaceKeyForState(st)
  const current = workspaces[key]
  return { workspaces, ...(current ? workspaceMirrorPatch(current) : {}) }
}

/**
 * The patch for ONE layout write: the workspace entry plus its mirror. Returns
 * an empty patch when the reducer was a no-op, so an inert action publishes no
 * snapshot at all.
 */
export function workspaceWritePatch(
  st: Pick<EngineState, 'workspaces'>,
  key: WorkspaceKey,
  next: WorkspaceLayout,
): WorkspacePatch {
  const mirror = workspaceMirrorPatch(next)
  const current = st.workspaces[key]
  // A key nobody has opened anything in stays ABSENT: a no-op action on a fresh
  // task must not persist an empty layout for every task ever selected.
  const vacuous =
    current === undefined && leafPaneIds(next.root).length === 1 && allTabIds(next).length === 0
  if (current === next || vacuous) return mirror
  return { workspaces: { ...st.workspaces, [key]: next }, ...mirror }
}

/**
 * Every tab id that names something which EXISTS right now: a session in this
 * principal's slice (optimistic spawns included — `sessions` is already folded
 * through the ledger), a spawn still in flight, or an open file buffer.
 *
 * The input to pruning, and the reason pruning cannot be a one-liner: an id
 * missing from here is not necessarily dead. It may be early (a deep-linked
 * pane that arrives before its session) or temporarily invisible (a scoped
 * slice shrinking under an evict). Deciding which is which is the caller's job
 * — see `Reactions.pruneWorkspaces`.
 */
export function knownTabIds(st: EngineState): Set<string> {
  const ids = new Set<string>()
  for (const session of st.sessions) ids.add(session.sessionId)
  for (const id of st.pendingSpawnIds) ids.add(id)
  for (const tab of st.fileTabs) ids.add(tab.id)
  return ids
}

/** Every tab id any workspace on this device has open. */
export function referencedTabIds(st: Pick<EngineState, 'workspaces'>): Set<string> {
  const ids = new Set<string>()
  for (const ws of Object.values(st.workspaces)) for (const id of allTabIds(ws)) ids.add(id)
  return ids
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
  // EVERY pane it renders, not just the two the `paneA`/`paneB` mirrors can
  // spell — a third pane's session is on screen and its PTY has the same claim
  // on relay priority as the first two — and only the panes it renders, which
  // is why this is `visibleTabIds` and not the layout's leaves.
  const paneIds = visibleTabIds(st)
  const focusedId = focusedPaneSession(st)
  const isSession = (id: SessionId): boolean => st.sessions.some((s) => s.sessionId === id)
  const focusedFile = focusedId ? st.fileTabs.find((f) => f.id === focusedId) : undefined
  // EVERY visible tab that is a FILE, not just the focused one (POD-782). The
  // sessions half of `paneIds` has always been reported in full; the files half
  // was thrown away by the `.filter(isSession)` above and only the focused pane's
  // path survived, so a second open file was invisible to the orchestrator.
  const openFilePaths = paneIds
    .map((id) => st.fileTabs.find((f) => f.id === id)?.path)
    .filter((path): path is string => path !== undefined)
  return {
    view: st.view,
    ...(st.selectedWorktree ? { worktreePath: st.selectedWorktree } : {}),
    ...(st.selectedIssueId ? { issueId: st.selectedIssueId } : {}),
    // The issue detail drawer is what the operator is READING while it is
    // open, even though the workspace underneath keeps its own selection — so
    // reporting only `issueId` names the wrong issue for as long as it is up.
    ...(st.openIssueId ? { openIssueId: st.openIssueId } : {}),
    ...(focusedId && isSession(focusedId) ? { focusedSessionId: focusedId } : {}),
    visibleSessionIds: paneIds.filter(isSession),
    ...(focusedFile ? { filePath: focusedFile.path } : {}),
    ...(openFilePaths.length ? { openFilePaths } : {}),
  }
}

/** Everything the first snapshot needs that the runtime has to gather first:
 *  the hydrated UI state, the current route, the replica's seed rows already
 *  folded through the optimistic ledger, and the outbox's restored recovery
 *  home. */
export interface EngineStateSeed {
  readonly persisted: WorkspaceUiSnapshot
  readonly route: { settingsTab: string | null; issueId?: IssueId | null }
  readonly sessions: SessionMeta[]
  readonly issues: IssueWire[]
  readonly issueProjections: IssueProjectionRow[]
  readonly issueEvents: IssueEventWire[]
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
    issueEvents: seed.issueEvents,
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
    // Not persisted either, and deliberately pessimistic: the view says what it
    // renders as soon as it mounts (see EngineState.splitEnabled).
    splitEnabled: false,
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
