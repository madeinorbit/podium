/**
 * Platform-neutral view-model derivations (issue #15 Phase 4): moved verbatim
 * from apps/web/src/derive.ts so the rewritten mobile app can consume them.
 * NOTHING here may touch the DOM (window/document/localStorage) or web-only
 * modules — the boundary lint and the web shim (apps/web/src/derive.ts, which
 * re-exports everything plus the css-classname helpers) enforce the split.
 */
import {
  DEFER_NEXT_MESSAGE,
  dedupeSessionsByResume,
  isHeadlessSession,
  isIssueSnoozed,
  isSnoozed,
  issueReturnedFromDefer,
  lastUsedMachine,
  machinesForRepo,
  machinesWithRepo,
  normalizeOriginUrl,
  resolveTargetMachine,
  returnedFromSnooze,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  withoutHeadless,
  worktreeForCwd,
} from '@podium/domain'
import type {
  AgentKind,
  GitRepositoryWire,
  HostMetricsWire,
  IssueWire,
  SessionMeta,
} from '@podium/protocol'
import { attentionGroup, compareRecency } from '../focus'
import type { PinState, RepoView, WorktreeView } from './types'

// Entity-pure predicates live in @podium/domain (#194) — client-core imports
// them (above) rather than redefining them, and re-exports the same bindings
// (not new `export const`/`export function` declarations — see
// scripts/check-boundaries.ts rule 7, which flags exactly that shape) so
// existing `@podium/client-core/viewmodels` / `./derive` call sites keep
// working unchanged.
export {
  DEFER_NEXT_MESSAGE,
  dedupeSessionsByResume,
  isHeadlessSession,
  isIssueSnoozed,
  isSnoozed,
  issueReturnedFromDefer,
  lastUsedMachine,
  machinesForRepo,
  machinesWithRepo,
  normalizeOriginUrl,
  resolveTargetMachine,
  returnedFromSnooze,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  withoutHeadless,
  worktreeForCwd,
}

export type MemorySeverity = 'ok' | 'warn' | 'critical'

export interface HostMemoryView {
  hostname: string
  /** Headline: `used/total GB`, e.g. "12.3/32 GB". RAM only — swap never bleeds in. */
  label: string
  /** Used percentage, 0–100. */
  pct: number
  severity: MemorySeverity
  /** Tooltip: hostname + the full numbers, including swap when the host has any. */
  title: string
}

const GIB = 1024 ** 3
const usedGib = (bytes: number): string => (bytes / GIB).toFixed(1)
// Totals are installed capacity — print "32", not "32.0".
const totalGib = (bytes: number): string => {
  const v = bytes / GIB
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** Human size for breakdown rows: "12.3 GB" from 1 GiB up, whole "512 MB" below. */
export function formatMemBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/**
 * Present one host's memory sample. Used = total − available (the kernel's
 * "allocatable without swapping" estimate), the convention of free/htop/Activity
 * Monitor — counting page cache as used would peg every warm box near 100%.
 */
export function hostMemoryView(host: HostMetricsWire): HostMemoryView {
  const m = host.memory
  const usedBytes = Math.max(0, m.totalBytes - m.availableBytes)
  const pct = m.totalBytes > 0 ? Math.round((usedBytes / m.totalBytes) * 100) : 0
  const severity: MemorySeverity = pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : 'ok'
  const label = `${usedGib(usedBytes)}/${totalGib(m.totalBytes)} GB`
  const swap =
    m.swapTotalBytes > 0
      ? ` · swap ${usedGib(Math.max(0, m.swapTotalBytes - m.swapFreeBytes))}/${totalGib(m.swapTotalBytes)} GB`
      : ''
  return {
    hostname: host.hostname,
    label,
    pct,
    severity,
    title: `${host.hostname} — memory ${label} used (${pct}%)${swap}`,
  }
}

export function panelLabel(agentKind: AgentKind): string {
  switch (agentKind) {
    case 'claude-code':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'grok':
      return 'Grok'
    case 'opencode':
      return 'OpenCode'
    case 'cursor':
      return 'Cursor'
    case 'shell':
      return 'Shell'
    default: {
      const exhaustive: never = agentKind
      return exhaustive
    }
  }
}

/**
 * Harnesses that produce a structured transcript — so the chat view, the
 * chat↔live switcher, and the BTW button are offered immediately on spawn,
 * before the first transcript frame arrives. The server's observed
 * `transcriptAvailable` flag still wins when present; this is the fallback.
 */
export function defaultChatCapable(agentKind: AgentKind): boolean {
  return (
    agentKind === 'claude-code' ||
    agentKind === 'grok' ||
    agentKind === 'codex' ||
    agentKind === 'opencode' ||
    agentKind === 'cursor'
  )
}

export function reposToViews(repos: GitRepositoryWire[]): RepoView[] {
  // Scanning a path that contains worktrees returns both the parent repo (with its
  // worktrees[]) and each worktree as its own top-level entry. Drop the standalone
  // duplicates so each worktree shows once, nested under its parent.
  const linkedWorktreePaths = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)))
  const candidates = repos.filter((r) => !linkedWorktreePaths.has(r.path))

  // Group by the server-stamped repoId when present. That lets the server's
  // stable cross-machine identity win even when an older/remote scan lacks an
  // originUrl on the wire. Fall back to normalized origin, then (machineId,path)
  // for local repos without a remote so unrelated originless repos never merge.
  const groups = new Map<string, GitRepositoryWire[]>()
  for (const r of candidates) {
    const origin = normalizeOriginUrl(r.originUrl)
    const key =
      r.repoId ?? (origin !== '' ? origin : `__no_remote__:${r.machineId ?? ''}:${r.path}`)
    const existing = groups.get(key)
    if (existing) {
      existing.push(r)
    } else {
      groups.set(key, [r])
    }
  }

  const views: RepoView[] = []
  for (const [, group] of groups) {
    // Use the first repo's path/name as the canonical identity for the RepoView.
    // The group is always non-empty (we only insert when we have a repo to key).
    if (group.length === 0) continue
    const first: GitRepositoryWire = group[0] as GitRepositoryWire
    const originUrl = group.map((r) => normalizeOriginUrl(r.originUrl)).find((u) => u !== '')
    const repoId = group.find((r) => r.repoId !== undefined)?.repoId

    const worktrees: WorktreeView[] = []
    const machines: { machineId: string; path: string }[] = []

    for (const r of group) {
      const machineId = r.machineId
      if (machineId !== undefined) {
        machines.push({ machineId, path: r.path })
      }
      const main: WorktreeView = {
        path: r.path,
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        repoPath: r.path,
        isMain: true,
        ...(machineId !== undefined ? { machineId } : {}),
        ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
      }
      worktrees.push(main)
      for (const w of r.worktrees) {
        worktrees.push({
          path: w.path,
          ...(w.branch !== undefined ? { branch: w.branch } : {}),
          repoPath: r.path,
          isMain: false,
          ...(machineId !== undefined ? { machineId } : {}),
          ...(r.repoId !== undefined ? { repoId: r.repoId } : {}),
        })
      }
    }

    views.push({
      path: first.path,
      name: first.path.split('/').pop() || first.path,
      worktrees,
      machines,
      ...(originUrl !== undefined ? { originUrl } : {}),
      ...(repoId !== undefined ? { repoId } : {}),
    })
  }

  return views
}

// machinesWithRepo/machinesForRepo/lastUsedMachine/resolveTargetMachine
// (machine-affinity identity) and worktreeForCwd/isHeadlessSession/
// withoutHeadless (worktree + session identity) are entity-pure — imported
// from @podium/domain above and re-exported, not redefined here (#194).

/** Sessions shown in a worktree's tab strip / sidebar — archived ones stay out.
 *  With `allWorktreePaths`, membership is by CONTAINMENT (worktreeForCwd), so a
 *  session whose stamped cwd is a subdirectory of the worktree still shows in it
 *  instead of vanishing from every group. Without it, legacy exact-match. */
export function sessionsForWorktree(
  sessions: SessionMeta[],
  worktreePath: string,
  allWorktreePaths?: string[],
): SessionMeta[] {
  return sessions.filter(
    (s) =>
      !s.archived &&
      !isHeadlessSession(s) &&
      (allWorktreePaths
        ? worktreeForCwd(s.cwd, allWorktreePaths) === worktreePath
        : s.cwd === worktreePath),
  )
}

/** One session's worktree change, as seen between two `sessions` snapshots. */
export interface WorktreeMove {
  sessionId: string
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

/** Resolve a session's cwd to its repo name + branch, for the pinned-panel
 *  badge — pinned panels span repos/worktrees, so "which repo/branch" is what
 *  tells them apart. Null when the cwd isn't a known worktree (e.g. a session
 *  spawned in a path discovery hasn't indexed). */
export function repoBranchForCwd(
  repos: GitRepositoryWire[],
  cwd: string,
): { repo: string; branch?: string } | null {
  for (const repo of reposToViews(repos)) {
    for (const worktree of repo.worktrees) {
      if (worktree.path === cwd) {
        return {
          repo: repo.name,
          ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
        }
      }
    }
  }
  return null
}

/** Does `cwd` still resolve to a live, scanned worktree? False when the path is
 *  no longer among any repo's worktrees — e.g. a session whose git worktree was
 *  removed out from under it (an "orphaned" session). Also false when no repos
 *  are loaded yet; callers that must not flag orphans during the boot window
 *  should gate on `repos.length > 0` themselves. */
export function isKnownWorktreePath(repos: GitRepositoryWire[], cwd: string): boolean {
  return repoBranchForCwd(repos, cwd) !== null
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

/** The recovery action offered for a session whose process has exited. */
export type ExitedAction = 'restart' | 'resume' | 'remove'

/** Copy + recovery action for an exited session, shared by the inline
 *  `ExitedBanner` and the full-pane `ExitedPane` so the two never drift.
 *
 *  Orthogonal to the exit cause, a missing worktree (an orphaned session whose
 *  directory was removed out from under it) forces `remove`: the conversation
 *  can't be resumed in place — Claude buckets transcripts by their original cwd,
 *  and a shell can't restart in a directory that's gone. The header's
 *  copy-resume-command stays available for resuming by hand elsewhere. */
export function exitedRecovery(opts: {
  exitCode: number | undefined
  isShell: boolean
  resumable: boolean
  worktreeMissing: boolean
  /** Pretty worktree path, woven into the notice when the worktree is missing. */
  worktreePath?: string
}): { detail: string; action: ExitedAction } {
  const what = opts.isShell ? 'shell' : 'agent process'
  // Exit code 0 can still be an external kill of the durable host (the PTY
  // reports the attach client's exit, not the agent's) — stay neutral about why.
  const cause =
    opts.exitCode === undefined || opts.exitCode === 0
      ? `The ${what} is no longer running.`
      : opts.exitCode === -1
        ? `The ${what} failed to start.`
        : `The ${what} exited with code ${opts.exitCode}.`
  if (opts.worktreeMissing) {
    const where = opts.worktreePath ? ` (${opts.worktreePath})` : ''
    return {
      detail: `${cause} Its worktree${where} no longer exists, so it can't be resumed here.`,
      action: 'remove',
    }
  }
  return { detail: cause, action: opts.isShell ? 'restart' : opts.resumable ? 'resume' : 'remove' }
}

export interface WorktreeNavView extends WorktreeView {
  repoName: string
  sessions: SessionMeta[]
  /** Non-archived issues whose worktree this is. When non-empty, the sidebar
   *  renders the issue block(s) instead of the bare worktree row. */
  issues: IssueWire[]
}

export interface RepoNavView {
  path: string
  name: string
  worktrees: WorktreeNavView[]
  machines?: { machineId: string; path: string }[]
  originUrl?: string
  repoId?: string
}

export interface SidebarSections {
  pinnedPanels: SessionMeta[]
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }

// isSnoozed/returnedFromSnooze/snoozeUntil1h/snoozeUntilTomorrow5am (session
// snooze) and isIssueSnoozed/issueReturnedFromDefer (issue defer — dedupes
// against @podium/domain's isIssueDeferred) are entity-pure — imported from
// @podium/domain above and re-exported, not redefined here (#194).

/** A parent/epic's direct children, seq-ordered, INCLUDING archived ones (issue
 *  #133). The subissue list keeps archived children visible (the UI marks them
 *  archived) rather than dropping them, so archiving a child doesn't silently
 *  vanish it from its parent. Scoped to the subissue list — the main board's
 *  default hide-archived behavior is unchanged. */
export function subIssuesOf(issues: readonly IssueWire[], parentId: string): IssueWire[] {
  return issues.filter((i) => i.parentId === parentId && !i.deletedAt).sort((a, b) => a.seq - b.seq)
}

export function sortSessionsForPins(sessions: SessionMeta[], pins: PinState): SessionMeta[] {
  const panelOrder = orderMap(pins.panels)
  return [...sessions].sort((left, right) =>
    comparePinned(left.sessionId, right.sessionId, panelOrder),
  )
}

/**
 * Sidebar session order: non-snoozed attention first, then snoozed attention
 * (de-emphasised), then working sessions at the bottom. Within each rank,
 * most-recently-active first.
 */
export function sortSessionsForSidebar(
  sessions: SessionMeta[],
  now: number = Date.now(),
): SessionMeta[] {
  // Rank 0 = needs-you/idle and not snoozed (top); 1 = attention but snoozed
  // (de-emphasised, just above working); 2 = working (bottom).
  const rank = (s: SessionMeta): number => {
    if (attentionGroup(s) === 'working') return 2
    return isSnoozed(s, now) ? 1 : 0
  }
  return [...sessions].sort((a, b) => {
    const dr = rank(a) - rank(b)
    if (dr !== 0) return dr
    return compareRecency(a, b, now)
  })
}

/**
 * Tab-strip order for one worktree. The user's manual (drag) order wins; sessions
 * it doesn't know about — panels opened after the last drag — append at the end
 * in the default pin-aware order.
 */
export function orderTabs(
  sessions: SessionMeta[],
  manualOrder: string[] | undefined,
  pins: PinState,
): SessionMeta[] {
  const base = sortSessionsForPins(sessions, pins)
  if (!manualOrder || manualOrder.length === 0) return base
  const position = orderMap(manualOrder)
  const known = base
    .filter((s) => position.has(s.sessionId))
    .sort((a, b) => (position.get(a.sessionId) ?? 0) - (position.get(b.sessionId) ?? 0))
  const unknown = base.filter((s) => !position.has(s.sessionId))
  return [...known, ...unknown]
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
  issues: IssueWire[] = [],
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)
  sessions = sidebarSessions(sessions)
  // worktree path → its non-archived issues (an issue owns at most one worktree;
  // several issues may point at the same worktree — the worktree shows under each).
  const issuesByWorktree = new Map<string, IssueWire[]>()
  for (const issue of issues) {
    if (issue.archived || !issue.worktreePath) continue
    const list = issuesByWorktree.get(issue.worktreePath)
    if (list) list.push(issue)
    else issuesByWorktree.set(issue.worktreePath, [issue])
  }

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  // Pinned panels are ordered by agent state (same comparator as the repo
  // sections) rather than pin-insertion order, so the whole sidebar reads
  // consistently — needs-you first, working sunk to the bottom.
  const pinnedPanels = sortSessionsForSidebar(
    pins.panels
      .map((sessionId) => sessions.find((session) => session.sessionId === sessionId))
      .filter(
        (session): session is SessionMeta => session !== undefined && !isHeadlessSession(session),
      ),
  )

  // A pinned panel still appears in its own repo/worktree list (it's not removed
  // from there) — pinning lifts a copy into PINNED PANELS for quick reach without
  // hiding it from its home. The selected highlight lights up in both places.
  const allWorktreePaths = allWorktrees.map(({ worktree }) => worktree.path)
  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(
      sessionsForWorktree(sessions, worktree.path, allWorktreePaths),
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
    pinnedPanels,
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
 * Partition sessions into the three WORK ITEMS buckets used by the home board
 * and sidebar work-items view.
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

  // Every WORK ITEMS section reads newest-active first (the home board and repo
  // tree already do). Without this the buckets kept raw arrival order, which put
  // the newest session at the BOTTOM of NEEDS YOUR ATTENTION.
  attention.sort((a, b) => compareRecency(a, b, now))
  working.sort((a, b) => compareRecency(a, b, now))
  pinnedPanels.sort((a, b) => compareRecency(a, b, now))
  return { attention, working, pinnedPanels }
}

// dedupeSessionsByResume (collapsing duplicate rows for the same underlying
// agent conversation) is entity-pure — imported from @podium/domain above and
// re-exported, not redefined here (#194).

/** A session is "stale" when it's been inactive longer than this. */
export const STALE_INACTIVE_MS = 16 * 60 * 60 * 1000

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

export interface IssueNavView {
  issue: IssueWire
  repoName: string
  sessions: SessionMeta[]
  activityAt: number
}

/** Sessions living in an issue's worktree — exact cwd match or nested under it.
 *  Mirrors the server's sessionsForIssue membership so the sidebar count stays
 *  live between issuesChanged broadcasts. */
function sessionsForIssueWorktree(
  sessions: SessionMeta[],
  worktreePath: string | null,
): SessionMeta[] {
  if (!worktreePath) return []
  return sessions.filter(
    (s) =>
      !isHeadlessSession(s) && (s.cwd === worktreePath || s.cwd.startsWith(`${worktreePath}/`)),
  )
}

/** Flat, activity-sorted issue list for the sidebar Issues tab. Each issue carries
 *  its live sessions (from the session stream, not the wire snapshot) so badges and
 *  ordering stay fresh. Archived issues are dropped. Most-recently-active first;
 *  issues with no sessions fall back to their updatedAt. */
export function issueNavList(
  issues: IssueWire[],
  sessions: SessionMeta[],
  now: number = Date.now(),
): IssueNavView[] {
  const views = issues
    .filter((i) => !i.archived && !i.deletedAt)
    .map((issue): IssueNavView => {
      const mine = sortSessionsForSidebar(
        sessionsForIssueWorktree(sessions, issue.worktreePath),
        now,
      )
      const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
      const activityAt = lastSession || Date.parse(issue.updatedAt) || 0
      const repoName = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
      return { issue, repoName, sessions: mine, activityAt }
    })
  return views.sort((a, b) => b.activityAt - a.activityAt)
}

/** Narrow the issue list by the sidebar filter text — issue title, repo name, or stage. */
export function filterIssueNav(list: IssueNavView[], query: string): IssueNavView[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (v) =>
      v.issue.title.toLowerCase().includes(q) ||
      v.repoName.toLowerCase().includes(q) ||
      v.issue.stage.toLowerCase().includes(q),
  )
}

/** Explicit-attachment-first session grouping for an issue row (issue-as-workspace):
 *  sessions with `issueId === issue.id` are first-class members; sessions with NO
 *  issueId fall back to cwd containment in the issue's worktree (legacy). A session
 *  attached to a DIFFERENT issue never shows here even if its cwd is contained.
 *  Archived + headless sessions are always excluded; shells are excluded by default
 *  (sidebar policy) — the workspace tab strip opts them back in. */
export function sessionsForIssueNav(
  issue: IssueWire,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  opts: { includeShells?: boolean } = {},
): SessionMeta[] {
  const wt = issue.worktreePath
  // Longest-match containment needs the full root list (a repo root contains its
  // own .worktrees/* checkouts); make sure the issue's own worktree is in it.
  const roots = wt && !allWorktreePaths.includes(wt) ? [...allWorktreePaths, wt] : allWorktreePaths
  return sessions.filter((s) => {
    if (s.archived || isHeadlessSession(s)) return false
    if (!opts.includeShells && s.agentKind === 'shell') return false
    if (s.issueId !== undefined) return s.issueId === issue.id
    if (!wt) return false
    return worktreeForCwd(s.cwd, roots) === wt
  })
}

/** Pane target when a sidebar issue/worktree row is clicked: keep the current
 *  pane if it's already one of the row's members (a session in `members` or an
 *  id in `extraValidIds` — e.g. the row's open file tabs); otherwise open the
 *  row's most recently active session (lastActiveAt, ISO-comparable). Null =
 *  nothing to open (empty row) — clear the pane so the picker shows. */
export function pickPaneSession(
  members: SessionMeta[],
  paneA: string | null,
  extraValidIds: readonly string[] = [],
): string | null {
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

/** The ARCHIVED members of an issue — same membership rule as
 *  {@link sessionsForIssueNav} (explicit `issueId` first, else cwd containment)
 *  but inverted on `archived`. Drives the tab strip's "N archived" reveal so a
 *  hidden-away session stays reopenable. Headless sessions never count. */
export function archivedSessionsForIssue(
  issue: IssueWire,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): SessionMeta[] {
  const wt = issue.worktreePath
  const roots = wt && !allWorktreePaths.includes(wt) ? [...allWorktreePaths, wt] : allWorktreePaths
  return sessions.filter((s) => {
    if (!s.archived || isHeadlessSession(s)) return false
    if (s.issueId !== undefined) return s.issueId === issue.id
    if (!wt) return false
    return worktreeForCwd(s.cwd, roots) === wt
  })
}

/** The ARCHIVED sessions contained in a worktree path — the inverse of
 *  {@link sessionsForWorktree} on `archived`, for the tab strip's reveal. */
export function archivedSessionsForWorktreePath(
  sessions: SessionMeta[],
  worktreePath: string,
  allWorktreePaths?: string[],
): SessionMeta[] {
  return sessions.filter(
    (s) =>
      s.archived &&
      !isHeadlessSession(s) &&
      (allWorktreePaths
        ? worktreeForCwd(s.cwd, allWorktreePaths) === worktreePath
        : s.cwd === worktreePath),
  )
}

/** Row label for a DRAFT issue (placeholder-titled vessel): the attached session's
 *  display name, falling back to 'New agent'. Mirrors sessionDisplayName's
 *  name-beats-title rule (WorkerLabel imports from this module, so the tiny
 *  normalize step is inlined here rather than imported — no cycle). */
export function draftIssueLabel(
  issue: IssueWire,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): string {
  const first = sessionsForIssueNav(issue, sessions, allWorktreePaths)[0]
  if (!first) return 'New agent'
  const title = first.title.replace(/^[\p{So}\p{Sk}·•\s]+/u, '').trim()
  return first.name?.trim() || title || 'New agent'
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
/** Most-recent session activity per raw repo wire (containment over the repo
 *  root and its linked worktrees) — for sorting repo pickers by recent use. */
export function repoUsageAt(repo: GitRepositoryWire, sessions: SessionMeta[]): number {
  const roots = [repo.path, ...repo.worktrees.map((w) => w.path)]
  let max = 0
  for (const s of sessions) {
    if (!roots.some((r) => s.cwd === r || s.cwd.startsWith(`${r}/`))) continue
    const ts = Date.parse(s.lastActiveAt) || 0
    if (ts > max) max = ts
  }
  return max
}

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

/** The worktree the unified "New <Agent> in <Repo>" button spawns into, plus the
 *  clone's own display name. A RepoNavView can aggregate SEVERAL local clones of
 *  the same origin (reposToViews groups by normalized origin URL), so it may hold
 *  multiple `isMain` worktrees — spawning must target the clone the user actually
 *  works in, not whichever clone happened to be scanned first. Pick the main with
 *  the most recent session activity (`byWorktree` from {@link lastUsedMaps});
 *  with no activity anywhere, prefer the RepoView's canonical path; else first. */
export function spawnTargetForRepo(
  repo: RepoNavView,
  machineId?: string,
): {
  worktree: WorktreeView
  repoName: string
} {
  const viewFor = (worktree: WorktreeNavView | WorktreeView): WorktreeView => {
    const {
      repoName: _repoName,
      sessions: _sessions,
      issues: _issues,
      ...view
    } = worktree as WorktreeNavView
    return view
  }

  if (machineId !== undefined) {
    const machinePath = repo.machines?.find((m) => m.machineId === machineId)?.path
    const chosen =
      repo.worktrees.find(
        (w) =>
          w.machineId === machineId &&
          w.isMain &&
          (machinePath === undefined || w.path === machinePath),
      ) ?? repo.worktrees.find((w) => w.machineId === machineId && w.isMain)
    if (chosen) return { worktree: viewFor(chosen), repoName: repo.name }
    if (machinePath !== undefined) {
      return {
        worktree: {
          path: machinePath,
          repoPath: machinePath,
          isMain: true,
          machineId,
          ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
        },
        repoName: repo.name,
      }
    }
  }

  // The primary worktree is the repo's OWN main checkout (path === repo.path) —
  // never a sibling clone that origin-grouping folded into this RepoView, and
  // never a linked worktree. The label is always the repo's registered name.
  const chosen =
    repo.worktrees.find((w) => w.isMain && w.path === repo.path) ??
    repo.worktrees.find((w) => w.path === repo.path)
  if (!chosen) {
    // Filtered out of the nav (e.g. pinned away) or a clone-canonical mismatch —
    // reconstruct the repo's own main checkout, same fallback as repoPrimaryWorktree.
    return {
      worktree: {
        path: repo.path,
        repoPath: repo.path,
        isMain: true,
        ...(repo.repoId !== undefined ? { repoId: repo.repoId } : {}),
      },
      repoName: repo.name,
    }
  }
  return { worktree: viewFor(chosen), repoName: repo.name }
}

/**
 * Urgency rank of one session for the unified WORK list ordering:
 *   0 — needs the human NOW (attention state, not snoozed, process still around)
 *   1 — working (running fine without us)
 *   2 — ready/idle and recently active
 *   3 — stale (long-quiet), exited, or otherwise dormant
 * Built on the same primitives every other surface uses (attentionGroup,
 * isSnoozed, STALE_INACTIVE_MS) so "urgent" means the same thing everywhere.
 */
export function sessionUrgencyRank(s: SessionMeta, now: number): number {
  const group = attentionGroup(s)
  if (group === 'working') return 1
  const recent = now - Date.parse(s.lastActiveAt) <= STALE_INACTIVE_MS
  // Anything non-working that classic counted as attention — a blocked agent OR
  // a just-FINISHED one (idle/done) — floats above working, exactly like the old
  // NEEDS YOUR ATTENTION section did. Snoozed sessions are muted to rank 2; only
  // long-quiet or exited sessions sink to stale.
  if (!isSnoozed(s, now) && s.status !== 'exited' && recent) return 0
  return recent && s.status !== 'exited' ? 2 : 3
}

/** The row's most urgent child session (lowest urgency rank, recency tiebreak) —
 *  drives the row's right-side status dot. Undefined for session-less rows. */
export function mostUrgentSession(
  sessions: SessionMeta[],
  now: number = Date.now(),
): SessionMeta | undefined {
  let best: SessionMeta | undefined
  for (const s of sessions) {
    if (!best) {
      best = s
      continue
    }
    const dr = sessionUrgencyRank(s, now) - sessionUrgencyRank(best, now)
    if (dr < 0 || (dr === 0 && compareRecency(s, best, now) < 0)) best = s
  }
  return best
}

/** Rank of rows with NO sessions — sinks below every session-bearing row. */
export const UNIFIED_ROW_EMPTY_RANK = 4

/** One row of the unified sidebar's WORK LIST: a human-origin issue (drafts
 *  included) or a with-session worktree not owned by any issue. `rank` is the
 *  min of the child sessions' urgency ranks (UNIFIED_ROW_EMPTY_RANK when none). */
export type UnifiedWorkRow =
  | { kind: 'issue'; issue: IssueWire; sessions: SessionMeta[]; activityAt: number; rank: number }
  | { kind: 'worktree'; worktree: WorktreeNavView; activityAt: number; rank: number }

/** Whether a unified WORK/WORKING row should render with unread (email-style)
 *  emphasis. An issue row follows the issue's own server-derived `unread` flag
 *  (which already aggregates member-session activity), so marking the issue read
 *  clears it. A worktree row owns no `unread` field of its own, so it's unread
 *  iff any of its sessions is. (#126, built on the #124 unread foundation.) */
export function isRowUnread(row: UnifiedWorkRow): boolean {
  return row.kind === 'issue' ? row.issue.unread : row.worktree.sessions.some((s) => s.unread)
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
 */
function buildUnifiedRows(
  sections: SidebarSections,
  issues: IssueWire[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number,
): UnifiedWorkRow[] {
  const rows: UnifiedWorkRow[] = []
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt) continue
    const mine = sortSessionsForSidebar(sessionsForIssueNav(issue, sessions, allWorktreePaths), now)
    // Require ≥1 live session — a worktree or non-backlog stage no longer floats a
    // session-less issue into the list.
    if (mine.length === 0) continue
    // #198: hide the agent's INTERNAL work (audience: 'agent') from the sidebar
    // work list — keyed on audience, matching the board's filterBoardScope, so an
    // agent-cut human-facing epic (origin agent, audience human) appears on both.
    if (!issue.draft && issue.audience !== 'human') continue
    const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
    rows.push({
      kind: 'issue',
      issue,
      sessions: mine,
      activityAt: lastSession || Date.parse(issue.updatedAt) || 0,
      rank: rowRank(mine, now),
    })
  }
  const liveIssueIds = new Set(issues.filter((i) => !i.archived && !i.deletedAt).map((i) => i.id))
  const seen = new Set<string>()
  const navWorktrees = [
    ...sections.pinnedWorktrees,
    ...sections.pinnedRepos.flatMap((r) => r.worktrees),
    ...sections.repos.flatMap((r) => r.worktrees),
  ]
  for (const wt of navWorktrees) {
    if (seen.has(wt.path) || wt.issues.length > 0) continue
    seen.add(wt.path)
    const unowned = wt.sessions.filter((s) => !(s.issueId && liveIssueIds.has(s.issueId)))
    if (unowned.length === 0) continue
    const lastSession = unowned.reduce(
      (max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0),
      0,
    )
    rows.push({
      kind: 'worktree',
      worktree: { ...wt, sessions: unowned },
      activityAt: lastSession,
      rank: rowRank(unowned, now),
    })
  }
  return rows
}

/** Band for the WORK list: pinned or returned-from-defer issues float to the top
 *  (0), snoozed issues sink to the bottom (2), everything else sits in the middle
 *  (1). Worktree rows have no such state, so they're always the middle band. */
function unifiedRowBand(row: UnifiedWorkRow, now: number): number {
  if (row.kind === 'issue') {
    if (row.issue.pinned || issueReturnedFromDefer(row.issue, now)) return 0
    if (isIssueSnoozed(row.issue, now)) return 2
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

/** WORK-list order: band asc (pinned/returned top, snoozed bottom — explicit
 *  user actions only), then newest-first creation order. Urgency, activity and
 *  updatedAt deliberately do NOT sort — attention is carried per-row by the
 *  square language / amber pill / motion meta, never by reordering, so rows
 *  hold still while agents work (#64). */
function sortUnifiedWorkRows(rows: UnifiedWorkRow[], now: number): UnifiedWorkRow[] {
  return [...rows].sort((a, b) => {
    const db = unifiedRowBand(a, now) - unifiedRowBand(b, now)
    if (db !== 0) return db
    return compareCreationDesc(a, b)
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
  issues: IssueWire[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkRow[] {
  return sortUnifiedWorkRows(
    buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now),
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
  /** WORKING rows/sessions, most-recently-active first. */
  working: WorkingEntry[]
  /** The WORK list (banded order), minus whatever moved to WORKING. */
  work: UnifiedWorkRow[]
}

function rowSessions(row: UnifiedWorkRow): SessionMeta[] {
  return row.kind === 'issue' ? row.sessions : row.worktree.sessions
}

/** Rebuild a WORK row around a filtered session set, recomputing its rank +
 *  activity so ordering stays coherent after working sessions are lifted out. */
function rowWithSessions(row: UnifiedWorkRow, keep: SessionMeta[], now: number): UnifiedWorkRow {
  const activityAt = keep.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
  if (row.kind === 'issue') {
    return {
      ...row,
      sessions: keep,
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

function workingEntryActivity(e: WorkingEntry): number {
  return e.kind === 'session' ? Date.parse(e.session.lastActiveAt) || 0 : e.row.activityAt
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
 * WORK keeps the banded order; WORKING reads most-recently-active first.
 */
export function partitionUnifiedWork(
  sections: SidebarSections,
  issues: IssueWire[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkPartition {
  const rows = buildUnifiedRows(sections, issues, sessions, allWorktreePaths, now)
  const working: WorkingEntry[] = []
  const work: UnifiedWorkRow[] = []
  for (const row of rows) {
    if (row.kind === 'issue' && row.issue.pinned) {
      work.push(row)
      if (row.sessions.some(isSessionWorking)) working.push({ kind: 'issue', row })
      continue
    }
    const mine = rowSessions(row)
    const runningNow = mine.filter(isSessionWorking)
    if (runningNow.length > 0 && runningNow.length === mine.length) {
      working.push(row.kind === 'issue' ? { kind: 'issue', row } : { kind: 'worktree', row })
    } else if (runningNow.length > 0) {
      work.push(
        rowWithSessions(
          row,
          mine.filter((s) => !isSessionWorking(s)),
          now,
        ),
      )
      for (const s of runningNow) working.push({ kind: 'session', session: s })
    } else {
      work.push(row)
    }
  }
  working.sort((a, b) => workingEntryActivity(b) - workingEntryActivity(a))
  return { working, work: sortUnifiedWorkRows(work, now) }
}

export interface UnifiedWorkGroup {
  key: string
  label: string
  rows: UnifiedWorkRow[]
}

/**
 * Bucket unified WORK rows by repo (stable repoId when known, repoPath
 * otherwise — so the same repo on two machines/paths merges into one group).
 * Row order inside a group and group order both follow the incoming fixed
 * creation order: a group sits where its first (newest-created) row would.
 */
export function groupUnifiedWorkRows(rows: UnifiedWorkRow[]): UnifiedWorkGroup[] {
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
      group = { key, label, rows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

function orderMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}

function comparePinned(leftId: string, rightId: string, order: Map<string, number>): number {
  const leftOrder = order.get(leftId)
  const rightOrder = order.get(rightId)
  if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
  if (leftOrder !== undefined) return -1
  if (rightOrder !== undefined) return 1
  return 0
}

export interface AgentBadge {
  label: string
  tone: 'working' | 'idle' | 'attention' | 'error' | 'muted'
  showContinue: boolean
}

/** Map harness-observed runtime state to the little badge on a session row.
 *  Null = nothing to show (uninstrumented agent kinds stay clean). */
export function agentBadge(meta: SessionMeta): AgentBadge | null {
  const s = meta.agentState
  if (!s || s.phase === 'unknown') return null
  switch (s.phase) {
    case 'working':
      return { label: 'working', tone: 'working', showContinue: false }
    case 'compacting':
      return { label: 'compacting', tone: 'working', showContinue: false }
    case 'idle': {
      switch (s.idle?.kind) {
        case 'question':
          return { label: 'needs answer', tone: 'attention', showContinue: false }
        case 'approval':
          return { label: 'plan ready', tone: 'attention', showContinue: false }
        case 'open_todos':
          return { label: 'todos open', tone: 'attention', showContinue: false }
        case 'interrupted':
          return { label: 'interrupted', tone: 'idle', showContinue: false }
        default:
          return { label: 'idle', tone: 'idle', showContinue: false }
      }
    }
    case 'needs_user':
      return {
        label: s.need?.kind === 'question' ? 'needs answer' : 'needs permission',
        tone: 'attention',
        showContinue: false,
      }
    case 'errored':
      return {
        label: `error: ${s.error?.class ?? 'unknown'}`,
        tone: 'error',
        showContinue: s.error?.retryable ?? false,
      }
    case 'ended':
      return { label: 'ended', tone: 'muted', showContinue: false }
  }
}

export interface ChatActivity {
  label: string
  tone: AgentBadge['tone']
}

/**
 * The activity row shown pinned to the bottom of the chat view, or null for
 * nothing. Reuses `agentBadge` for instrumented agents; falls back to the PTY
 * `busy` signal for uninstrumented kinds; and shows an optimistic "Sending…"
 * immediately after a submit (`justSent`) before the first `working` event lands.
 */
export function chatActivity(
  meta: SessionMeta | undefined,
  justSent: boolean,
): ChatActivity | null {
  if (!meta) return null
  const badge = agentBadge(meta)
  if (badge?.tone === 'working') {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  if (!meta.agentState && meta.busy) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}

// Four semantic status colours, identical across every surface (sidebar, tabs,
// home board, chat) so a colour means the same thing everywhere:
//   working   → green   (agent running / shell command running)
//   attention → yellow  (needs you: question / approval / permission)
//   error     → red
//   ready     → blue    (idle-and-waiting, a fresh agent, or a shell at its prompt)
//   neutral   → grey    (exited carries no live colour)
export type DotTone = 'working' | 'attention' | 'error' | 'ready' | 'neutral'

/**
 * The status-dot tone for a session row/tab/card — the single source of truth
 * for agent colour, shared by every mode so the semantics never drift.
 *
 * Hibernated sessions KEEP their last real status colour: the server preserves
 * `agentState` across a hibernate (the kill is the expected result, so `onExit`
 * leaves the phase intact), so a hibernated agent that "needs input" still reads
 * yellow. Hibernation is conveyed only by the grayed/italic `.dot.parked` row, not
 * by draining the dot to grey.
 */
export function sessionDotTone(s: SessionMeta): DotTone {
  // Exited (process gone, phase cleared server-side): no live status colour.
  if (s.status === 'exited') return 'neutral'
  // Booting / brief reconnect: not working yet → blue.
  if (s.status === 'starting' || s.status === 'reconnecting') return 'ready'
  const badge = agentBadge(s)
  if (badge) {
    switch (badge.tone) {
      case 'working':
        return 'working'
      case 'attention':
        return 'attention'
      case 'error':
        return 'error'
      case 'idle': // finished a turn, nothing pending → ready for your next message
        return 'ready'
      case 'muted': // ended
        return 'neutral'
    }
  }
  // Uninstrumented live session: a shell is "working" (green) only while a command
  // runs; otherwise it — and a fresh agent that hasn't started a turn — is blue.
  if (s.agentKind === 'shell') return s.busy ? 'working' : 'ready'
  return 'ready'
}

// The agent's `/color` identity accent (Claude's named colours) → a vivid,
// theme-independent hex, shown as the tab/sidebar accent line. This is *identity*
// (which agent), distinct from the status dot (what it's doing). Unknown/absent
// → undefined (no accent).
const AGENT_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
  orange: '#f97316',
  pink: '#ec4899',
  cyan: '#06b6d4',
}
export function agentColorHex(name: string | undefined): string | undefined {
  return name ? AGENT_COLOR_HEX[name.toLowerCase()] : undefined
}

/**
 * Is the session actively doing work right now? The single predicate behind the
 * close/archive guard (#115) — kept in lock-step with the green status dot
 * (`sessionDotTone === 'working'`), so "still working" in a confirm prompt means
 * exactly what the green dot does: an instrumented agent in its `working` /
 * `compacting` phase, or an uninstrumented shell with a command running (`busy`).
 */
export function isSessionWorking(s: SessionMeta): boolean {
  return sessionDotTone(s) === 'working'
}

/**
 * The four phases of the redesign's motion grammar (.design/specs/motion.md):
 * only `working` moves (braille spinner + counting timer); `waiting` is amber
 * stillness after a one-shot flash ("needs you"); `done` is a still ✓; `queued`
 * is dimmed stillness for everything not yet (or no longer) in play.
 */
export type MotionPhase = 'queued' | 'working' | 'waiting' | 'done'

/**
 * Collapse harness phase + shell busyness + liveness into the motion phase.
 * Kept in lock-step with the existing grammar: `waiting` is exactly
 * `attentionGroup === 'needsYou'` (question/permission/error/open todos —
 * hibernated sessions keep their last phase, so a parked "needs input" still
 * reads amber), and `working` is exactly `isSessionWorking` (the green-dot
 * predicate). A finished run (`idle.kind === 'done'` or `ended`) is `done`;
 * starting/exited/uninstrumented-quiet sessions fall through to `queued`.
 */
export function motionPhase(s: SessionMeta): MotionPhase {
  const state = s.agentState
  if (state?.phase === 'ended' || (state?.phase === 'idle' && state.idle?.kind === 'done')) {
    return 'done'
  }
  if (attentionGroup(s) === 'needsYou') return 'waiting'
  if (isSessionWorking(s)) return 'working'
  return 'queued'
}

/** Canonical timer inputs derived from one session's persisted runtime state.
 *  `baseMs` feeds a live working counter; `totalMs` feeds the stopped ∑ stamp.
 *  Both stay absent for legacy sessions that do not carry cumulative timing data. */
export interface MotionTiming {
  phase: MotionPhase
  sinceMs: number
  baseMs?: number
  totalMs?: number
}

export function motionTiming(s: SessionMeta): MotionTiming {
  const phase = motionPhase(s)
  const sinceMs = Date.parse(s.agentState?.since ?? s.lastActiveAt)
  const total = s.agentState?.workingMsTotal
  if (total === undefined) return { phase, sinceMs }
  if (phase === 'working') return { phase, sinceMs, baseMs: total }
  if (phase === 'done') return { phase, sinceMs, totalMs: total }
  return { phase, sinceMs }
}

/**
 * Compact clock for the motion timer/∑ stamps: `6:30`, `0:07`, `72:15` —
 * minutes never roll into hours (matches the handoff's `m:ss` format).
 * `formatElapsed` remains the format for non-motion surfaces.
 */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Aggregate motion phase for one unified WORK row (#41): the row wears the most
 * human-relevant of its member sessions' phases. `waiting` dominates (stillness
 * is the signal — a row that needs you must read amber even while other agents
 * grind on), then `working`, then `done` when every member finished; a row
 * whose sessions are merely idle/ready reads `queued` (dimmed stillness).
 */
export function rowMotionPhase(row: UnifiedWorkRow): MotionPhase {
  const sessions = rowSessions(row)
  const phases = sessions.map(motionPhase)
  if (phases.includes('waiting')) return 'waiting'
  if (phases.includes('working')) return 'working'
  if (phases.length > 0 && phases.every((p) => p === 'done')) return 'done'
  return 'queued'
}

/** How many member sessions are waiting on the human — drives the amber count
 *  pill on wide rows and the numbered corner badge on rail squares (#41). */
export function rowWaitingCount(row: UnifiedWorkRow): number {
  return rowSessions(row).filter((s) => motionPhase(s) === 'waiting').length
}

/**
 * The row's second line (#41): a compact status phrase in the handoff's copy
 * grammar. Waiting rows surface WHAT is being waited for (the most urgent
 * session's badge label — "needs answer", "plan ready"); working/queued/done
 * rows read as their phase; multi-agent rows carry the head-count.
 */
export function rowStatusLine(row: UnifiedWorkRow, now: number = Date.now()): string {
  const sessions = rowSessions(row)
  const phase = rowMotionPhase(row)
  const head = sessions.length > 1 ? `${sessions.length} agents · ` : ''
  if (phase === 'waiting') {
    const urgent = mostUrgentSession(
      sessions.filter((s) => motionPhase(s) === 'waiting'),
      now,
    )
    const label = urgent ? (agentBadge(urgent)?.label ?? 'needs you') : 'needs you'
    return head + label
  }
  if (phase === 'working') return head + 'working'
  if (phase === 'done') return head + 'done'
  return head + 'queued'
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
    const anchor = earliest(sessions.filter((s) => motionPhase(s) === 'waiting'))
    if (anchor) return { phase, sinceMs: since(anchor) }
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

/**
 * The native CLI command that resumes this session's conversation, for #119
 * (show + copy). Mirrors the canonical builder in
 * `@podium/agent-bridge`'s `agentLaunchCommand` (the single place the daemon
 * actually spawns resumes) — the web app doesn't depend on agent-bridge, so the
 * per-CLI resume flag is replicated here. Keyed off the harness-supplied
 * `ResumeRef.kind` (set by each discovery provider) rather than `agentKind`, so
 * the command always matches the ref the daemon would replay. Null when no
 * resume ref is known (shells, not-yet-resumable sessions).
 */
export function resumeCommand(s: SessionMeta): string | null {
  const ref = s.resume
  if (!ref) return null
  const id = shellQuote(ref.value)
  switch (ref.kind) {
    case 'claude-session':
      return `claude --resume ${id}`
    case 'codex-thread':
      return `codex resume ${id}`
    case 'grok-session':
      return `grok --resume ${id}`
    case 'opencode-session':
      return `opencode --session ${id}`
    case 'cursor-chat':
      // Cursor's CLI binary is `agent` (Cursor Agent) — see resolveCursorBin.
      return `agent --resume ${id}`
    default:
      // Unknown ref kind — fall back to the agent kind's flag so a future
      // provider still produces a usable command rather than nothing.
      return `${s.agentKind} --resume ${id}`
  }
}

/** Single-quote a resume id for shell safety only when it isn't a bare token
 *  (uuids / thread ids are bare; quote anything with a shell metacharacter). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
