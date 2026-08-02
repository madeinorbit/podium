/**
 * Platform-neutral view-model derivations (issue #15 Phase 4): moved verbatim
 * from apps/web/src/derive.ts so the rewritten mobile app can consume them.
 * NOTHING here may touch the DOM (window/document/localStorage) or web-only
 * modules — the boundary lint and the web shim (apps/web/src/derive.ts, which
 * re-exports everything plus the css-classname helpers) enforce the split.
 */
import { DEFER_NEXT_MESSAGE, agentCapabilityRejection, asIssueId, asSessionId, dedupeSessionsByResume, isHeadlessSession, isIssueDeferred, isSnoozed, issueReturnedFromDefer, lastUsedMachine, machinesForRepo, machinesForRepoOrClone, machinesWithRepo, normalizeOriginUrl, onlineMachinesForRepoOrClone, repoNameFromOrigin, resolveTargetMachine, resolveTargetMachineForAgent, returnedFromSnooze, snoozeUntil1h, snoozeUntilTomorrow5am, type AgentKind, type GitRepositoryWire, type HostMetricsWire, type IssueId, type IssueWire, type RepoId, type SessionId, type SessionMeta, withoutHeadless, worktreeForCwd } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { attentionGroup, compareRecency } from '../focus'
import type { PinState, RepoView, WorktreeView } from './types'

import {
  agentBadge,
  chatActivity,
  defaultChatCapable,
  exitedRecovery,
  formatClock,
  isConsumedChild,
  isSessionWorking,
  isUnstartedSession,
  motionPhase,
  motionTiming,
  nativeSubagentCountOf,
  nativeSubagentLabel,
  panelLabel,
  resumeCommand,
  sessionDotTone,
  sessionHasNativeSubagents,
  sessionIssueLinkage,
  agentColorHex,
  type AgentBadge,
  type ChatActivity,
  type DotTone,
  type ExitedAction,
  type MotionPhase,
  type MotionTiming,
} from './session-status'
import {
  archivedSessionsForIssue,
  archivedSessionsForWorktreePath,
  indexSessionOwnership,
  issueIdOwningSession,
  sessionsForIssueNav,
  sessionsForIssueWorktree,
  sessionsForWorktree,
  type SessionOwnershipIndex,
} from './session-ownership'

import {
  formatMemBytes,
  hostMemoryView,
  isKnownWorktreePath,
  repoBranchForCwd,
  reposToViews,
  repoUsageAt,
  spawnTargetForRepo,
  type HostMemoryView,
  type SpawnRepoTarget,
  type MemorySeverity,
} from './slices/machines'

import {
  mostUrgentSession,
  sessionUrgencyRank,
  sortSessionsForSidebar,
  STALE_INACTIVE_MS,
} from './session-urgency'
import {
  branchRollup,
  draftIssueLabel,
  filterIssueNav,
  isClosedTopLevelIssue,
  isDraftAgentVessel,
  issueAwaitingMerge,
  issueFinishedAt,
  issueNavList,
  issuePendingDecision,
  issuePendingMergeCommits,
  pendingDecisionLabel,
  pendingDecisionTitle,
  subIssuesOf,
  type IssueNavigationModel,
  type IssueNavView,
  type IssuePendingDecision,
} from './slices/issues'

// POD-330: the issue entity's own derivations (nav model, sub-issue tree,
// pending-decision family) live in the issues slice; the collection-level
// "which session matters more" question is F3 (session-urgency). Both are
// re-exported here so existing call sites keep working.
export {
  branchRollup,
  draftIssueLabel,
  filterIssueNav,
  isDraftAgentVessel,
  issueAwaitingMerge,
  issueNavList,
  issuePendingDecision,
  issuePendingMergeCommits,
  mostUrgentSession,
  pendingDecisionLabel,
  pendingDecisionTitle,
  sessionUrgencyRank,
  sortSessionsForSidebar,
  STALE_INACTIVE_MS,
  subIssuesOf,
}
export type { IssueNavigationModel, IssueNavView, IssuePendingDecision }

// POD-330: repo/worktree structure, spawn placement and host metrics are
// MACHINE facts (multi-user doc 3.1.1, owned compute) and now live in the
// machines slice. Re-exported here so existing call sites keep working.
export {
  formatMemBytes,
  hostMemoryView,
  isKnownWorktreePath,
  repoBranchForCwd,
  reposToViews,
  repoUsageAt,
  spawnTargetForRepo,
}
export type { HostMemoryView, MemorySeverity, SpawnRepoTarget }


// POD-330: the per-session presentation vocabulary (F1) and the session
// membership question (F2) now live in their own modules. They are re-exported
// here so existing `./derive` call sites keep working while the slice cut lands.
export {
  agentBadge,
  agentColorHex,
  archivedSessionsForIssue,
  archivedSessionsForWorktreePath,
  chatActivity,
  defaultChatCapable,
  exitedRecovery,
  formatClock,
  indexSessionOwnership,
  isConsumedChild,
  isSessionWorking,
  isUnstartedSession,
  issueIdOwningSession,
  motionPhase,
  motionTiming,
  nativeSubagentCountOf,
  nativeSubagentLabel,
  panelLabel,
  resumeCommand,
  sessionDotTone,
  sessionHasNativeSubagents,
  sessionIssueLinkage,
  sessionsForIssueNav,
  sessionsForIssueWorktree,
  sessionsForWorktree,
}
export type {
  AgentBadge,
  ChatActivity,
  DotTone,
  ExitedAction,
  MotionPhase,
  MotionTiming,
  SessionOwnershipIndex,
}


// Entity-pure predicates live in @podium/model (#194) — client-core imports
// them (above) rather than redefining them, and re-exports the same bindings
// (not new `export const`/`export function` declarations — see
// scripts/check-boundaries.ts rule 7, which flags exactly that shape) so
// existing `@podium/client-core/viewmodels` / `./derive` call sites keep
// working unchanged.
export {
  agentCapabilityRejection,
  DEFER_NEXT_MESSAGE,
  dedupeSessionsByResume,
  isHeadlessSession,
  isIssueDeferred,
  isSnoozed,
  issueReturnedFromDefer,
  lastUsedMachine,
  machinesForRepo,
  machinesForRepoOrClone,
  machinesWithRepo,
  normalizeOriginUrl,
  onlineMachinesForRepoOrClone,
  repoNameFromOrigin,
  resolveTargetMachine,
  resolveTargetMachineForAgent,
  returnedFromSnooze,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  withoutHeadless,
  worktreeForCwd,
}


// machinesWithRepo/machinesForRepo/lastUsedMachine/resolveTargetMachine
// (machine-affinity identity) and worktreeForCwd/isHeadlessSession/
// withoutHeadless (worktree + session identity) are entity-pure — imported
// from @podium/model above and re-exported, not redefined here (#194).


/** One session's worktree change, as seen between two `sessions` snapshots. */
export interface WorktreeMove {
  sessionId: SessionId
  from: string | null
  to: string | null
}

/**
 * View policy for sessions whose worktree changed: the session the user is
 * looking at FOLLOWS (switch the whole view to its new worktree so it doesn't
 * vanish out of the tab strip mid-conversation); a background session's move
 * never yanks the view — it's reported (`moved`) for a toast instead.
 *
 * `follow` is non-null only when a visible-pane session moved OUT of the
 * currently-selected worktree into another known worktree. Moves are computed
 * on resolved worktree roots (worktreeForCwd), so a subdirectory cd is a no-op,
 * and first-sight sessions (no previous cwd) are never moves.
 */
export function planWorktreeMoves(opts: {
  prevCwds: Record<string, string>
  sessions: SessionMeta[]
  worktreePaths: string[]
  selectedWorktree: string | null
  visiblePanes: string[]
}): { follow: string | null; moved: WorktreeMove[] } {
  let follow: string | null = null
  const moved: WorktreeMove[] = []
  for (const s of opts.sessions) {
    const prev = opts.prevCwds[s.sessionId]
    if (prev === undefined || prev === s.cwd) continue
    const from = worktreeForCwd(prev, opts.worktreePaths)
    const to = worktreeForCwd(s.cwd, opts.worktreePaths)
    if (from === to) continue // subdirectory cd / unresolvable churn — not a move
    if (
      follow === null &&
      to !== null &&
      from !== null &&
      from === opts.selectedWorktree &&
      opts.visiblePanes.includes(s.sessionId)
    ) {
      follow = to
    } else {
      moved.push({ sessionId: s.sessionId, from, to })
    }
  }
  return { follow, moved }
}

/** When the selected path no longer resolves to a live worktree but still has
 *  sessions pinned to it (its worktree was removed out from under them), pick
 *  which orphan to surface in the workspace: the one already in pane A if it's
 *  one of them, else the first. Null when there's nothing to show — so the
 *  caller falls back to the empty "Select a worktree." placeholder. */
export function orphanSessionFor(opts: {
  selectedWorktree: string | null
  sessions: SessionMeta[]
  paneA: string | null
}): SessionMeta | null {
  if (!opts.selectedWorktree) return null
  // Containment against just the selected path: the worktree is gone from the
  // scan, so there's no root list to resolve against — but a session stamped
  // with a subdirectory of the removed worktree is still its orphan.
  const orphans = sessionsForWorktree(opts.sessions, opts.selectedWorktree, [opts.selectedWorktree])
  return orphans.find((s) => s.sessionId === opts.paneA) ?? orphans[0] ?? null
}


export interface WorktreeNavView extends WorktreeView {
  repoName: string
  sessions: SessionMeta[]
  /** Non-archived issues whose worktree this is. When non-empty, the sidebar
   *  renders the issue block(s) instead of the bare worktree row. */
  issues: IssueNavigationModel[]
}

export interface RepoNavView {
  path: string
  name: string
  worktrees: WorktreeNavView[]
  machines?: { machineId: string; path: string }[]
  originUrl?: string
  repoId?: RepoId
}

export interface SidebarSections {
  /** Shared ownership work for this exact repo/session/issue snapshot. */
  sessionOwnership?: SessionOwnershipIndex
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }

// isSnoozed/returnedFromSnooze/snoozeUntil1h/snoozeUntilTomorrow5am (session
// snooze) and isIssueDeferred/issueReturnedFromDefer (issue defer) are
// entity-pure — imported from @podium/model above and re-exported, not
// redefined here (#194). All four take an `Instant` (epoch ms): POD-299
// collapsed the ISO-string/epoch-ms twin predicates into one clock
// representation, so `isIssueSnoozed` is gone and `isIssueDeferred` is the
// single spelling for both the server and these viewmodels.

/**
 * Tab-strip order for one worktree/issue. The user's manual (drag) order wins;
 * sessions it doesn't know about — panels opened after the last drag — append
 * at the end in arrival order. When `coordinatorSessionId` is set (issue
 * workspace, M6), that session is elevated first so the driver is unambiguous
 * among equal tabs. (Panel-pinning is retired, POD-169 — no pin-aware order.)
 */
export function orderTabs(
  sessions: SessionMeta[],
  manualOrder: string[] | undefined,
  coordinatorSessionId?: string | null,
): SessionMeta[] {
  const base = elevateCoordinatorSession(sessions, coordinatorSessionId)
  if (!manualOrder || manualOrder.length === 0) return base
  // Manual drag order wins, but still lift the coordinator to the front so a
  // stale saved order can't bury the designated driver.
  const position = orderMap(manualOrder)
  const known = base
    .filter((s) => position.has(s.sessionId))
    .sort((a, b) => (position.get(a.sessionId) ?? 0) - (position.get(b.sessionId) ?? 0))
  const unknown = base.filter((s) => !position.has(s.sessionId))
  return elevateCoordinatorSession([...known, ...unknown], coordinatorSessionId)
}

/**
 * Move the designated coordinator session to the front of an issue's session
 * list (M6 / docs/agent-comms-target.html §05 q1). No-op when unset or when
 * the coordinator is not among the listed sessions (dangling-tolerant).
 */
export function elevateCoordinatorSession(
  sessions: SessionMeta[],
  coordinatorSessionId: string | undefined | null,
): SessionMeta[] {
  if (!coordinatorSessionId) return sessions
  const i = sessions.findIndex((s) => s.sessionId === coordinatorSessionId)
  if (i <= 0) return sessions
  const next = sessions.slice()
  const [coord] = next.splice(i, 1)
  if (!coord) return sessions
  next.unshift(coord)
  return next
}

/** True when this session is the issue's designated coordinator (M6). */
export function isCoordinatorSession(
  issue: Pick<IssueWire, 'coordinatorSessionId'>,
  sessionId: SessionId,
): boolean {
  return typeof issue.coordinatorSessionId === 'string' && issue.coordinatorSessionId === sessionId
}

/** Sessions shown in the sidebar — shells never appear there (they stay in the
 *  main-view tab strip). */
export function sidebarSessions(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => s.agentKind !== 'shell')
}

export function sidebarSections(
  repos: GitRepositoryWire[],
  sessions: SessionMeta[],
  pins: PinState,
  now: number = Date.now(),
  issues: IssueNavigationModel[] = [],
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)
  sessions = sidebarSessions(sessions)
  // worktree path → its non-archived issues (an issue owns at most one worktree;
  // several issues may point at the same worktree — the worktree shows under each).
  const issuesByWorktree = new Map<string, IssueNavigationModel[]>()
  for (const issue of issues) {
    if (issue.archived || !issue.worktreePath) continue
    const list = issuesByWorktree.get(issue.worktreePath)
    if (list) list.push(issue)
    else issuesByWorktree.set(issue.worktreePath, [issue])
  }

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  const allWorktreePaths = allWorktrees.map(({ worktree }) => worktree.path)
  const sessionOwnership = indexSessionOwnership(sessions, issues, allWorktreePaths)
  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(
      sessionsForWorktree(sessions, worktree.path, allWorktreePaths, sessionOwnership),
      now,
    ),
    issues: issuesByWorktree.get(worktree.path) ?? [],
  })

  const navRepo = (repo: RepoView): RepoNavView => ({
    path: repo.path,
    name: repo.name,
    worktrees: repo.worktrees
      .filter((worktree) => !pinnedWorktreePaths.has(worktree.path))
      .map((worktree) => navWorktree(repo, worktree)),
    machines: repo.machines,
    ...(repo.originUrl !== undefined ? { originUrl: repo.originUrl } : {}),
    ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
  })

  return {
    sessionOwnership,
    pinnedWorktrees: pins.worktrees
      .map((path) => allWorktrees.find(({ worktree }) => worktree.path === path))
      .filter((item): item is { repo: RepoView; worktree: WorktreeView } => item !== undefined)
      .map(({ repo, worktree }) => navWorktree(repo, worktree)),
    pinnedRepos: pins.repos
      .map((path) => repoViews.find((repo) => repo.path === path))
      .filter((repo): repo is RepoView => repo !== undefined)
      .map(navRepo),
    repos: repoViews
      .filter((repo) => !pinnedRepoPaths.has(repo.path))
      .map(navRepo)
      .filter((repo) => repo.worktrees.length > 0),
  }
}

export interface WorkItemPartition {
  /** Sessions needing the user's attention: blocked, finished-idle, errored, or exited. */
  attention: SessionMeta[]
  /** Sessions actively running without needing the user. */
  working: SessionMeta[]
  /** Pinned sessions — also listed in attention/working when their state warrants it. */
  pinnedPanels: SessionMeta[]
}

/**
 * Partition sessions into the three WORK ITEMS buckets used by work-list views.
 *
 * Non-archived sessions are classified into `attention` or `working` by agent
 * state regardless of pin status. Pinned sessions additionally appear in
 * `pinnedPanels` for quick reach (same lift-and-keep pattern as worktree lists).
 *   - `attention` — any attentionGroup result other than 'working'
 *     (i.e. needsYou, idle, exited/hibernated/ended), minus snoozed/shells.
 *   - `working` — phase 'working' | 'compacting', or an active shell/uninstrumented live process.
 * Archived sessions are excluded entirely.
 */
export function partitionWorkItems(
  sessions: SessionMeta[],
  pinnedSessionIds: Set<string>,
  now: number = Date.now(),
): WorkItemPartition {
  const attention: SessionMeta[] = []
  const working: SessionMeta[] = []
  const pinnedPanels: SessionMeta[] = []

  for (const s of sessions) {
    if (s.archived || isHeadlessSession(s)) continue
    // Shells never appear in the sidebar — not in WORKING, PINNED, or attention.
    if (s.agentKind === 'shell') continue
    if (pinnedSessionIds.has(s.sessionId)) pinnedPanels.push(s)
    const group = attentionGroup(s)
    if (group === 'working') {
      working.push(s)
    } else if (isSnoozed(s, now)) {
    } else {
      attention.push(s)
    }
  }

  // Every WORK ITEMS section in the repo tree reads newest-active first. Without this,
  // raw arrival order would put the newest attention session at the bottom.
  attention.sort((a, b) => compareRecency(a, b, now))
  working.sort((a, b) => compareRecency(a, b, now))
  pinnedPanels.sort((a, b) => compareRecency(a, b, now))
  return { attention, working, pinnedPanels }
}

// dedupeSessionsByResume (collapsing duplicate rows for the same underlying
// agent conversation) is entity-pure — imported from @podium/model above and
// re-exported, not redefined here (#194).

/** A session is "stale" when it's been inactive longer than this. */
export interface StalePartition {
  /** Sessions to render normally. */
  visible: SessionMeta[]
  /** Sessions sunk into the collapsed "Stale" subsection at the bottom. */
  stale: SessionMeta[]
}

/**
 * Split a worktree's (or attention list's) already-sorted sessions into a
 * visible head and a collapsed "Stale" tail. Stale candidates are non-working
 * sessions inactive for more than {@link STALE_INACTIVE_MS}. The split only
 * kicks in for a crowded group — MORE than 5 sessions total AND MORE than 3
 * stale candidates — and even then the 3 most-recently-active candidates stay
 * visible; only the rest collapse. Working sessions are never collapsed.
 */
export function partitionStaleSessions(
  sorted: SessionMeta[],
  now: number = Date.now(),
): StalePartition {
  const isCandidate = (s: SessionMeta): boolean =>
    attentionGroup(s) !== 'working' && now - Date.parse(s.lastActiveAt) > STALE_INACTIVE_MS
  const candidates = sorted.filter(isCandidate)
  if (sorted.length <= 5 || candidates.length <= 3) return { visible: sorted, stale: [] }
  // Keep the 3 most-recently-active candidates visible; collapse the remainder.
  const byRecency = [...candidates].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  const staleIds = new Set(byRecency.slice(3).map((s) => s.sessionId))
  return {
    visible: sorted.filter((s) => !staleIds.has(s.sessionId)),
    stale: sorted.filter((s) => staleIds.has(s.sessionId)),
  }
}

/** One sidebar session group (#237) [spec:SP-34d7 web]: a top-level session
 *  plus the cross-harness children spawned by it (`spawnedBy: 'session:<id>'`,
 *  resolved to the topmost listed ancestor so deep fan-out stays one level in
 *  the UI). Children split into `children` (live/attention-worthy) and
 *  `consumed` (exited — auto-tucked behind a disclosure). */
export interface SessionGroup {
  session: SessionMeta
  children: SessionMeta[]
  consumed: SessionMeta[]
}

const spawnedByParentId = (s: SessionMeta): string | null => {
  const m = /^session:(.+)$/.exec(s.spawnedBy ?? '')
  return m?.[1] ?? null
}



/**
 * Whether a sidebar issue/worktree row should expand to show nested session
 * rows (remote spawn children and/or native-subagent indicators).
 *
 * - A genuine remote spawn-child must nest under its spawner even when it is
 *   the only extra session (parent + 1 child) — never hide it behind the
 *   parent status line just because the list is short.
 * - A lone parent with `nativeSubagentCount > 0` still expands so the native
 *   indicator is visible.
 * - Unrelated multi-agent rows keep expanding as before.
 */
export function sessionsNeedChildRows(sessions: SessionMeta[]): boolean {
  if (sessions.length === 0) return false
  // Native Task subagents: expand even for a lone parent session so the
  // nested "N subagents" indicator is visible under the parent row.
  if (sessions.some(sessionHasNativeSubagents)) return true
  // Multi-session list: expand so remote spawn children and sibling agents
  // are visible as rows. Parent + a single remote child is length 2 — never
  // collapse that genuine spawn-child into the parent status line.
  return sessions.length >= 2
}

/**
 * Group a row's sessions by spawn parentage so cross-harness fan-out doesn't
 * flatten into an unusable list: a session whose spawner is ALSO in the list
 * nests under it (grandchildren fold into the topmost listed ancestor); a
 * session whose spawner isn't listed stays top-level. Input order is preserved
 * on both levels.
 */
export function groupSessionsByParent(sessions: SessionMeta[]): SessionGroup[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  // Topmost listed ancestor (cycle-guarded); null = top-level.
  const anchorOf = (s: SessionMeta): string | null => {
    let cur = s
    let anchor: string | null = null
    const seen = new Set<string>([s.sessionId])
    for (;;) {
      const pid = spawnedByParentId(cur)
      if (!pid || seen.has(pid)) break
      // NOT a POD-363 adapter cast, and deliberately left in place by it. `pid` is
      // parsed out of the freeform `spawnedBy` tag, which has SIX producers, ONE
      // parser and seven hand-rebuilt comparisons; branding it here would brand the
      // parser's output at one of eight call sites and leave the other seven. The
      // brand belongs on a shared spawnedBy constructor+parser, which is POD-1133 —
      // so this stays a boundary cast until that lands, not a sweep target.
      const parent = byId.get(asSessionId(pid))
      if (!parent) break
      anchor = pid
      seen.add(pid)
      cur = parent
    }
    return anchor
  }
  const groups: SessionGroup[] = []
  const groupByAnchor = new Map<string, SessionGroup>()
  for (const s of sessions) {
    if (anchorOf(s) === null) {
      const g: SessionGroup = { session: s, children: [], consumed: [] }
      groups.push(g)
      groupByAnchor.set(s.sessionId, g)
    }
  }
  for (const s of sessions) {
    const anchor = anchorOf(s)
    if (anchor === null) continue
    const g = groupByAnchor.get(anchor)
    if (!g) continue // ancestor listed but itself nested-orphaned — treat as top-level
    ;(isConsumedChild(s) ? g.consumed : g.children).push(s)
  }
  // Orphaned nested children (anchor resolved but the anchor never became a
  // group — can't happen with anchorOf's topmost rule, but stay total):
  for (const s of sessions) {
    const anchor = anchorOf(s)
    if (anchor !== null && !groupByAnchor.has(anchor)) {
      groups.push({ session: s, children: [], consumed: [] })
    }
  }
  return groups
}

/** Pane target when a sidebar issue/worktree row is clicked: keep the current
 *  pane if it's already one of the row's members (a session in `members` or an
 *  id in `extraValidIds` — e.g. the row's open file tabs); otherwise open the
 *  row's most recently active session (lastActiveAt, ISO-comparable). Null =
 *  nothing to open (empty row) — clear the pane so the picker shows. */
export function pickPaneSession(
  members: SessionMeta[],
  paneA: SessionId | null,
  /** File-tab ids, which are NOT session ids — hence the plain string here. */
  extraValidIds: readonly string[] = [],
): SessionId | null {
  if (
    paneA != null &&
    (members.some((s) => s.sessionId === paneA) || extraValidIds.includes(paneA))
  ) {
    return paneA
  }
  let best: SessionMeta | null = null
  for (const s of members) if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  return best?.sessionId ?? null
}



/** Resolve the user's default agent kind for the unified split button. 'auto' (or
 *  unset) resolves to the most recently ACTIVE non-shell session's kind, falling
 *  back to claude-code. */
export function resolveDefaultAgent(
  setting: string | undefined,
  sessions: SessionMeta[],
): AgentKind {
  if (setting && setting !== 'auto') return setting as AgentKind
  let best: SessionMeta | undefined
  for (const s of sessions) {
    if (s.agentKind === 'shell' || isHeadlessSession(s)) continue
    if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  }
  return best && best.agentKind !== 'shell' ? best.agentKind : 'claude-code'
}

/** lastUsedAt maps aggregated to the repo (for repo ordering / "most recent repo")
 *  and per-worktree (for worktree ordering). A session's cwd is its worktree path;
 *  cwds not matching any known worktree aggregate under themselves. Extracted from
 *  Sidebar so the unified layout's "New <Agent> in <Repo>" shares the exact logic. */
export function lastUsedMaps(
  sections: SidebarSections,
  sessions: SessionMeta[],
): { byRepo: Map<string, number>; byWorktree: Map<string, number> } {
  const worktreeToRepo = new Map<string, string>()
  for (const repo of sections.repos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const repo of sections.pinnedRepos) {
    for (const wt of repo.worktrees) worktreeToRepo.set(wt.path, repo.path)
  }
  for (const wt of sections.pinnedWorktrees) worktreeToRepo.set(wt.path, wt.repoPath)
  const byRepo = new Map<string, number>()
  const byWorktree = new Map<string, number>()
  for (const s of sessions) {
    const ts = new Date(s.lastActiveAt).getTime()
    const repoPath = worktreeToRepo.get(s.cwd) ?? s.cwd
    if (ts > (byRepo.get(repoPath) ?? 0)) byRepo.set(repoPath, ts)
    if (ts > (byWorktree.get(s.cwd) ?? 0)) byWorktree.set(s.cwd, ts)
  }
  return { byRepo, byWorktree }
}

/** Rank of rows with NO sessions — sinks below every session-bearing row. */
export const UNIFIED_ROW_EMPTY_RANK = 4

/** One issue row in the unified WORK LIST. Optional `startedByChildren` holds
 *  top-level agent-started issues nested under this one via `startedBySession`
 *  (M6 started-by tree — not a formal parentId edge). */
export type UnifiedIssueRow = {
  kind: 'issue'
  issue: IssueNavigationModel
  sessions: SessionMeta[]
  activityAt: number
  rank: number
  /** Formal parentId children plus agent-started provenance children. [spec:SP-6144] */
  startedByChildren?: UnifiedIssueRow[]
  /** Own + descendant sessions, used only for bubbled status/attention. */
  aggregateSessions?: SessionMeta[]
}

/** One row of the unified sidebar's WORK LIST: a human-origin issue (drafts
 *  included) or a with-session worktree not owned by any issue. `rank` is the
 *  min of the child sessions' urgency ranks (UNIFIED_ROW_EMPTY_RANK when none). */
export type UnifiedWorkRow =
  | UnifiedIssueRow
  | { kind: 'worktree'; worktree: WorktreeNavView; activityAt: number; rank: number }

/** Whether a unified WORK/WORKING row should render with unread (email-style)
 *  emphasis. An issue row follows the replica-derived `unread` rollup
 *  (which already aggregates member-session activity), so marking the issue read
 *  clears it. A worktree row owns no `unread` field of its own, so it's unread
 *  iff any of its sessions is. (#126, built on the #124 unread foundation.) */
export function isRowUnread(row: UnifiedWorkRow): boolean {
  return row.kind === 'issue'
    ? (row.issue.unread ?? false)
    : row.worktree.sessions.some((s) => s.unread)
}

/** Whether a unified row should actually RENDER the unread (email-style) emphasis.
 *  Extends `isRowUnread` with the #138 rule: a row that has a currently-working
 *  session is active work, not "new unseen work" — and a working session re-flips
 *  `unread` on every output — so its emphasis is suppressed wherever it renders
 *  (WORK or WORKING). Read rows and rows with only idle/waiting sessions are
 *  unaffected. Applies to the row LABEL; child session rows gate on
 *  `isSessionWorking` in PanelRow. */
export function rowUnreadEmphasized(row: UnifiedWorkRow): boolean {
  if (!isRowUnread(row)) return false
  return !rowSessions(row).some(isSessionWorking)
}

const rowRank = (sessions: SessionMeta[], now: number): number =>
  sessions.reduce((min, s) => Math.min(min, sessionUrgencyRank(s, now)), UNIFIED_ROW_EMPTY_RANK)

/**
 * Build the unified WORK LIST rows (unsorted). Contents:
 *   - non-archived human-origin issues (drafts included) that have ≥1 live
 *     (non-archived, non-shell) member session — a worktree or a non-backlog
 *     stage alone is NOT enough; the unified list is live work, not a tree;
 *   - nav worktrees owned by no issue that have ≥1 (non-shell) session.
 * Sessions attached to a live issue only render under that issue's row, so an
 * agent-created worktree whose issue never stamped worktreePath won't show twice.
 * After the flat pass, top-level agent-started issues nest under the starter
 * session's issue via {@link nestStartedByIssues} (M6 started-by tree).
 */
const SIDEBAR_FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** How long an UNREAD finished issue stays visible waiting for acknowledgment.
 *  Bounded so the historical population of never-read done issues (readAt did
 *  not always exist) cannot resurface forever with an unread badge. */
const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Acknowledgment-gated completion decay for the live sidebar. [spec:SP-6144] */
export function issueVisibleInSidebar(issue: IssueNavigationModel, now: number): boolean {
  const finished = issue.stage === 'done' || issue.closedReason != null
  if (!finished) return true
  // POD-183: closed top-level issues visually decay into a fold; they do not
  // disappear with time. Unread and selected presentation is handled later.
  if (isClosedTopLevelIssue(issue)) return true
  // Review/merge is still a human action. It does not decay like shipped work.
  if (issueAwaitingMerge(issue)) return true
  const finishedAt = issueFinishedAt(issue)
  // Unread keeps a finished row visible only within 7 days of finishing —
  // beyond that it is history, not pending acknowledgment.
  if (issue.unread || !issue.readAt) {
    return now - finishedAt <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  const anchor = Math.max(finishedAt, Date.parse(issue.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}

export function sessionVisibleInSidebar(s: SessionMeta, now: number, issue?: IssueWire): boolean {
  const issueFinished =
    issue !== undefined && (issue.stage === 'done' || issue.closedReason != null)
  const agentState = s.agentState
  const idleDone = agentState?.phase === 'idle' && agentState.idle?.kind === 'done'
  const finishedAt =
    s.stoppedAt ??
    (agentState?.phase === 'ended'
      ? agentState.since
      : idleDone && issueFinished
        ? (issue?.closedAt ?? issue?.updatedAt ?? agentState.since)
        : undefined)
  if (!finishedAt) return true
  const finishedAtMs = Date.parse(finishedAt) || 0
  if (s.unread || !s.readAt) {
    return now - finishedAtMs <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  const anchor = Math.max(finishedAtMs, Date.parse(s.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}

function buildUnifiedRows(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number,
  ownership?: SessionOwnershipIndex,
): UnifiedWorkRow[] {
  const rows: UnifiedWorkRow[] = []
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || issue.stage === 'proposed') continue
    const mine = elevateCoordinatorSession(
      sortSessionsForSidebar(
        sessionsForIssueNav(issue, sessions, allWorktreePaths, {}, ownership).filter((s) =>
          sessionVisibleInSidebar(s, now, issue),
        ),
        now,
      ),
      issue.coordinatorSessionId,
    )
    // Once human work has started, retiring its last session must not erase the
    // issue from the sidebar. Backlog/proposed issues still need execution to
    // earn a live row; planning/in-progress/review issues carry their own work
    // lifecycle independently of any particular session. Finished milestone
    // children, awaiting-merge work, and explicitly closed top-level issues use
    // their existing completion visibility rules. [spec:SP-6144]
    if (mine.length === 0) {
      const finished = issue.stage === 'done' || issue.closedReason != null
      const activeHumanIssue =
        issue.audience === 'human' &&
        (issue.stage === 'planning' || issue.stage === 'in_progress' || issue.stage === 'review')
      const awaitingMerge = issueAwaitingMerge(issue)
      const closedTopLevel = isClosedTopLevelIssue(issue)
      if (!activeHumanIssue) {
        if (
          !finished ||
          (!awaitingMerge && !closedTopLevel && (!issue.parentId || issue.audience === 'agent'))
        ) {
          continue
        }
        if (!issueVisibleInSidebar(issue, now)) continue
      }
    }
    const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
    rows.push({
      kind: 'issue',
      issue,
      sessions: mine,
      activityAt: lastSession || Date.parse(issue.updatedAt) || 0,
      rank: rowRank(mine, now),
    })
  }
  // Keep a tracked human parent visible when only its descendants are running;
  // its aggregate status is filled by the nesting pass. [spec:SP-6144]
  const presentIssueIds = new Set(
    rows.filter((row): row is UnifiedIssueRow => row.kind === 'issue').map((row) => row.issue.id),
  )
  // Walk each row's FULL ancestor chain (not just the direct parent) and
  // materialize every missing live human-audience ancestor, so a live session
  // deep under internal bookkeeping nodes always surfaces under its nearest
  // visible ancestor — and that ancestor renders under ITS tracked root rather
  // than posing as one. Finished (done/closed) ancestors are never resurrected
  // as rescue rows: a live descendant belongs under the nearest LIVE ancestor.
  const issueById = new Map(issues.map((issue) => [issue.id, issue]))
  for (const child of [...rows]) {
    if (child.kind !== 'issue') continue
    let parentId = child.issue.parentId
    const walked = new Set<string>([child.issue.id])
    while (parentId && !walked.has(parentId)) {
      walked.add(parentId)
      const parent = issueById.get(parentId)
      if (!parent || parent.archived || parent.deletedAt || parent.stage === 'proposed') break
      const parentFinished = parent.stage === 'done' || parent.closedReason != null
      if (!presentIssueIds.has(parent.id) && parent.audience === 'human' && !parentFinished) {
        rows.push({
          kind: 'issue',
          issue: parent,
          sessions: [],
          activityAt: Date.parse(parent.updatedAt) || 0,
          rank: UNIFIED_ROW_EMPTY_RANK,
        })
        presentIssueIds.add(parent.id)
      }
      parentId = parent.parentId
    }
  }
  // The work sidebar is issue-only. Unattached and orphaned sessions remain
  // available through session/history surfaces, but a repository branch is
  // never promoted into a pseudo-issue row (for example "podium · main").
  return nestStartedByIssues(rows, sessions, allWorktreePaths, issues, now, ownership)
}


/**
 * Nest top-level agent-started issues under the issue that owns their
 * `startedBySession` (M6 started-by tree). Formal `parentId` edges are left
 * alone — this is provenance grouping, not sub-issue hierarchy. Spin-offs
 * (issues with an outgoing `discovered-from` edge) are also left alone: their
 * provenance renders as the ⤷ origin tick, not nesting (POD-85/POD-117), so
 * started-by nesting survives only as a fallback for agent-started issues that
 * carry no explicit edge. If the starter session or its issue is not in the
 * current sidebar view, the issue stays top-level (never hidden). Cycle-safe.
 */
export function nestStartedByIssues(
  rows: UnifiedWorkRow[],
  sessions: readonly SessionMeta[],
  allWorktreePaths: string[],
  allIssues: readonly IssueWire[] = rows
    .filter((row): row is UnifiedIssueRow => row.kind === 'issue')
    .map((row) => row.issue),
  now: number = Date.now(),
  ownership?: SessionOwnershipIndex,
): UnifiedWorkRow[] {
  const issueRows = rows.filter((r): r is UnifiedIssueRow => r.kind === 'issue')
  if (issueRows.length === 0) return rows
  const visibleIssues = issueRows.map((r) => r.issue)
  const byId = new Map(issueRows.map((r) => [r.issue.id, r]))
  const allById = new Map(allIssues.map((issue) => [issue.id, issue]))
  const parentOf = new Map<IssueId, IssueId>()

  for (const row of issueRows) {
    const issue = row.issue
    // A formal tree edge always wins over provenance. Walk to the nearest visible
    // ancestor so a session-less internal bookkeeping node cannot orphan live work.
    let parentId = issue.parentId
    const seenParents = new Set<IssueId>([issue.id])
    while (parentId && !byId.has(parentId)) {
      if (seenParents.has(parentId)) {
        parentId = undefined
        break
      }
      seenParents.add(parentId)
      parentId = allById.get(parentId)?.parentId
    }
    // A spin-off (outgoing `discovered-from` edge) is deliberately TOP-LEVEL:
    // the sidebar renders its provenance as the ⤷ origin tick (POD-85), so the
    // startedBySession fallback must not re-nest it under the origin — which
    // would also bubble its sessions into the origin's aggregate agent count.
    const isSpinOff = issue.deps?.some((dep) => dep.type === 'discovered-from')
    if (!parentId && !issue.parentId && !isSpinOff && issue.startedBySession) {
      const candidate = issueIdOwningSession(
        issue.startedBySession,
        sessions,
        visibleIssues,
        allWorktreePaths,
        ownership,
      )
      const candidateRow = candidate ? byId.get(candidate) : undefined
      // Nesting under a draft vessel ERASES the issue: that row is the agent
      // itself and renders no children, so the child has no path to the screen.
      // Provenance is never worth losing the work — a draft keeps its spawned
      // issues top-level until it becomes real work of its own (POD-282).
      if (candidateRow && !isDraftAgentVessel(candidateRow.issue, candidateRow.sessions)) {
        parentId = candidateRow.issue.id
      }
    }
    if (!parentId || parentId === issue.id || !byId.has(parentId)) continue
    let walk: IssueId | undefined = parentId
    const cycle = new Set<IssueId>([issue.id])
    while (walk && !cycle.has(walk)) {
      cycle.add(walk)
      walk = parentOf.get(walk)
    }
    if (walk) continue
    parentOf.set(issue.id, parentId)
  }

  const childrenOf = new Map<IssueId, IssueId[]>()
  for (const [childId, parentId] of parentOf) {
    const children = childrenOf.get(parentId) ?? []
    children.push(childId)
    childrenOf.set(parentId, children)
  }
  const attach = (row: UnifiedIssueRow): UnifiedIssueRow => {
    const children = (childrenOf.get(row.issue.id) ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is UnifiedIssueRow => child !== undefined)
      .map(attach)
      // A parent's children are their own sibling scope (POD-168): manual
      // sortKey order, same comparator as top level.
      .sort(compareManualOrder)
    const aggregateSessions = [
      ...row.sessions,
      ...children.flatMap((child) => child.aggregateSessions ?? child.sessions),
    ]
    return {
      ...row,
      ...(children.length ? { startedByChildren: children } : {}),
      aggregateSessions,
      rank: rowRank(aggregateSessions, now),
      activityAt: aggregateSessions.reduce(
        (max, session) => Math.max(max, Date.parse(session.lastActiveAt) || 0),
        row.activityAt,
      ),
    }
  }

  const nested = new Set(parentOf.keys())
  const out: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'worktree') {
      out.push(row)
      continue
    }
    if (nested.has(row.issue.id)) continue
    // Internal issues are operational detail: nested only, never top-level.
    if (row.issue.audience === 'agent') continue
    out.push(attach(row))
  }
  return out
}

/** Band for the WORK list: pinned or returned-from-defer issues float to the top
 *  (0), snoozed issues sink to the bottom (2), everything else sits in the middle
 *  (1). Worktree rows have no such state, so they're always the middle band. */
function unifiedRowBand(row: UnifiedWorkRow, now: number): number {
  if (row.kind === 'issue') {
    if (row.issue.pinned || issueReturnedFromDefer(row.issue, now)) return 0
    if (isIssueDeferred(row.issue, now)) return 2
  }
  return 1
}

/** Immutable creation order, newest first (#64): issue rows key on createdAt
 *  (seq breaks a same-instant tie, id keeps it deterministic). Worktree rows
 *  carry no creation stamp, so they sink below every issue row and order among
 *  themselves by path. Nothing here moves while agents work — the sidebar's
 *  order may only change when work is created (or the user pins/snoozes). */
function compareCreationDesc(a: UnifiedWorkRow, b: UnifiedWorkRow): number {
  if (a.kind !== b.kind) return a.kind === 'issue' ? -1 : 1
  if (a.kind === 'issue' && b.kind === 'issue') {
    const dt = (Date.parse(b.issue.createdAt) || 0) - (Date.parse(a.issue.createdAt) || 0)
    if (dt !== 0) return dt
    if (a.issue.seq !== b.issue.seq) return b.issue.seq - a.issue.seq
    return a.issue.id.localeCompare(b.issue.id)
  }
  return a.kind === 'worktree' && b.kind === 'worktree'
    ? a.worktree.path.localeCompare(b.worktree.path)
    : 0
}

/** Manual order within a band (POD-168, R1): persisted `sortKey` ascending —
 *  keys are minted above the scope minimum on create, so new-at-top (R2) falls
 *  out naturally. A keyed row sorts before any unkeyed (legacy) row — a fresh
 *  issue still lands on top of a scope that predates keys — and unkeyed rows
 *  keep the old newest-first creation order among themselves. Keys are only
 *  ever meaningful against SIBLINGS (one key space per scope); cross-scope
 *  comparisons here are harmless because grouping happens downstream. */
function compareManualOrder(a: UnifiedWorkRow, b: UnifiedWorkRow): number {
  if (a.kind === 'issue' && b.kind === 'issue') {
    const ka = a.issue.sortKey
    const kb = b.issue.sortKey
    if (ka && kb && ka !== kb) return ka < kb ? -1 : 1
    if (ka && !kb) return -1
    if (!ka && kb) return 1
  }
  return compareCreationDesc(a, b)
}

/** WORK-list order: band asc (pinned/returned top, snoozed bottom — explicit
 *  user actions only), then manual sortKey order (creation-desc fallback).
 *  Urgency, activity and updatedAt deliberately do NOT sort — attention is
 *  carried per-row by the square language / amber pill / motion meta, never by
 *  reordering, so rows hold still while agents work (#64). */
function sortUnifiedWorkRows(rows: UnifiedWorkRow[], now: number): UnifiedWorkRow[] {
  return [...rows].sort((a, b) => {
    const db = unifiedRowBand(a, now) - unifiedRowBand(b, now)
    if (db !== 0) return db
    return compareManualOrder(a, b)
  })
}

/**
 * The unified WORK LIST — one flat list in fixed newest-first creation order
 * (#64). Pinned and just-unsnoozed issues float to the top; still-snoozed
 * issues sink to the bottom; inside each band rows read newest-created first
 * and never reorder on agent activity or attention.
 * (For the WORKING move-out split, see {@link partitionUnifiedWork}.)
 */
export function unifiedWorkList(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkRow[] {
  return sortUnifiedWorkRows(
    buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now, sections.sessionOwnership),
    now,
  )
}

/** One entry in the WORKING section (move-out semantics): a fully-working issue
 *  or worktree row, or an individual working session lifted out of a partially-
 *  working row. */
export type WorkingEntry =
  | { kind: 'issue'; row: Extract<UnifiedWorkRow, { kind: 'issue' }> }
  | { kind: 'worktree'; row: Extract<UnifiedWorkRow, { kind: 'worktree' }> }
  | { kind: 'session'; session: SessionMeta }

export interface UnifiedWorkPartition {
  /** WORKING rows/sessions, preserving the unified list's manual row order. */
  working: WorkingEntry[]
  /** The WORK list (banded order), minus whatever moved to WORKING. */
  work: UnifiedWorkRow[]
}

function rowSessions(row: UnifiedWorkRow): SessionMeta[] {
  return row.kind === 'issue' ? (row.aggregateSessions ?? row.sessions) : row.worktree.sessions
}

/** Rebuild a WORK row around a filtered session set, recomputing its rank +
 *  activity so ordering stays coherent after working sessions are lifted out. */
function rowWithSessions(row: UnifiedWorkRow, keep: SessionMeta[], now: number): UnifiedWorkRow {
  const activityAt = keep.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
  if (row.kind === 'issue') {
    // Recompute the bubbled aggregate too — a stale aggregate would keep
    // counting a lifted session in the row's status. [spec:SP-6144]
    const aggregate = [
      ...keep,
      ...(row.startedByChildren ?? []).flatMap(
        (child) => child.aggregateSessions ?? child.sessions,
      ),
    ]
    return {
      ...row,
      sessions: keep,
      aggregateSessions: aggregate,
      rank: rowRank(keep, now),
      activityAt: activityAt || Date.parse(row.issue.updatedAt) || 0,
    }
  }
  return {
    ...row,
    worktree: { ...row.worktree, sessions: keep },
    rank: rowRank(keep, now),
    activityAt,
  }
}

/**
 * Split the unified work into a WORKING section (move-out) and the WORK list:
 *   - an issue/worktree whose EVERY member session is working moves whole into
 *     WORKING (as its row) and out of WORK;
 *   - a partially-working row stays in WORK holding only its non-working
 *     sessions, and its working sessions are lifted into WORKING as individual
 *     rows — no duplication, a session shows in exactly one place;
 *   - a pinned issue is EXEMPT from move-out: pinning floats it to the top of
 *     WORK, so it stays there whole; when it has any working session it ALSO
 *     appears in WORKING as its row (the one row shown in both places).
 * Both partitions preserve the unified list's banded/manual row order. Lifted
 * standalone sessions retain their deterministic per-row sidebar order.
 */
export function partitionUnifiedWork(
  sections: SidebarSections,
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkPartition {
  const rows = sortUnifiedWorkRows(
    buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now),
    now,
  )
  const working: WorkingEntry[] = []
  const work: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'issue' && row.issue.pinned) {
      work.push(row)
      // Aggregate-aware mirror: a working nested child lights the pinned row up
      // in WORKING too (it's the same row shown twice by design).
      if (rowSessions(row).some(isSessionWorking)) working.push({ kind: 'issue', row })
      continue
    }
    // Lift decisions run over OWN sessions only [spec:SP-6144]: a descendant's
    // working session already renders under its own nested child row, so
    // lifting it here (or moving the whole subtree out because a descendant
    // works) would show the same session twice. Descendant activity reaches
    // the row through its bubbled aggregate status instead.
    const own = row.kind === 'issue' ? row.sessions : row.worktree.sessions
    const hasNestedChildren = row.kind === 'issue' && (row.startedByChildren?.length ?? 0) > 0
    const runningNow = own.filter(isSessionWorking)
    if (!hasNestedChildren && runningNow.length > 0 && runningNow.length === own.length) {
      working.push(row.kind === 'issue' ? { kind: 'issue', row } : { kind: 'worktree', row })
    } else if (runningNow.length > 0) {
      work.push(
        rowWithSessions(
          row,
          own.filter((s) => !isSessionWorking(s)),
          now,
        ),
      )
      for (const s of runningNow) working.push({ kind: 'session', session: s })
    } else {
      work.push(row)
    }
  }
  return { working, work }
}

export interface PinnedWorkSplit {
  /** Pinned issue rows, in banded order — the PINNED section above all groups. */
  pinned: UnifiedWorkRow[]
  /** Everything else, ready for {@link groupUnifiedWorkRows}. */
  rest: UnifiedWorkRow[]
}

/**
 * PINNED section split (POD-166, R3): pinned issues MOVE out of their project
 * group into one section above all groups — Linear-favorites style, move not
 * copy. Unpinning drops the row back into its group's banded order. Input
 * order is preserved on both sides (pinned rows already float via band 0, so
 * the pinned list reads in the same banded creation order).
 */
export function splitPinnedWork(rows: UnifiedWorkRow[]): PinnedWorkSplit {
  const pinned: UnifiedWorkRow[] = []
  const rest: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'issue' && row.issue.pinned) pinned.push(row)
    else rest.push(row)
  }
  return { pinned, rest }
}

export interface UnifiedWorkGroup {
  key: string
  label: string
  rows: UnifiedWorkRow[]
  /** Actively deferred issues hidden behind the project's local disclosure. */
  snoozedRows: UnifiedIssueRow[]
  /** Settled top-level closures hidden behind the project's local disclosure. */
  closedRows: UnifiedIssueRow[]
}

/** Snoozed issues decay into the project-local fold. Pinned rows have already
 * been removed before grouping, and a returned-from-defer issue is not
 * currently snoozed, so both keep their existing top-of-list treatment. */
export function rowInSnoozedFold(row: UnifiedWorkRow, now: number): row is UnifiedIssueRow {
  return row.kind === 'issue' && isIssueDeferred(row.issue, now)
}

/** POD-183 / POD-293 fold membership. Live asks outrank structure: needs-you
 * and awaiting-merge keep their full row. Finished top-level closures offer
 * "Tuck away" without requiring a read stamp or idle sessions — those gates
 * were for auto-fold-on-read / auto-bury; manual tuck is the dismiss path.
 * A selected open finished row stays open until tuck, grace, or focus moves.
 * Pinned rows are removed before grouping, so pinning also wins. */

/** Has the operator dismissed this finished row into the fold? Read straight off
 *  the issue (POD-333): `tuckedAt` is SERVER state delivered to every client,
 *  so a second browser hydrates the same fold and a tuck here folds the row
 *  there. It used to be a per-browser ui-state key the server never saw. The
 *  pressing client sees it instantly through the outbox overlay, which paints
 *  `tuckedAt` over server truth until the mutation lands. */
function issueTucked(issue: IssueWire): boolean {
  return issue.tuckedAt != null
}

/** Finished-issue facts shared by fold membership and the tuck-away control.
 *  Selection is intentionally NOT here: selecting a done row must keep
 *  "Tuck away" visible; only fold placement cares about selection. Read and
 *  working-session state are also not here — closing the issue is enough to
 *  offer dismiss; an agent still winding down must not hide the control. */
function finishedIssueSettled(row: UnifiedWorkRow): row is UnifiedIssueRow {
  if (row.kind !== 'issue') return false
  const { issue } = row
  return (
    isClosedTopLevelIssue(issue) &&
    !issue.needsHuman &&
    !issueAwaitingMerge(issue) &&
    rowWaitingCount(row) === 0
  )
}

/** Eligibility for the closed fold BEFORE the operator's dismissal is consulted:
 *  a settled top-level closure with nothing still asked of the human. */
function closedFoldEligible(
  row: UnifiedWorkRow,
  selectedIssueId: string | null,
  selectedIssueWasFolded: boolean,
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  const { issue } = row
  // A selected closure keeps the lane it occupied when clicked: a settled folded
  // row stays folded, while an open finished row stays open until focus moves.
  return issue.id !== selectedIssueId || selectedIssueWasFolded
}

export function rowInClosedFold(
  row: UnifiedWorkRow,
  selectedIssueId: string | null,
  selectedIssueWasFolded = false,
  now: number = Date.now(),
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  // Explicit tuck always folds — even while the row is selected. Lane stickiness
  // ("selected open stays open until focus moves") only applies to passive
  // placement (grace auto-fold), not operator dismissal.
  if (issueTucked(row.issue)) return true
  if (!closedFoldEligible(row, selectedIssueId, selectedIssueWasFolded)) return false
  // POD-293: a freshly finished issue no longer drops into the fold the instant
  // it finishes — it stays a live "done" row carrying the tuck-away control, and
  // folds only once the operator dismisses it, or after the finished-grace
  // window tidies it away on its own so the live list can't accrete history.
  return now - issueFinishedAt(row.issue) > SIDEBAR_FINISHED_GRACE_MS
}

/** A finished issue held OPEN in the live list for the operator to dismiss
 *  (POD-293): settled and still inside the grace window, not yet tucked.
 *  Selection and read state do not hide the control — only tuck or grace does. */
export function rowAwaitsTuck(
  row: UnifiedWorkRow,
  _selectedIssueId: string | null = null,
  _selectedIssueWasFolded = false,
  now: number = Date.now(),
): row is UnifiedIssueRow {
  if (!finishedIssueSettled(row)) return false
  return !issueTucked(row.issue) && now - issueFinishedAt(row.issue) <= SIDEBAR_FINISHED_GRACE_MS
}

/**
 * Bucket unified WORK rows by repo (stable repoId when known, repoPath
 * otherwise — so the same repo on two machines/paths merges into one group).
 * Open-row and group order follow the incoming fixed creation order. Closed
 * rows deliberately ignore manual sort keys: the fold is a small history list,
 * ordered by the moment of closing, newest first.
 */
export function groupUnifiedWorkRows(
  rows: UnifiedWorkRow[],
  selectedIssueId: string | null = null,
  selectedIssueWasFolded = false,
  now: number = Date.now(),
): UnifiedWorkGroup[] {
  const groups: UnifiedWorkGroup[] = []
  const byKey = new Map<string, UnifiedWorkGroup>()
  for (const row of rows) {
    const key =
      row.kind === 'issue'
        ? (row.issue.repoId ?? row.issue.repoPath)
        : (row.worktree.repoId ?? row.worktree.repoPath)
    let group = byKey.get(key)
    if (!group) {
      const label =
        row.kind === 'worktree'
          ? row.worktree.repoName
          : row.issue.repoPath.split('/').pop() || row.issue.repoPath
      group = { key, label, rows: [], snoozedRows: [], closedRows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    if (rowInClosedFold(row, selectedIssueId, selectedIssueWasFolded, now)) {
      group.closedRows.push(row)
    } else if (rowInSnoozedFold(row, now)) {
      group.snoozedRows.push(row)
    } else group.rows.push(row)
  }
  for (const group of groups) {
    group.closedRows.sort((a, b) => issueFinishedAt(b.issue) - issueFinishedAt(a.issue))
  }
  return groups
}

function orderMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}


/**
 * Aggregate motion phase for one unified WORK row (#41): the row wears the most
 * human-relevant of its member sessions' phases. `waiting` dominates (stillness
 * is the signal — a row that needs you must read amber even while other agents
 * grind on), then `working`, then `done` when every member finished; a row
 * whose sessions are merely idle/ready reads motion `queued` (dimmed stillness
 * — status copy surfaces this as "idle", not "queued").
 */
export function rowMotionPhase(row: UnifiedWorkRow): MotionPhase {
  if (row.kind === 'issue' && pendingDecisionStats(row).count > 0) return 'waiting'
  const sessions = rowSessions(row)
  if (
    sessions.length === 0 &&
    row.kind === 'issue' &&
    (row.issue.stage === 'done' || row.issue.closedReason != null)
  ) {
    return 'done'
  }
  return aggregateMotionPhase(sessions, row.kind === 'issue' ? row.issue : undefined)
}

/** The same waiting > working > all-done > queued aggregation over any member
 *  session set — for squares fed by `issue.sessions` directly (#65 right rail). */
export function aggregateMotionPhase(
  sessions: SessionMeta[],
  issue?: IssueNavigationModel,
): MotionPhase {
  const phases = sessions.map((s) => motionPhase(s, issue))
  if (phases.includes('waiting')) return 'waiting'
  if (phases.includes('working')) return 'working'
  if (phases.length > 0 && phases.every((p) => p === 'done')) return 'done'
  return 'queued'
}

/** How many member sessions are waiting on the human — drives the amber count
 *  pill on wide rows and the numbered corner badge on rail squares (#41).
 *  Issue rows count their `aggregateSessions` (via {@link rowSessions}), so the
 *  pill sums needs-you across the WHOLE branch — visible children and rolled-up
 *  depth alike. Nothing yellow ⇒ nothing needs you (POD-100 L3). */
export function rowWaitingCount(row: UnifiedWorkRow): number {
  const issue = row.kind === 'issue' ? row.issue : undefined
  const sessions = rowSessions(row).filter((s) => motionPhase(s, issue) === 'waiting').length
  return sessions + (row.kind === 'issue' ? pendingDecisionStats(row).count : 0)
}

/**
 * The decision this ROW is waiting on, if any (POD-279). Issue-level classification
 * plus the one piece of context the issue itself can't see: a review-stage issue
 * whose own agent is running again (sent back, follow-up turn) is not waiting on
 * the human — its decision returns when the turn settles. A finished issue keeps
 * its awaiting-merge reading regardless, since nothing is going to re-decide it.
 */
export function rowPendingDecision(row: UnifiedIssueRow): IssuePendingDecision | null {
  const decision = issuePendingDecision(row.issue)
  if (decision === null) return null
  const finished = row.issue.stage === 'done' || row.issue.closedReason != null
  if (!finished && row.sessions.some(isSessionWorking)) return null
  return decision
}

/** Count issues awaiting a human decision in a visible row's full formal subtree
 *  and find the oldest anchor for the static waiting-age stamp. Cycle-safe. */
function pendingDecisionStats(row: UnifiedIssueRow): { count: number; sinceMs?: number } {
  let count = 0
  let sinceMs: number | undefined
  const seen = new Set<string>()
  const stack: UnifiedIssueRow[] = [row]
  while (stack.length > 0) {
    const current = stack.pop() as UnifiedIssueRow
    if (seen.has(current.issue.id)) continue
    seen.add(current.issue.id)
    if (rowPendingDecision(current) !== null) {
      count += 1
      // Finished work anchors on closedAt; a review-stage issue has no closure
      // stamp, so its last update is when it came to rest asking.
      const at = issueFinishedAt(current.issue)
      if (at > 0 && (sinceMs === undefined || at < sinceMs)) sinceMs = at
    }
    for (const child of current.startedByChildren ?? []) stack.push(child)
  }
  return { count, ...(sinceMs !== undefined ? { sinceMs } : {}) }
}

/** The deepest descendant row whose OWN sessions include one waiting on the
 *  human — the source the parent's sub-line whispers when depth would otherwise
 *  hide a request ('deep: POD-224 needs you', POD-100 L3). Depth is relative to
 *  `row` (1 = direct child). Null when no descendant is waiting. */
export function deepAttentionSource(
  row: UnifiedIssueRow,
): { issue: IssueWire; depth: number; kind: 'session' | IssuePendingDecision } | null {
  let best: { issue: IssueWire; depth: number; kind: 'session' | IssuePendingDecision } | null =
    null
  const stack: Array<{ row: UnifiedIssueRow; depth: number }> = [{ row, depth: 0 }]
  while (stack.length > 0) {
    const { row: r, depth } = stack.shift() as { row: UnifiedIssueRow; depth: number }
    const kind =
      rowPendingDecision(r) ??
      (r.sessions.some((s) => motionPhase(s, r.issue) === 'waiting') ? 'session' : null)
    if (depth > 0 && kind !== null) {
      // Breadth-first + `>=` keeps the LAST deepest hit, so ties resolve to the
      // later sibling deterministically; any deepest source serves the whisper.
      if (best === null || depth >= best.depth) best = { issue: r.issue, depth, kind }
    }
    for (const child of r.startedByChildren ?? []) stack.push({ row: child, depth: depth + 1 })
  }
  return best
}

/** Is any session waiting within `depth` levels of `row` (0 = own sessions
 *  only)? Distinguishes a visible yellow (the child row explains itself) from
 *  one hidden behind the roll-up (the parent must whisper the source). */
function waitingWithinDepth(row: UnifiedIssueRow, depth: number): boolean {
  if (row.sessions.some((s) => motionPhase(s, row.issue) === 'waiting')) return true
  if (rowPendingDecision(row) !== null) return true
  if (depth <= 0) return false
  return (row.startedByChildren ?? []).some((child) => waitingWithinDepth(child, depth - 1))
}

/**
 * The row's second line (#41): a compact status phrase in the handoff's copy
 * grammar. Waiting rows surface WHAT is being waited for (the most urgent
 * session's badge label — "needs answer", "plan ready"); working/done rows
 * read as their phase; multi-agent rows carry the head-count. Quiet rows
 * (motion bucket `queued` — dimmed stillness, nothing working or needing you)
 * read **idle**, never "queued": "queued" sounds like pending work and
 * confused temporary pinned desks that were simply done for now.
 */
export function rowStatusLine(
  row: UnifiedWorkRow,
  now: number = Date.now(),
  /** How many descendant levels render beneath this row (POD-100 L4 cap):
   *  1 for a top-level row (children visible), 0 for a depth-capped child. */
  visibleDepth: number = 1,
): string {
  const sessions = rowSessions(row)
  const phase = rowMotionPhase(row)
  // A draft vessel whose sessions were never prompted isn't idle work —
  // nothing was asked yet. Say so instead of the phase word.
  if (
    row.kind === 'issue' &&
    row.issue.draft &&
    phase === 'queued' &&
    sessions.length > 0 &&
    sessions.every(isUnstartedSession)
  ) {
    return 'awaiting first prompt'
  }
  const head = sessions.length > 1 ? `${sessions.length} agents · ` : ''
  // Child progress speaks of subtasks, not a bare "N/M done" — appended to the
  // phase word that used to read "done · 0/1 done" (POD-85).
  const children = row.kind === 'issue' && row.issue.childCount > 0 ? row.issue : null
  const progress = children ? ` · ${children.childDoneCount}/${children.childCount} subtasks` : ''
  if (phase === 'waiting') {
    if (row.kind === 'issue') {
      const decision = rowPendingDecision(row)
      if (decision !== null) {
        return `${head}${pendingDecisionLabel(row.issue, decision)}${progress}`
      }
    }
    // Branch attention whisper (POD-100 L3): the yellow comes from a descendant
    // hidden behind the depth cap — no visible row explains the pill, so the
    // sub-line names the deepest source instead of a bare "needs you".
    if (row.kind === 'issue') {
      const deep = deepAttentionSource(row)
      if (deep && deep.depth > visibleDepth && !waitingWithinDepth(row, visibleDepth)) {
        const own = row.sessions.some(isSessionWorking) ? 'working · ' : ''
        const request =
          deep.kind === 'session' ? 'needs you' : pendingDecisionLabel(deep.issue, deep.kind)
        return `${head}${own}deep: ${issueDisplayRef(deep.issue)} ${request}${progress}`
      }
    }
    const issue = row.kind === 'issue' ? row.issue : undefined
    const urgent = mostUrgentSession(
      sessions.filter((s) => motionPhase(s, issue) === 'waiting'),
      now,
    )
    const label = urgent ? (agentBadge(urgent, issue)?.label ?? 'needs you') : 'needs you'
    return head + label + progress
  }
  if (phase === 'working') return head + 'working' + progress
  if (phase === 'done') {
    // A parent whose own sessions are done but whose subtasks aren't is not
    // "done" — the open subtasks ARE its status.
    if (children && children.childDoneCount < children.childCount) {
      return head + `${children.childDoneCount}/${children.childCount} subtasks done`
    }
    return head + 'done'
  }
  // Motion still uses the `queued` bucket for dim stillness; the human-facing
  // word is idle — quiet, not waiting in line.
  return head + 'idle' + progress
}

/**
 * Timer inputs for a row's line-2 meta (#41): the member session whose clock
 * the row shows. Working rows count from the EARLIEST working start (same rule
 * as the old WORKING timer); waiting rows freeze at the longest wait; done rows
 * sum every member's cumulative compute for the `∑` stamp.
 */
export function rowMotionTiming(row: UnifiedWorkRow): MotionTiming {
  const sessions = rowSessions(row)
  const phase = rowMotionPhase(row)
  const since = (s: SessionMeta): number => Date.parse(s.agentState?.since ?? s.lastActiveAt)
  const earliest = (list: SessionMeta[]): SessionMeta | undefined =>
    list.reduce<SessionMeta | undefined>(
      (best, s) => (best === undefined || since(s) < since(best) ? s : best),
      undefined,
    )
  if (phase === 'working') {
    const anchor = earliest(sessions.filter(isSessionWorking))
    if (anchor) {
      const base = anchor.agentState?.workingMsTotal
      return { phase, sinceMs: since(anchor), ...(base !== undefined ? { baseMs: base } : {}) }
    }
  }
  if (phase === 'waiting') {
    const issue = row.kind === 'issue' ? row.issue : undefined
    const anchor = earliest(sessions.filter((s) => motionPhase(s, issue) === 'waiting'))
    if (anchor) {
      return { phase, sinceMs: Date.parse(anchor.offer?.createdAt ?? '') || since(anchor) }
    }
    if (row.kind === 'issue') {
      const pending = pendingDecisionStats(row)
      if (pending.sinceMs !== undefined) return { phase, sinceMs: pending.sinceMs }
    }
  }
  if (phase === 'done') {
    const totals = sessions
      .map((s) => s.agentState?.workingMsTotal)
      .filter((t): t is number => t !== undefined)
    const sinceMs = sessions.reduce((max, s) => Math.max(max, since(s) || 0), 0)
    if (totals.length > 0) {
      return { phase, sinceMs, totalMs: totals.reduce((a, b) => a + b, 0) }
    }
    return { phase, sinceMs }
  }
  return { phase, sinceMs: row.activityAt }
}
