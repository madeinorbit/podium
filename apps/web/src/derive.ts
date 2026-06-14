import type { AgentKind, GitRepositoryWire, HostMetricsWire, SessionMeta } from '@podium/protocol'
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
    case 'shell':
      return 'Shell'
    default: {
      const exhaustive: never = agentKind
      return exhaustive
    }
  }
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

export function sortSessionsForPins(sessions: SessionMeta[], pins: PinState): SessionMeta[] {
  const panelOrder = orderMap(pins.panels)
  return [...sessions].sort((left, right) =>
    comparePinned(left.sessionId, right.sessionId, panelOrder),
  )
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
): SidebarSections {
  const repoViews = reposToViews(repos)
  const pinnedPanelIds = new Set(pins.panels)
  const pinnedWorktreePaths = new Set(pins.worktrees)
  const pinnedRepoPaths = new Set(pins.repos)

  const allWorktrees = repoViews.flatMap((repo) =>
    repo.worktrees.map((worktree) => ({ repo, worktree })),
  )
  const pinnedPanels = pins.panels
    .map((sessionId) => sessions.find((session) => session.sessionId === sessionId))
    .filter((session): session is SessionMeta => session !== undefined)

  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForPins(
      sessionsForWorktree(sessions, worktree.path).filter(
        (session) => !pinnedPanelIds.has(session.sessionId),
      ),
      pins,
    ),
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
