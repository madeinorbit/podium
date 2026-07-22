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
  repoNameFromOrigin,
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
  repoNameFromOrigin,
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
      // Name the repo by its ORIGIN, not the folder it happens to sit in: a backup
      // clone at ~/bak_podium of .../podium.git is still "podium", and this name is
      // what the sidebar's "New <agent> in <repo>" and the rail/palette show. Only
      // an originless repo is named after its folder — that is all we know about it.
      // `originUrl` here is already normalized (host/owner/repo); the helper is
      // idempotent over that. [spec:SP-3701]
      name: repoNameFromOrigin(originUrl) ?? (first.path.split('/').pop() || first.path),
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

/** Precomputed session ownership for one immutable sidebar snapshot. */
export interface SessionOwnershipIndex {
  sessionsByWorktree: ReadonlyMap<string, readonly SessionMeta[]>
  sessionsByIssue: ReadonlyMap<string, readonly SessionMeta[]>
  sessionById: ReadonlyMap<string, SessionMeta>
}

function appendSession(map: Map<string, SessionMeta[]>, key: string, session: SessionMeta): void {
  const existing = map.get(key)
  if (existing) existing.push(session)
  else map.set(key, [session])
}

/**
 * Resolve cwd containment once per session, then reuse those memberships for
 * every issue and worktree row. This turns sidebar ownership derivation from
 * repeated issue × session × worktree scans into one session × worktree pass.
 */
export function indexSessionOwnership(
  sessions: readonly SessionMeta[],
  issues: readonly IssueWire[],
  allWorktreePaths: readonly string[],
): SessionOwnershipIndex {
  const roots = [
    ...new Set([
      ...allWorktreePaths,
      ...issues.flatMap((issue) => (issue.worktreePath ? [issue.worktreePath] : [])),
    ]),
  ]
  const issuesByWorktree = new Map<string, IssueWire[]>()
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || !issue.worktreePath) continue
    const existing = issuesByWorktree.get(issue.worktreePath)
    if (existing) existing.push(issue)
    else issuesByWorktree.set(issue.worktreePath, [issue])
  }
  const sessionsByWorktree = new Map<string, SessionMeta[]>()
  const sessionsByIssue = new Map<string, SessionMeta[]>()
  const sessionById = new Map<string, SessionMeta>()
  for (const session of sessions) {
    if (session.archived || isHeadlessSession(session)) continue
    sessionById.set(session.sessionId, session)
    const worktreePath = worktreeForCwd(session.cwd, roots)
    if (worktreePath) appendSession(sessionsByWorktree, worktreePath, session)
    if (session.issueId !== undefined) {
      appendSession(sessionsByIssue, session.issueId, session)
      continue
    }
    if (!worktreePath) continue
    for (const issue of issuesByWorktree.get(worktreePath) ?? []) {
      appendSession(sessionsByIssue, issue.id, session)
    }
  }
  return { sessionsByWorktree, sessionsByIssue, sessionById }
}

/** Sessions shown in a worktree's tab strip / sidebar — archived ones stay out.
 *  With `allWorktreePaths`, membership is by CONTAINMENT (worktreeForCwd), so a
 *  session whose stamped cwd is a subdirectory of the worktree still shows in it
 *  instead of vanishing from every group. Without it, legacy exact-match. */
export function sessionsForWorktree(
  sessions: SessionMeta[],
  worktreePath: string,
  allWorktreePaths?: string[],
  ownership?: SessionOwnershipIndex,
): SessionMeta[] {
  if (allWorktreePaths && ownership) {
    return [...(ownership.sessionsByWorktree.get(worktreePath) ?? [])]
  }
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
  /** Shared ownership work for this exact repo/session/issue snapshot. */
  sessionOwnership?: SessionOwnershipIndex
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
  sessionId: string,
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

/** A consumed child: its work is done (exited) — nothing left to watch. */
export function isConsumedChild(s: SessionMeta): boolean {
  return s.status === 'exited'
}

/** Live native (in-process Task) subagent count on a session, or 0 if absent. */
export function nativeSubagentCountOf(s: SessionMeta): number {
  return s.agentState?.nativeSubagentCount ?? 0
}

/** True when the session currently has one or more native subagents running. */
export function sessionHasNativeSubagents(s: SessionMeta): boolean {
  return nativeSubagentCountOf(s) > 0
}

/**
 * Sidebar label for a nested native-subagent indicator under a parent session
 * (count-only — named per-subagent identity is a separate deferred stream).
 */
export function nativeSubagentLabel(count: number): string {
  if (count <= 0) return ''
  return count === 1 ? '1 subagent' : `${count} subagents`
}

/**
 * Human-facing issue linkage for a session row: prefer the permanent birth
 * `displayRef` (e.g. `POD-13-A`), fall back to raw `issueId` when present.
 * Null when the session carries no issue attachment data.
 */
export function sessionIssueLinkage(s: SessionMeta): string | null {
  const ref = s.displayRef?.trim()
  if (ref) return ref
  const id = s.issueId?.trim()
  return id || null
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
      const parent = byId.get(pid)
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
  ownership?: SessionOwnershipIndex,
): SessionMeta[] {
  if (ownership) {
    const members = ownership.sessionsByIssue.get(issue.id) ?? []
    return opts.includeShells ? [...members] : members.filter((s) => s.agentKind !== 'shell')
  }
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

/** True while a session is still a blank vessel: no user-set name, and its
 *  terminal title is only boot noise — empty, the harness's own name ("Claude
 *  Code", "codex"), or the cwd basename (codex seeds the title with the
 *  directory). Nothing has been asked of it yet, so surfaces label it as a new
 *  session instead of parroting the harness name. */
export function isUnstartedSession(s: SessionMeta): boolean {
  if (s.name?.trim()) return false
  const title = s.title
    .replace(/^[\p{So}\p{Sk}·•\s]+/u, '')
    .trim()
    .toLowerCase()
  if (!title) return true
  const boot = [panelLabel(s.agentKind).toLowerCase(), s.agentKind, 'claude code']
  const cwdBase = s.cwd.split('/').filter(Boolean).at(-1)?.toLowerCase()
  return boot.includes(title) || title === cwdBase
}

/** Row label for a DRAFT issue (placeholder-titled vessel): the attached session's
 *  display name; a still-unstarted session reads "New <kind> session" so a blank
 *  vessel is unmistakable. Mirrors sessionDisplayName's name-beats-title rule
 *  (WorkerLabel imports from this module, so the tiny normalize step is inlined
 *  here rather than imported — no cycle). */
export function draftIssueLabel(
  issue: IssueWire,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): string {
  const first = sessionsForIssueNav(issue, sessions, allWorktreePaths)[0]
  if (!first) return 'New agent'
  if (isUnstartedSession(first)) return `New ${panelLabel(first.agentKind)} session`
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

/** One issue row in the unified WORK LIST. Optional `startedByChildren` holds
 *  top-level agent-started issues nested under this one via `startedBySession`
 *  (M6 started-by tree — not a formal parentId edge). */
export type UnifiedIssueRow = {
  kind: 'issue'
  issue: IssueWire
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
 * After the flat pass, top-level agent-started issues nest under the starter
 * session's issue via {@link nestStartedByIssues} (M6 started-by tree).
 */
const SIDEBAR_FINISHED_GRACE_MS = 24 * 60 * 60 * 1000
/** How long an UNREAD finished issue stays visible waiting for acknowledgment.
 *  Bounded so the historical population of never-read done issues (readAt did
 *  not always exist) cannot resurface forever with an unread badge. */
const SIDEBAR_FINISHED_UNREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** When the issue finished: closedAt when stamped (stable — moves only on
 *  closed-predicate flips), else updatedAt for legacy rows. [spec:SP-6144] */
function issueFinishedAt(issue: IssueWire): number {
  return Date.parse(issue.closedAt ?? issue.updatedAt) || 0
}

/** Acknowledgment-gated completion decay for the live sidebar. [spec:SP-6144] */
export function issueVisibleInSidebar(issue: IssueWire, now: number): boolean {
  const finished = issue.stage === 'done' || issue.closedReason != null
  if (!finished) return true
  const finishedAt = issueFinishedAt(issue)
  // Unread keeps a finished row visible only within 7 days of finishing —
  // beyond that it is history, not pending acknowledgment.
  if (issue.unread || !issue.readAt) {
    return now - finishedAt <= SIDEBAR_FINISHED_UNREAD_WINDOW_MS
  }
  const anchor = Math.max(finishedAt, Date.parse(issue.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}

export function sessionVisibleInSidebar(s: SessionMeta, now: number): boolean {
  const finishedAt =
    s.stoppedAt ?? (s.agentState?.phase === 'ended' ? s.agentState.since : undefined)
  if (!finishedAt) return true
  if (s.unread || !s.readAt) return true
  const anchor = Math.max(Date.parse(finishedAt) || 0, Date.parse(s.readAt) || 0)
  return now - anchor <= SIDEBAR_FINISHED_GRACE_MS
}

function buildUnifiedRows(
  sections: SidebarSections,
  issues: IssueWire[],
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
          sessionVisibleInSidebar(s, now),
        ),
        now,
      ),
      issue.coordinatorSessionId,
    )
    // Active work requires a session. Sessionless rows are allowed only for
    // finished MILESTONE CHILDREN (a parent to nest under) inside the unread →
    // 24h-grace decay window — a sessionless top-level done issue (or the
    // historical backlog of done issues, unread since before readAt existed)
    // must never resurface here. [spec:SP-6144]
    if (mine.length === 0) {
      const finished = issue.stage === 'done' || issue.closedReason != null
      if (!finished || !issue.parentId || issue.audience === 'agent') continue
      if (!issueVisibleInSidebar(issue, now)) continue
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
  return nestStartedByIssues(rows, sessions, allWorktreePaths, issues, now, ownership)
}

/**
 * Resolve which issue (among `issues`) owns `sessionId`: explicit `issueId`
 * first, else cwd containment via {@link sessionsForIssueNav}. Null when the
 * session or its issue is not in the given sets (sidebar fallback: top-level).
 */
export function issueIdOwningSession(
  sessionId: string,
  sessions: readonly SessionMeta[],
  issues: readonly IssueWire[],
  allWorktreePaths: string[],
  ownership?: SessionOwnershipIndex,
): string | null {
  if (ownership) {
    const indexed = ownership.sessionById.get(sessionId)
    if (!indexed) return null
    if (indexed.issueId !== undefined) {
      return issues.some(
        (issue) => issue.id === indexed.issueId && !issue.archived && !issue.deletedAt,
      )
        ? indexed.issueId
        : null
    }
    for (const issue of issues) {
      if (issue.archived || issue.deletedAt) continue
      if (
        ownership.sessionsByIssue.get(issue.id)?.some((member) => member.sessionId === sessionId)
      ) {
        return issue.id
      }
    }
    return null
  }
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session || session.archived || isHeadlessSession(session)) return null
  if (session.issueId !== undefined) {
    return issues.some((i) => i.id === session.issueId && !i.archived && !i.deletedAt)
      ? session.issueId
      : null
  }
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt) continue
    if (sessionsForIssueNav(issue, [session], allWorktreePaths).length > 0) return issue.id
  }
  return null
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
  const parentOf = new Map<string, string>()

  for (const row of issueRows) {
    const issue = row.issue
    // A formal tree edge always wins over provenance. Walk to the nearest visible
    // ancestor so a session-less internal bookkeeping node cannot orphan live work.
    let parentId = issue.parentId
    const seenParents = new Set<string>([issue.id])
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
      parentId =
        issueIdOwningSession(
          issue.startedBySession,
          sessions,
          visibleIssues,
          allWorktreePaths,
          ownership,
        ) ?? undefined
    }
    if (!parentId || parentId === issue.id || !byId.has(parentId)) continue
    let walk: string | undefined = parentId
    const cycle = new Set<string>([issue.id])
    while (walk && !cycle.has(walk)) {
      cycle.add(walk)
      walk = parentOf.get(walk)
    }
    if (walk) continue
    parentOf.set(issue.id, parentId)
  }

  const childrenOf = new Map<string, string[]>()
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
  issues: IssueWire[],
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
  /** WORKING rows/sessions, most-recently-active first. */
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
  working.sort((a, b) => workingEntryActivity(b) - workingEntryActivity(a))
  return { working, work: sortUnifiedWorkRows(work, now) }
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
 *
 * A parked process (hibernated/exited) cannot be working, however fresh the
 * preserved `working` phase — the header already says so, and the activity row
 * must not contradict it. Last-state *attention* labels are kept: a parked
 * "needs answer" is still true and worth surfacing. [spec:SP-8b0e]
 */
export function chatActivity(
  meta: SessionMeta | undefined,
  justSent: boolean,
): ChatActivity | null {
  if (!meta) return null
  const parked = meta.status === 'hibernated' || meta.status === 'exited'
  const badge = agentBadge(meta)
  if (badge?.tone === 'working' && !parked) {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  if (!meta.agentState && meta.busy && !parked) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}

// Four semantic status colours, identical across every surface (sidebar, tabs,
// work lists and chat) so a colour means the same thing everywhere:
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
 * Hibernated sessions KEEP their last *attention-worthy* status colour: the
 * server preserves `agentState` across a hibernate (the kill is the expected
 * result, so `onExit` leaves the phase intact), so a hibernated agent that
 * "needs input" still reads yellow. Hibernation is conveyed only by the
 * grayed/italic `.dot.parked` row, not by draining the dot to grey. The one
 * exception is `working`: a parked process cannot be working, however fresh
 * its preserved phase, so a hibernated "working" session reads ready (blue)
 * — matching `attentionGroup`, which already treats it as idle. [spec:SP-8b0e]
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
        return s.status === 'hibernated' ? 'ready' : 'working'
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
  if (
    sessions.length === 0 &&
    row.kind === 'issue' &&
    (row.issue.stage === 'done' || row.issue.closedReason != null)
  ) {
    return 'done'
  }
  return aggregateMotionPhase(sessions)
}

/** The same waiting > working > all-done > queued aggregation over any member
 *  session set — for squares fed by `issue.sessions` directly (#65 right rail). */
export function aggregateMotionPhase(sessions: SessionMeta[]): MotionPhase {
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
  // A draft vessel whose sessions were never prompted isn't "queued" work —
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
    const urgent = mostUrgentSession(
      sessions.filter((s) => motionPhase(s) === 'waiting'),
      now,
    )
    const label = urgent ? (agentBadge(urgent)?.label ?? 'needs you') : 'needs you'
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
  return head + 'queued' + progress
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
      return ['claude', '--resume', id].join(' ')
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
