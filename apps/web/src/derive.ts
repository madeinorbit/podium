import { normalizeOriginUrl } from '@podium/core'
import type {
  AgentKind,
  GitRepositoryWire,
  HostMetricsWire,
  IssueWire,
  MachineWire,
  SessionMeta,
} from '@podium/protocol'
import { cn } from '@/lib/utils'
import { attentionGroup, compareRecency } from './home'
import type { PinState, RepoView, WorktreeView } from './types'

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

  // Group by normalized origin URL so that the same repo cloned on multiple machines
  // collapses into one RepoView. Repos without a remote (empty normalizedOrigin) are
  // keyed by (machineId, path) so they stay separate — two unrelated local repos that
  // happen to have no remote must never be merged.
  const groups = new Map<string, GitRepositoryWire[]>()
  for (const r of candidates) {
    const origin = normalizeOriginUrl(r.originUrl)
    const key = origin !== '' ? origin : `__no_remote__:${r.machineId ?? ''}:${r.path}`
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
    const originUrl = normalizeOriginUrl(first.originUrl) || undefined

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
      }
      worktrees.push(main)
      for (const w of r.worktrees) {
        worktrees.push({
          path: w.path,
          ...(w.branch !== undefined ? { branch: w.branch } : {}),
          repoPath: r.path,
          isMain: false,
          ...(machineId !== undefined ? { machineId } : {}),
        })
      }
    }

    views.push({
      path: first.path,
      name: first.path.split('/').pop() || first.path,
      worktrees,
      machines,
      ...(originUrl !== undefined ? { originUrl } : {}),
    })
  }

  return views
}

/** Online machines that have this repo (intersection of repo.machines and online machines). */
export function machinesForRepo(repo: RepoView, machines: MachineWire[]): MachineWire[] {
  const repoMachineIds = new Set(repo.machines.map((m) => m.machineId))
  return machines.filter((m) => m.online && repoMachineIds.has(m.id))
}

/** The machineId of the most recently created session among the given machines;
 *  undefined if none of the sessions belong to those machines. */
export function lastUsedMachine(
  sessions: SessionMeta[],
  machines: MachineWire[],
): string | undefined {
  const machineIds = new Set(machines.map((m) => m.id))
  let best: SessionMeta | undefined
  for (const s of sessions) {
    if (s.machineId !== undefined && machineIds.has(s.machineId)) {
      if (best === undefined || s.createdAt > best.createdAt) {
        best = s
      }
    }
  }
  return best?.machineId
}

/** The recommended machine to open an agent on for this repo.
 *  Prefers the most-recently-used machine that also has the repo;
 *  falls back to the first online machine that has the repo; else undefined. */
export function resolveTargetMachine(
  repo: RepoView,
  sessions: SessionMeta[],
  machines: MachineWire[],
): string | undefined {
  const eligible = machinesForRepo(repo, machines)
  if (eligible.length === 0) return undefined
  const mru = lastUsedMachine(sessions, eligible)
  if (mru !== undefined) return mru
  return eligible[0]?.id
}

/** The worktree that CONTAINS `cwd`: the longest root with `cwd === root` or
 *  `cwd` under `root/`. Longest-match matters because a repo root contains its
 *  own `.worktrees/*` checkouts — a session in one belongs to the worktree, not
 *  the parent repo. Null when no root contains the cwd. */
export function worktreeForCwd(cwd: string, worktreePaths: string[]): string | null {
  let best: string | null = null
  for (const root of worktreePaths) {
    if (cwd !== root && !cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) continue
    if (best === null || root.length > best.length) best = root
  }
  return best
}

/**
 * A HEADLESS session (concierge unification): a superagent thread's harness
 * session with no PTY. It renders ONLY inside the superagent panel's embedded
 * ChatView (which is handed its sessionId explicitly) — every generic session
 * surface (tabs, sidebar, home board, work items, issue counts) must skip it.
 */
export function isHeadlessSession(s: SessionMeta): boolean {
  return s.headless === true
}

/** Drop headless sessions from a generic session enumeration. */
export function withoutHeadless(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.some(isHeadlessSession) ? sessions.filter((s) => !isHeadlessSession(s)) : sessions
}

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
}

export interface SidebarSections {
  pinnedPanels: SessionMeta[]
  pinnedWorktrees: WorktreeNavView[]
  pinnedRepos: RepoNavView[]
  repos: RepoNavView[]
}

export const EMPTY_PINS: PinState = { panels: [], worktrees: [], repos: [] }

/** Is the session snoozed *right now*? `undefined` snoozedUntil = never; `null`
 *  (until next message) = always; an ISO string = until that instant. */
export function isSnoozed(s: SessionMeta, now: number): boolean {
  if (s.snoozedUntil === undefined) return false
  if (s.snoozedUntil === null) return true
  return now < Date.parse(s.snoozedUntil)
}

/** Did a *timed* snooze just lapse — its deadline has passed but it hasn't been
 *  cleared yet (no message sent since)? The session has re-surfaced in NEEDS YOUR
 *  ATTENTION (and `compareRecency` lifts it by that deadline); the sidebar marks it
 *  so the user sees it's back. `null` (until-next-message) snoozes never expire by
 *  time, so they're never "returned" this way. */
export function returnedFromSnooze(s: SessionMeta, now: number): boolean {
  return typeof s.snoozedUntil === 'string' && Date.parse(s.snoozedUntil) <= now
}

/** ISO deadline one hour from `now`. */
export function snoozeUntil1h(now: number): string {
  return new Date(now + 3_600_000).toISOString()
}

/** ISO deadline at the next 5:00am local strictly after `now`. */
export function snoozeUntilTomorrow5am(now: number): string {
  const d = new Date(now)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.toISOString()
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

/**
 * Sort repos by the given mode:
 *  - alphabetical: locale, case-insensitive by name.
 *  - lastUsed: by lastUsedAt desc (unknown → 0 / end), tiebreak name.
 *  - custom: by index in `order`; ids not in `order` appended in lastUsed order.
 */
export function sortRepos<T extends { id: string; name: string }>(
  repos: T[],
  mode: 'alphabetical' | 'lastUsed' | 'custom',
  order: string[],
  lastUsedAt: Map<string, number>,
): T[] {
  const lu = (id: string): number => lastUsedAt.get(id) ?? 0

  if (mode === 'alphabetical') {
    return [...repos].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }

  if (mode === 'lastUsed') {
    return [...repos].sort((a, b) => {
      const diff = lu(b.id) - lu(a.id)
      if (diff !== 0) return diff
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  // custom: pinned order first, then remainder by lastUsed desc
  const position = orderMap(order)
  const inOrder = [...repos]
    .filter((r) => position.has(r.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
  const remainder = [...repos]
    .filter((r) => !position.has(r.id))
    .sort((a, b) => {
      const diff = lu(b.id) - lu(a.id)
      if (diff !== 0) return diff
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  return [...inOrder, ...remainder]
}

/**
 * Collapse duplicate session rows that point at the SAME underlying agent
 * conversation (same resume ref) — e.g. a Codex thread that surfaced twice on
 * resume. Keeps the most useful row per ref (live > starting/reconnecting >
 * hibernated > exited; ties break to the most-recently-active) and preserves
 * order. Sessions with no resume ref are distinct and never merged.
 */
export function dedupeSessionsByResume(sessions: SessionMeta[]): SessionMeta[] {
  const rank = (s: SessionMeta): number => {
    switch (s.status) {
      case 'live':
        return 3
      case 'starting':
      case 'reconnecting':
        return 2
      case 'hibernated':
        return 1
      default:
        return 0 // exited
    }
  }
  const better = (a: SessionMeta, b: SessionMeta): SessionMeta => {
    if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b
    return a.lastActiveAt >= b.lastActiveAt ? a : b
  }
  const indexByRef = new Map<string, number>()
  const out: SessionMeta[] = []
  for (const s of sessions) {
    // A headless session shares its resume ref with its "open in terminal" PTY
    // twin by design (same harness conversation) — never collapse the two rows.
    if (!s.resume || isHeadlessSession(s)) {
      out.push(s)
      continue
    }
    const key = `${s.resume.kind}:${s.resume.value}`
    const at = indexByRef.get(key)
    const existing = at === undefined ? undefined : out[at]
    if (at === undefined || existing === undefined) {
      indexByRef.set(key, out.length)
      out.push(s)
    } else {
      out[at] = better(existing, s)
    }
  }
  return out
}

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

/**
 * Order the worktrees within a repo by the sidebar's sort mode. The mode is the
 * same one that orders repos; without it a one-repo, many-worktree setup sees no
 * effect from the control. There's no per-worktree manual order, so `custom`
 * falls back to recency like `lastUsed`. Recency ties (and worktrees with no
 * sessions) break toward the main worktree, then branch name.
 */
export function sortWorktrees(
  worktrees: WorktreeNavView[],
  mode: 'alphabetical' | 'lastUsed' | 'custom',
  lastUsedByWorktree: Map<string, number>,
): WorktreeNavView[] {
  const name = (w: WorktreeNavView): string => w.branch ?? w.path.split('/').pop() ?? w.path
  if (mode === 'alphabetical') {
    return [...worktrees].sort((a, b) =>
      name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }),
    )
  }
  const lu = (w: WorktreeNavView): number => lastUsedByWorktree.get(w.path) ?? 0
  return [...worktrees].sort((a, b) => {
    const diff = lu(b) - lu(a)
    if (diff !== 0) return diff
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return name(a).localeCompare(name(b), undefined, { sensitivity: 'base' })
  })
}

/** Does a worktree row match the inline sidebar filter (case-insensitive over
 *  branch / path / repo name)? */
function worktreeMatches(worktree: WorktreeNavView, q: string): boolean {
  const titles = worktree.issues.map((i) => i.title).join(' ')
  const hay =
    `${worktree.repoName} ${worktree.branch ?? ''} ${worktree.path} ${titles}`.toLowerCase()
  return hay.includes(q)
}

/**
 * Inline client-side filter for the repos/worktrees tree (the small Input next to
 * the WORKTREES header). Case-insensitive substring over repo name / branch /
 * path; an empty query passes everything through unchanged. A repo is kept when
 * its own name matches (then all its worktrees show) OR when it has any matching
 * worktree (then only the matching worktrees show). Pinned panels are not touched
 * — they're a flat reach-list, not part of the tree being filtered.
 */
export function filterSidebarSections(sections: SidebarSections, query: string): SidebarSections {
  const q = query.trim().toLowerCase()
  if (!q) return sections

  const filterWorktrees = (worktrees: WorktreeNavView[]): WorktreeNavView[] =>
    worktrees.filter((w) => worktreeMatches(w, q))

  const filterRepo = (repo: RepoNavView): RepoNavView | null => {
    if (repo.name.toLowerCase().includes(q)) return repo
    const worktrees = filterWorktrees(repo.worktrees)
    return worktrees.length > 0 ? { ...repo, worktrees } : null
  }

  return {
    pinnedPanels: sections.pinnedPanels,
    pinnedWorktrees: filterWorktrees(sections.pinnedWorktrees),
    pinnedRepos: sections.pinnedRepos
      .map(filterRepo)
      .filter((repo): repo is RepoNavView => repo !== null),
    repos: sections.repos.map(filterRepo).filter((repo): repo is RepoNavView => repo !== null),
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
    .filter((i) => !i.archived)
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
export function spawnTargetForRepo(repo: RepoNavView): {
  worktree: WorktreeView
  repoName: string
} {
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
      worktree: { path: repo.path, repoPath: repo.path, isMain: true },
      repoName: repo.name,
    }
  }
  const { repoName: _repoName, sessions: _sessions, issues: _issues, ...view } = chosen
  return { worktree: view, repoName: repo.name }
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

const rowRank = (sessions: SessionMeta[], now: number): number =>
  sessions.reduce((min, s) => Math.min(min, sessionUrgencyRank(s, now)), UNIFIED_ROW_EMPTY_RANK)

/**
 * The unified WORK LIST — one flat list, ordered by aggregated status instead of
 * separate NEEDS-ATTENTION/WORKING sections. Contents:
 *   - non-archived human-origin issues that are ACTIVE — attached sessions, or a
 *     worktree, or a stage that isn't backlog/done (the whole backlog stays out);
 *   - draft issues with sessions (the "new agent" vessels);
 *   - nav worktrees owned by no issue that have at least one (non-shell) session.
 * Order: rank asc (min child session urgency; session-less rows sink), then
 * most-recent child activity desc, then issue.updatedAt desc.
 */
export function unifiedWorkList(
  sections: SidebarSections,
  issues: IssueWire[],
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  now: number = Date.now(),
): UnifiedWorkRow[] {
  const rows: UnifiedWorkRow[] = []
  for (const issue of issues) {
    if (issue.archived) continue
    const mine = sortSessionsForSidebar(sessionsForIssueNav(issue, sessions, allWorktreePaths), now)
    const active =
      mine.length > 0 ||
      issue.worktreePath !== null ||
      (issue.stage !== 'backlog' && issue.stage !== 'done')
    const wanted = issue.draft ? mine.length > 0 : issue.origin === 'human' && active
    if (!wanted) continue
    const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
    rows.push({
      kind: 'issue',
      issue,
      sessions: mine,
      activityAt: lastSession || Date.parse(issue.updatedAt) || 0,
      rank: rowRank(mine, now),
    })
  }
  // Worktrees not owned by ANY non-archived issue (navWorktree already attaches
  // owning issues per worktree — a non-empty list means an issue row covers it).
  // Session-less worktrees stay out: the unified list is work, not a repo tree.
  // Sessions ATTACHED to a live issue already appear under that issue's row, so
  // they don't count toward (or render in) a worktree row — an agent-created
  // worktree whose issue never stamped worktreePath must not show up twice.
  const liveIssueIds = new Set(issues.filter((i) => !i.archived).map((i) => i.id))
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
  return rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.activityAt !== b.activityAt) return b.activityAt - a.activityAt
    const au = a.kind === 'issue' ? Date.parse(a.issue.updatedAt) || 0 : 0
    const bu = b.kind === 'issue' ? Date.parse(b.issue.updatedAt) || 0 : 0
    return bu - au
  })
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

// Tone → theme-independent hue. NOT the `bg-primary`/`bg-success` design tokens:
// `bg-primary` is near-black in the light theme, so an explicit blue keeps the
// status colours identical across themes and modes (matching the minimap palette).
const DOT_TONE_CLASS: Record<DotTone, string> = {
  working: 'bg-emerald-500',
  attention: 'bg-amber-500',
  error: 'bg-red-500',
  ready: 'bg-blue-500',
  neutral: 'bg-muted-foreground',
}

/**
 * Full className for a session's status dot: the tone hue plus a `parked` marker
 * for hibernated sessions. The marker drives the grayed/italic row look in CSS
 * (`.dot.parked + .worker-label`), independent of the dot colour. A live working
 * (green) dot also gets `dot-working` for the breathing-glow animation — but a
 * hibernated dot stays calm (no animation) even if its last tone was working.
 */
export function sessionDotClass(s: SessionMeta): string {
  const tone = sessionDotTone(s)
  const parked = s.status === 'hibernated'
  return cn(
    'dot inline-block size-2 min-w-2 flex-none rounded-full',
    DOT_TONE_CLASS[tone],
    parked && 'parked',
    tone === 'working' && !parked && 'dot-working',
  )
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
