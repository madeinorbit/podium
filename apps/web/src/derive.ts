import type { AgentKind, GitRepositoryWire, HostMetricsWire, SessionMeta } from '@podium/protocol'
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
  return repos
    .filter((r) => !linkedWorktreePaths.has(r.path))
    .map((r) => {
      const main: WorktreeView = {
        path: r.path,
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        repoPath: r.path,
        isMain: true,
      }
      const linked: WorktreeView[] = r.worktrees.map((w) => ({
        path: w.path,
        ...(w.branch !== undefined ? { branch: w.branch } : {}),
        repoPath: r.path,
        isMain: false,
      }))
      return { path: r.path, name: r.path.split('/').pop() || r.path, worktrees: [main, ...linked] }
    })
}

/** Sessions shown in a worktree's tab strip / sidebar — archived ones stay out. */
export function sessionsForWorktree(sessions: SessionMeta[], worktreePath: string): SessionMeta[] {
  return sessions.filter((s) => s.cwd === worktreePath && !s.archived)
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
  const orphans = sessionsForWorktree(opts.sessions, opts.selectedWorktree)
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

export function sidebarSections(
  repos: GitRepositoryWire[],
  sessions: SessionMeta[],
  pins: PinState,
  now: number = Date.now(),
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  // Pinned panels are ordered by agent state (same comparator as the repo
  // sections) rather than pin-insertion order, so the whole sidebar reads
  // consistently — needs-you first, working sunk to the bottom.
  const pinnedPanels = sortSessionsForSidebar(
    pins.panels
      .map((sessionId) => sessions.find((session) => session.sessionId === sessionId))
      .filter((session): session is SessionMeta => session !== undefined),
  )

  // A pinned panel still appears in its own repo/worktree list (it's not removed
  // from there) — pinning lifts a copy into PINNED PANELS for quick reach without
  // hiding it from its home. The selected highlight lights up in both places.
  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(sessionsForWorktree(sessions, worktree.path), now),
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
    if (s.archived) continue
    if (pinnedSessionIds.has(s.sessionId)) pinnedPanels.push(s)
    const group = attentionGroup(s)
    if (group === 'working') {
      working.push(s)
    } else if (isSnoozed(s, now)) {
    } else if (s.agentKind === 'shell') {
      // A shell sitting at its prompt isn't an agent blocked on you — it never
      // "needs your attention". (A shell running a command is `working` above.)
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
    if (!s.resume) {
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
  const hay = `${worktree.repoName} ${worktree.branch ?? ''} ${worktree.path}`.toLowerCase()
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
